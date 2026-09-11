import type { ZodType } from 'zod'
import type { ActionsConfig } from '../supabaseRest.js'
import { sbWrite } from '../supabaseRest.js'
import { hasAtLeastAdmin, type AdminRole } from './adminAuth.js'

// The admin console has no generic row editor, deliberately. A raw
// "UPDATE any table" surface cannot be constrained and audits as SQL; a fixed
// catalog of named operations can only do what each operation permits and
// audits as an operation name, which is what someone actually searches for
// months later.
//
// THE DISPATCHER WRITES THE AUDIT ROW, NOT THE OPERATIONS. That is the whole
// reason this indirection exists: a new operation cannot forget to log, and
// denied and errored attempts are logged by the same wrapper that logs
// successes. Do not move audit writes into individual operations.

// Thrown by an operation that wants a specific HTTP status and a message the
// client may safely see. Everything else that throws becomes a 500 whose
// detail stays in the audit row -- Postgres error text can carry column names
// and row values belonging to other tenants.
export class AdminOpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly clientMessage: string = message
  ) {
    super(message)
    this.name = 'AdminOpError'
  }
}

export interface AdminCtx {
  config: ActionsConfig
  adminId: string
  adminRole: AdminRole
  // Correlates the client's error response, the audit row, and Sentry.
  requestId: string
}

export interface AdminOperation<I> {
  name: string
  minRole: AdminRole
  input: ZodType<I>
  /** What the audit row records as the thing acted upon. */
  target: (input: I) => unknown
  /** Dry run. Must never write data. */
  preview: (ctx: AdminCtx, input: I) => Promise<unknown>
  apply: (ctx: AdminCtx, input: I) => Promise<{ before: unknown; after: unknown }>
}

// Identity helper that pins the generic so each operation's input type is
// inferred from its schema instead of widening to any at the registry.
export function defineOperation<I>(op: AdminOperation<I>): AdminOperation<I> {
  return op
}

export function createRegistry(ops: AdminOperation<any>[]): Map<string, AdminOperation<any>> {
  const map = new Map<string, AdminOperation<any>>()
  for (const op of ops) {
    if (map.has(op.name)) throw new Error(`duplicate admin operation: ${op.name}`)
    map.set(op.name, op)
  }
  return map
}

async function audit(
  ctx: AdminCtx,
  row: {
    operation: string
    target: unknown
    result: 'ok' | 'denied' | 'error'
    before?: unknown
    after?: unknown
    error?: string
  }
): Promise<void> {
  // An audit write must never mask the outcome it is recording: if logging
  // fails, the operation's own result still reaches the caller. The throw is
  // swallowed here and surfaced by the caller's onError hook instead.
  try {
    await sbWrite(ctx.config, 'POST', '/admin_audit_log', {
      admin_id: ctx.adminId,
      admin_role: ctx.adminRole,
      operation: row.operation,
      target: row.target ?? {},
      before: row.before ?? null,
      after: row.after ?? null,
      result: row.result,
      error: row.error ?? null,
      request_id: ctx.requestId,
    })
  } catch {
    // Intentionally empty -- see above.
  }
}

export async function dispatchOperation(
  registry: Map<string, AdminOperation<any>>,
  ctx: AdminCtx,
  name: string,
  mode: 'preview' | 'apply',
  rawInput: unknown
): Promise<{ status: number; body: unknown }> {
  const op = registry.get(name)
  // An unknown name is not an attempt at anything auditable -- there is no
  // operation and no target to record.
  if (!op) return { status: 404, body: { error: `unknown operation: ${name}` } }

  // The role gate covers preview as well as apply. A readonly admin must not
  // be able to enumerate what a mutation WOULD do to a given row.
  if (!hasAtLeastAdmin(ctx.adminRole, op.minRole)) {
    await audit(ctx, {
      operation: op.name,
      target: { raw: rawInput },
      result: 'denied',
      error: `role ${ctx.adminRole} is below required ${op.minRole}`,
    })
    return { status: 403, body: { error: 'insufficient admin role' } }
  }

  const parsed = op.input.safeParse(rawInput)
  if (!parsed.success) {
    await audit(ctx, {
      operation: op.name,
      target: { raw: rawInput },
      result: 'denied',
      error: `invalid input: ${parsed.error.message}`,
    })
    return { status: 400, body: { error: 'invalid input', detail: parsed.error.format() } }
  }
  const input = parsed.data

  try {
    if (mode === 'preview') {
      // No audit row: a preview changes nothing, and logging every keystroke
      // of a form would bury the rows that record real changes.
      return { status: 200, body: { mode: 'preview', preview: await op.preview(ctx, input) } }
    }
    const { before, after } = await op.apply(ctx, input)
    await audit(ctx, { operation: op.name, target: op.target(input), result: 'ok', before, after })
    return { status: 200, body: { mode: 'apply', before, after } }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)

    if (err instanceof AdminOpError) {
      // A sub-500 AdminOpError is a refusal, not a malfunction: the operation
      // decided this input may not proceed, which is the same category as a
      // role or schema rejection above.
      await audit(ctx, {
        operation: op.name,
        target: op.target(input),
        result: err.status < 500 ? 'denied' : 'error',
        error: detail,
      })
      return {
        status: err.status,
        body: { error: err.clientMessage, request_id: ctx.requestId },
      }
    }

    await audit(ctx, {
      operation: op.name,
      target: op.target(input),
      result: 'error',
      error: detail,
    })
    // The detail stays in the audit row and Sentry; the client gets the
    // request id to quote instead. Postgres error text can carry column names
    // and row values from other tenants.
    return {
      status: 500,
      body: { error: 'operation failed', request_id: ctx.requestId },
    }
  }
}
