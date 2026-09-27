import { sbGet, sbWrite } from '../supabaseRest.js'
import type { AdminCtx } from './operations.js'

// The read half of /api/admin/*. Every route here requires only the readonly
// role, which the caller has already checked -- these routes are why the
// readonly role exists at all.
//
// Returns null when `segments` names no read route, so the caller can fall
// through to the operation dispatcher.

const AUDIT_PAGE_MAX = 200
const ORGS_PAGE_MAX = 200
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function handleAdminRead(
  ctx: AdminCtx,
  segments: string[],
  url: URL
): Promise<{ status: number; body: unknown } | null> {
  const [head, param] = segments

  if (head === 'search') {
    const q = (url.searchParams.get('q') ?? '').trim()
    // An empty query would ILIKE '%%' and return the first 25 of everything,
    // which reads as a result set rather than as "you typed nothing".
    if (q.length < 2) {
      return { status: 400, body: { error: 'q must be at least 2 characters' } }
    }
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_search', { p_q: q }),
    }
  }

  if (head === 'user' && param) {
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_user_detail', { p_user_id: param }),
    }
  }

  if (head === 'org' && param) {
    const orgId = Number(param)
    if (!Number.isInteger(orgId) || orgId <= 0) {
      return { status: 400, body: { error: 'org id must be a positive integer' } }
    }
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_org_detail', { p_org_id: orgId }),
    }
  }

  if (head === 'flags') {
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_flags', {}),
    }
  }

  if (head === 'orgs') {
    // Same clamp recipe as the audit route: out-of-range and unparsable
    // limits land inside 1..200 rather than trusting the client.
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), ORGS_PAGE_MAX)
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_list_organizations', {
        p_q: url.searchParams.get('q'),
        p_sort: url.searchParams.get('sort'),
        p_dir: url.searchParams.get('dir'),
        p_limit: limit,
        p_offset: offset,
      }),
    }
  }

  if (head === 'dashboard') {
    // Dates are validated here because a malformed range is a client bug;
    // grain is not, because the RPC's whitelist is the authority and its
    // raise is the accepted error path.
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from !== null && !ISO_DATE.test(from)) {
      return { status: 400, body: { error: 'from must be YYYY-MM-DD' } }
    }
    if (to !== null && !ISO_DATE.test(to)) {
      return { status: 400, body: { error: 'to must be YYYY-MM-DD' } }
    }
    return {
      status: 200,
      body: await sbWrite(ctx.config, 'POST', '/rpc/admin_dashboard', {
        p_from: from,
        p_to: to,
        p_grain: url.searchParams.get('grain'),
      }),
    }
  }

  if (head === 'audit') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), AUDIT_PAGE_MAX)
    // Keyset pagination on the identity primary key: the log is append-only,
    // so an id cursor is stable in a way an offset is not.
    const cursor = url.searchParams.get('cursor')
    const operation = url.searchParams.get('operation')
    const filters = [
      cursor ? `&id=lt.${encodeURIComponent(cursor)}` : '',
      operation ? `&operation=eq.${encodeURIComponent(operation)}` : '',
    ].join('')
    const rows = await sbGet(
      ctx.config,
      `/admin_audit_log?select=*&order=id.desc&limit=${limit}${filters}`
    )
    const next = rows.length === limit ? String(rows[rows.length - 1].id) : null
    return { status: 200, body: { rows, next_cursor: next } }
  }

  return null
}
