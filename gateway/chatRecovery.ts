// Chat action recovery mechanics for the AI-chat write tools: every
// successful chat write is recorded as a receipt row in chat_actions
// (recordChatAction), and undo replays the inverse of exactly the rows the
// receipt snapshotted (computeInverseAction + executeRollback), so the
// frontend can offer a reliable Undo and the agent a rollback_last_action
// tool. Supabase's REST API has no multi-statement transactions, so undo
// approximates atomicity with a compare-and-swap on the receipt's status:
// the PATCH that flips status applied -> 'undoing' is filtered
// `status=eq.applied`, so a concurrent undo (or one arriving after the
// first finished) matches zero rows and fails instead of replaying the
// inverse twice. The CAS winner then verifies the affected rows still match
// the after_rows snapshot, executes the inverse ops, and PATCHes status ->
// 'undone' with undone_at. Any failure after the CAS wins reverts status
// back to 'applied' (best effort) before rethrowing, so a crashed undo never
// strands a receipt in 'undoing' while a retry should stay possible.
// computeInverseAction is deliberately pure (no fetch, no config) so it is
// testable without mocks and reusable by the agent layer. The before_rows /
// after_rows shapes per action type are pinned by chatRecovery.test.mjs;
// the snapshot code in gameActions.ts must produce exactly those shapes.

import { type ActionsConfig, sbGet, sbWrite } from './supabaseRest.js'

export type { ActionsConfig }

export interface ChatActionSnapshot {
  action_type: string
  before_rows?: Record<string, any> | null
  after_rows?: Record<string, any> | null
}

export interface InverseOp {
  method: 'POST' | 'DELETE'
  path: string
  body?: unknown
}

export interface ChatActionReceipt {
  id: string
  request_id: string
  description: string
  status: string
}

export interface RecordChatActionParams {
  sessionId: string
  userId: string
  requestId: string
  actionType: string
  description: string
  beforeRows: Record<string, unknown>
  afterRows: Record<string, unknown>
}

type ChatActionRow = ChatActionSnapshot & {
  id: string
  status: string
  [key: string]: any
}

const enc = encodeURIComponent

export function computeInverseAction(action: ChatActionSnapshot): InverseOp[] {
  const before = action.before_rows ?? {}
  const after = action.after_rows ?? {}
  switch (action.action_type) {
    case 'create_game_event': {
      const event = after.event as { id: number | string } | undefined
      if (event?.id == null) throw new Error('cannot invert create_game_event: after_rows.event.id is missing')
      return [{ method: 'DELETE', path: `/game_events?id=eq.${event.id}` }]
    }
    case 'undo_last_event': {
      const event = before.event as Record<string, unknown> | undefined
      if (event?.id == null) throw new Error('cannot invert undo_last_event: before_rows.event.id is missing')
      return [{ method: 'POST', path: '/game_events', body: event }]
    }
    case 'remove_from_lineup': {
      const rows = (before.removed_rows ?? []) as Record<string, unknown>[]
      if (rows.length === 0) throw new Error('cannot invert remove_from_lineup: before_rows.removed_rows is empty')
      return [{ method: 'POST', path: '/game_lineups', body: rows }]
    }
    case 'create_lineup_group': {
      const group = after.group as { id: number | string } | undefined
      if (group?.id == null) throw new Error('cannot invert create_lineup_group: after_rows.group.id is missing')
      return [{ method: 'DELETE', path: `/game_lineup_groups?id=eq.${group.id}` }]
    }
    case 'add_to_lineup': {
      const current = after.lineup_row as { game_id: number; player_id: number } | undefined
      if (current?.game_id == null || current?.player_id == null) {
        throw new Error('cannot invert add_to_lineup: after_rows.lineup_row is missing')
      }
      const ops: InverseOp[] = [
        { method: 'DELETE', path: `/game_lineups?game_id=eq.${current.game_id}&player_id=eq.${current.player_id}` },
      ]
      const prior = (before.lineup_rows ?? []) as Record<string, unknown>[]
      if (prior.length > 0) ops.push({ method: 'POST', path: '/game_lineups', body: prior })
      const group = after.group as { id: number | string } | null | undefined
      if (group?.id != null) ops.push({ method: 'DELETE', path: `/game_lineup_groups?id=eq.${group.id}` })
      const seasonPlayer = after.season_player as { id: number | string } | null | undefined
      if (seasonPlayer?.id != null) ops.push({ method: 'DELETE', path: `/season_players?id=eq.${seasonPlayer.id}` })
      return ops
    }
    case 'create_lineup':
    case 'apply_lineup_template': {
      const gameId = (before.game_id ?? after.game_id) as number | null | undefined
      if (gameId == null) throw new Error(`cannot invert ${action.action_type}: before_rows.game_id is missing`)
      const ops: InverseOp[] = [
        { method: 'DELETE', path: `/game_lineups?game_id=eq.${gameId}` },
        { method: 'DELETE', path: `/game_lineup_groups?game_id=eq.${gameId}` },
      ]
      const groups = (before.groups ?? []) as Record<string, unknown>[]
      if (groups.length > 0) {
        ops.push({ method: 'POST', path: '/game_lineup_groups', body: groups.map(g => ({ ...g, game_id: gameId })) })
      }
      const players = (before.players ?? []) as Record<string, unknown>[]
      if (players.length > 0) {
        ops.push({ method: 'POST', path: '/game_lineups', body: players.map(p => ({ ...p, game_id: gameId })) })
      }
      for (const sp of (after.new_season_players ?? []) as { id?: number | string; season_id?: number; player_id?: number }[]) {
        if (sp.id != null) ops.push({ method: 'DELETE', path: `/season_players?id=eq.${sp.id}` })
        else if (sp.season_id != null && sp.player_id != null) {
          ops.push({ method: 'DELETE', path: `/season_players?season_id=eq.${sp.season_id}&player_id=eq.${sp.player_id}` })
        }
      }
      return ops
    }
    case 'save_lineup_template': {
      const saved = after.template as { id: number | string } | undefined
      const previous = before.template as { id: number | string } | null | undefined
      if (saved?.id == null) throw new Error('cannot invert save_lineup_template: after_rows.template.id is missing')
      const ops: InverseOp[] = [
        { method: 'DELETE', path: `/lineup_template_players?template_id=eq.${saved.id}` },
        { method: 'DELETE', path: `/lineup_template_groups?template_id=eq.${saved.id}` },
      ]
      if (previous == null) {
        ops.push({ method: 'DELETE', path: `/lineup_templates?id=eq.${saved.id}` })
        return ops
      }
      const groups = (before.groups ?? []) as Record<string, unknown>[]
      if (groups.length > 0) {
        ops.push({ method: 'POST', path: '/lineup_template_groups', body: groups.map(g => ({ ...g, template_id: previous.id })) })
      }
      const players = (before.players ?? []) as Record<string, unknown>[]
      if (players.length > 0) {
        ops.push({ method: 'POST', path: '/lineup_template_players', body: players.map(p => ({ ...p, template_id: previous.id })) })
      }
      return ops
    }
    default:
      throw new Error(`cannot invert unknown action type: ${action.action_type}`)
  }
}

const MISMATCH = 'action cannot be undone: the affected data has changed'

// Single rows the action created (or, for a template, upserted), keyed by
// where they live in after_rows. Each is id-addressable, so undo verifies it
// by fetching the exact id and comparing every snapshotted field.
const CREATED_ROW_TABLES: Record<string, string> = {
  event: '/game_events',
  lineup_row: '/game_lineups',
  group: '/game_lineup_groups',
  season_player: '/season_players',
  template: '/lineup_templates',
}

async function verifyRowsMatchSnapshot(config: ActionsConfig, path: string, snapshots: Record<string, any>[]): Promise<void> {
  const current = await sbGet(config, path)
  if (!Array.isArray(current) || current.length !== snapshots.length) throw new Error(MISMATCH)
  const byId = new Map(current.map((r: any) => [String(r.id), r]))
  for (const snap of snapshots) {
    const row = byId.get(String(snap.id))
    if (!row) throw new Error(MISMATCH)
    for (const [k, v] of Object.entries(snap)) {
      if (JSON.stringify(row[k]) !== JSON.stringify(v)) throw new Error(MISMATCH)
    }
  }
}

async function verifyAffectedRowsUnchanged(config: ActionsConfig, action: ChatActionRow): Promise<void> {
  const after = action.after_rows ?? {}
  for (const [key, table] of Object.entries(CREATED_ROW_TABLES)) {
    const snap = after[key] as Record<string, any> | null | undefined
    if (!snap || snap.id == null) continue
    await verifyRowsMatchSnapshot(config, `${table}?id=eq.${snap.id}&select=*`, [snap])
  }
  const gameId = after.game_id
  if (Array.isArray(after.lineup_rows) && gameId != null) {
    await verifyRowsMatchSnapshot(config, `/game_lineups?game_id=eq.${gameId}&select=*`, after.lineup_rows)
  }
  if (Array.isArray(after.group_rows) && gameId != null) {
    await verifyRowsMatchSnapshot(config, `/game_lineup_groups?game_id=eq.${gameId}&select=*`, after.group_rows)
  }
  // create_lineup_group's group starts empty: a lineup row referencing it
  // means someone depended on it after the fact, and undo must reject rather
  // than strand that reference (game_lineups.lineup_name is text, not an FK,
  // so the database would not stop the delete).
  if (action.action_type === 'create_lineup_group' && after.group?.game_id != null && after.group?.lineup_name != null) {
    const deps = await sbGet(config, `/game_lineups?game_id=eq.${after.group.game_id}&lineup_name=eq.${enc(after.group.lineup_name)}&select=*`)
    if (Array.isArray(deps) && deps.length > 0) throw new Error(MISMATCH)
  }
}

export async function recordChatAction(config: ActionsConfig, orgId: number, params: RecordChatActionParams): Promise<ChatActionReceipt> {
  const rows = await sbWrite(config, 'POST', '/chat_actions', {
    organization_id: orgId,
    session_id: params.sessionId,
    user_id: params.userId,
    request_id: params.requestId,
    action_type: params.actionType,
    description: params.description,
    before_rows: params.beforeRows,
    after_rows: params.afterRows,
  })
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('chat action insert returned no row')
  const row = rows[0]
  return { id: row.id, request_id: row.request_id, description: row.description, status: row.status }
}

export async function findLatestActionToRollback(config: ActionsConfig, orgId: number, sessionId: string, userId: string): Promise<ChatActionRow | null> {
  const rows: ChatActionRow[] = await sbGet(
    config,
    `/chat_actions?organization_id=eq.${orgId}&session_id=eq.${enc(sessionId)}&user_id=eq.${enc(userId)}&status=eq.applied&order=created_at.desc&limit=1`,
  )
  if (!Array.isArray(rows) || rows.length === 0) return null
  return rows[0]
}

export async function executeRollback(
  config: ActionsConfig,
  orgId: number,
  actionId: string,
  userId: string,
): Promise<{ id: string; status: 'undone' }> {
  const rows: ChatActionRow[] = await sbGet(
    config,
    `/chat_actions?id=eq.${enc(actionId)}&organization_id=eq.${orgId}&user_id=eq.${enc(userId)}&select=*`,
  )
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('action not found')
  const action = rows[0]
  if (action.status !== 'applied') throw new Error('action is not in applied state')

  const claimed = await sbWrite(config, 'PATCH', `/chat_actions?id=eq.${enc(actionId)}&status=eq.applied`, { status: 'undoing' })
  if (!Array.isArray(claimed) || claimed.length === 0) throw new Error('action is not in applied state')

  try {
    await verifyAffectedRowsUnchanged(config, action)
    const ops = computeInverseAction(action)
    for (const op of ops) await sbWrite(config, op.method, op.path, op.body)
  } catch (err) {
    try {
      await sbWrite(config, 'PATCH', `/chat_actions?id=eq.${enc(actionId)}`, { status: 'applied' })
    } catch {}
    throw err
  }

  await sbWrite(config, 'PATCH', `/chat_actions?id=eq.${enc(actionId)}`, { status: 'undone', undone_at: new Date().toISOString() })
  return { id: actionId, status: 'undone' }
}
