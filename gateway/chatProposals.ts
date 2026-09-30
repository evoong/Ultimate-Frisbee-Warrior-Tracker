// Proposal store for chat action cards (spec:
// 2026-09-29-chat-interactive-features). The agent's write tools never
// execute: they store a proposal here and return a marker; POST
// /api/chat/confirm claims the row with an atomic DELETE (return=representation
// makes the DELETE the single-use primitive — the loser of a double-click gets
// an empty array) and executes. Service-role only, Workers-portable raw
// fetch, mirroring gameActions.ts/supabaseRest.ts conventions.
import type { ActionsConfig } from './gameActions.js'
import { callChatFunction, resolveGame, resolvePlayer, resolveSeason, WRITE_FUNCTIONS, type ActionReceiptData, type GameRow } from './gameActions.js'
import { recordChatAction, type ChatActionReceipt } from './chatRecovery.js'
import { hasAtLeast, type TeamRole } from './membership.js'
import { sbGet, sbWrite } from './supabaseRest.js'

export interface ProposalRow {
  id: string
  session_id: string
  organization_id: number
  user_id: string
  tool_name: string
  args: Record<string, unknown>
  created_at: string
}

export type ProposalFilter = Pick<ProposalRow, 'id' | 'session_id' | 'organization_id' | 'user_id'>

export const PROPOSAL_TTL_MS = 15 * 60 * 1000

// HTTP-mappable error for the confirm endpoint: status is the response code.
export class ConfirmError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function filterPath(f: ProposalFilter): string {
  return `/chat_action_proposals?id=eq.${f.id}&session_id=eq.${encodeURIComponent(f.session_id)}&organization_id=eq.${f.organization_id}&user_id=eq.${encodeURIComponent(f.user_id)}&select=*`
}

export async function createProposal(config: ActionsConfig, row: Omit<ProposalRow, 'id' | 'created_at'>): Promise<ProposalRow> {
  // uuid minted app-side: crypto.randomUUID exists on both runtimes and
  // keeps the store one round trip.
  const created = await sbWrite(config, 'POST', '/chat_action_proposals', { ...row, id: crypto.randomUUID() })
  return created[0] as ProposalRow
}

export async function getProposal(config: ActionsConfig, f: ProposalFilter): Promise<ProposalRow | null> {
  const rows = await sbGet(config, filterPath(f))
  return (rows ?? [])[0] ?? null
}

// The atomic claim: PostgREST DELETE returns the deleted rows, so exactly
// one caller ever sees a row back. sbWrite sends Prefer: return=representation.
export async function takeProposal(config: ActionsConfig, f: ProposalFilter): Promise<ProposalRow | null> {
  const rows = await sbWrite(config, 'DELETE', filterPath(f))
  return (rows ?? [])[0] ?? null
}

export async function deleteProposal(config: ActionsConfig, f: ProposalFilter): Promise<void> {
  await sbWrite(config, 'DELETE', filterPath(f))
}

export function isExpired(row: ProposalRow, now = Date.now()): boolean {
  return now - new Date(row.created_at).getTime() > PROPOSAL_TTL_MS
}

// Validates a write tool's args with the SAME resolution the real handler
// will use (reads only — no data is written at proposal time), so the card
// can show real dates/names and invalid input fails before anything is
// stored. Summaries are server-built from resolved names, never model text.
async function summarizeProposal(
  config: ActionsConfig, orgId: number, tool: string, args: Record<string, unknown>
): Promise<string> {
  const hint = { gameDate: args.gameDate as string | undefined, opponent: args.opponent as string | undefined }
  const gameLabel = (g: GameRow) => `the ${g.game_date} game vs ${g.opponent}`
  const str = (k: string) => (typeof args[k] === 'string' ? args[k] as string : undefined)

  switch (tool) {
    case 'create_game_event': {
      const game = await resolveGame(config, orgId, hint)
      const player = str('playerName') ? await resolvePlayer(config, orgId, str('playerName')!) : null
      const assister = str('assisterName') ? await resolvePlayer(config, orgId, str('assisterName')!) : null
      return `Log ${str('eventType')}${player ? ` for ${player.display_name}` : ''}${assister ? ` (assist: ${assister.display_name})` : ''} in ${gameLabel(game)}`
    }
    case 'undo_last_event': {
      const game = await resolveGame(config, orgId, hint)
      return `Undo the most recent event in ${gameLabel(game)}`
    }
    case 'add_to_lineup': {
      const game = await resolveGame(config, orgId, hint)
      const player = await resolvePlayer(config, orgId, str('playerName')!)
      return `Place ${player.display_name} in ${str('lineupGroupName') ?? 'the first lineup group'} for ${gameLabel(game)}`
    }
    case 'remove_from_lineup': {
      const game = await resolveGame(config, orgId, hint)
      const player = await resolvePlayer(config, orgId, str('playerName')!)
      return `Remove ${player.display_name} from the lineup of ${gameLabel(game)}`
    }
    case 'create_lineup_group': {
      const game = await resolveGame(config, orgId, hint)
      return `Add lineup group "${str('name')}" to ${gameLabel(game)}`
    }
    case 'create_lineup': {
      const game = await resolveGame(config, orgId, hint)
      const groups = args.groups as { name: string; players?: { playerName: string; role?: string }[] }[]
      if (!Array.isArray(groups) || groups.length === 0) throw new Error('create_lineup requires at least one lineup group.')
      const parts: string[] = []
      for (const g of groups) {
        const names: string[] = []
        for (const p of g.players ?? []) {
          const resolved = await resolvePlayer(config, orgId, p.playerName)
          names.push(resolved.display_name)
        }
        parts.push(`${g.name} (${names.join(', ')})`)
      }
      return `Set the lineup for ${gameLabel(game)}: ${parts.join('; ')}`
    }
    case 'save_lineup_template': {
      const game = await resolveGame(config, orgId, hint)
      // The handler requires the game's season (or an explicit seasonName to
      // override); a seasonless game can only fail at confirm, so fail the
      // proposal instead — the card must never promise that.
      if (str('seasonName')) await resolveSeason(config, orgId, str('seasonName')!)
      else if (!game.season_id) throw new Error('A lineup template must be associated with a season. This game has no season.')
      return `Save ${gameLabel(game)}'s lineup as template "${str('name')}"`
    }
    case 'apply_lineup_template': {
      const game = await resolveGame(config, orgId, hint)
      const name = str('templateName')!
      // Same season resolution the handler uses: args.seasonName if given,
      // else the game's season — a season-blind match could summarize a
      // DIFFERENT same-named template than confirm would load.
      const seasonName = str('seasonName')
      const seasonId = seasonName ? (await resolveSeason(config, orgId, seasonName)).id : game.season_id
      // Same loose match the frontend/agent uses; fails loudly when absent.
      const templates: { id: number; name: string }[] = seasonId
        ? await sbGet(config, `/lineup_templates?organization_id=eq.${orgId}&season_id=eq.${seasonId}&select=id,name`)
        : await sbGet(config, `/lineup_templates?organization_id=eq.${orgId}&select=id,name`)
      const q = name.trim().toLowerCase()
      let matches = templates.filter(t => t.name.toLowerCase() === q)
      if (matches.length === 0) matches = templates.filter(t => t.name.toLowerCase().includes(q))
      if (matches.length === 0) throw new Error(`No lineup template found matching "${name}".`)
      if (matches.length > 1) throw new Error(`Multiple lineup templates match "${name}": ${matches.map(m => m.name).join(', ')}. Be more specific.`)
      return `Load lineup template "${matches[0]!.name}" into ${gameLabel(game)}`
    }
    default:
      throw new Error(`Unknown write tool: ${tool}`)
  }
}

export async function buildProposal(
  config: ActionsConfig,
  ctx: { organization_id: number; session_id: string; user_id: string },
  tool_name: string,
  args: Record<string, unknown>,
): Promise<{ id: string; tool_name: string; args: Record<string, unknown>; summary: string }> {
  if (!WRITE_FUNCTIONS.has(tool_name)) throw new Error(`Unknown write tool: ${tool_name}`)
  const summary = await summarizeProposal(config, ctx.organization_id, tool_name, args)
  const row = await createProposal(config, { ...ctx, tool_name, args })
  return { id: row.id, tool_name, args, summary }
}

// Same strip as agent/tools.ts: write handlers attach `__receipt` to their
// return value; it never flows to a client as part of `result`.
function stripReceipt(output: unknown): { result: unknown; receipt?: ActionReceiptData } {
  if (output == null || typeof output !== 'object' || Array.isArray(output) || !('__receipt' in output)) {
    return { result: output }
  }
  const { __receipt, ...rest } = output as { __receipt?: ActionReceiptData } & Record<string, unknown>
  return { result: rest, receipt: __receipt }
}

// The confirm endpoint's core. Order matters and is load-bearing:
// 1. GET (ownership-filtered) — not found means wrong id OR wrong
//    session/org/user; do not distinguish (no oracle).
// 2. expiry — an expired row is inert, so consume it while rejecting.
// 3. role — checked BEFORE the claim so a denial leaves the row pending
//    (spec: a role failure must not burn the user's proposal).
// 4. DELETE claim — the single-use primitive; losing it means a concurrent
//    confirm won, which must surface as 409, not as a double write.
// 5. dispatch the ORIGINAL tool via the same callChatFunction the agent used,
//    stripping its __receipt and recording it as a chat_actions row when the
//    runtime supplied session identity — that record is what makes the
//    agent's rollback_last_action (and the /api/chat/undo button) able to
//    undo a CARD-confirmed action, exactly as it does reply-executed ones.
export async function confirmProposal(
  config: ActionsConfig,
  params: ProposalFilter & { role: TeamRole; recovery?: { sessionId: string; userId: string; requestId: string } },
): Promise<{ result: unknown; receipt: ChatActionReceipt | null }> {
  const row = await getProposal(config, params)
  if (!row) throw new ConfirmError(404, 'proposal not found or already used')
  if (isExpired(row)) {
    await deleteProposal(config, params)
    throw new ConfirmError(410, 'this proposal expired — ask the assistant again')
  }
  if (WRITE_FUNCTIONS.has(row.tool_name) && !hasAtLeast(params.role, 'editor')) {
    throw new ConfirmError(403, "you do not have permission to change this team's data")
  }
  const claimed = await takeProposal(config, params)
  if (!claimed) throw new ConfirmError(409, 'proposal already confirmed')
  const raw = await callChatFunction(config, params.organization_id, claimed.tool_name, claimed.args)
  const { result, receipt } = stripReceipt(raw)
  let recorded: ChatActionReceipt | null = null
  if (receipt && params.recovery) {
    // A record failure after the write landed throws — the confirm endpoint
    // reports it as an error; the write is real either way (same atomicity
    // caveat tools.ts documents for the reply-executed path).
    recorded = await recordChatAction(config, params.organization_id, {
      sessionId: params.recovery.sessionId,
      userId: params.recovery.userId,
      requestId: params.recovery.requestId,
      actionType: claimed.tool_name,
      description: receipt.description,
      beforeRows: receipt.before,
      afterRows: receipt.after,
    })
  }
  return { result, receipt: recorded }
}
