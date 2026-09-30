// Proposal store for chat action cards (spec:
// 2026-09-29-chat-interactive-features). The agent's write tools never
// execute: they store a proposal here and return a marker; POST
// /api/chat/confirm claims the row with an atomic DELETE (return=representation
// makes the DELETE the single-use primitive — the loser of a double-click gets
// an empty array) and executes. Service-role only, Workers-portable raw
// fetch, mirroring gameActions.ts/supabaseRest.ts conventions.
import type { ActionsConfig } from './gameActions.js'
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
