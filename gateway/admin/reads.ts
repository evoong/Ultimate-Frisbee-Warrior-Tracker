import { sbGet, sbWrite } from '../supabaseRest.js'
import type { AdminCtx } from './operations.js'

// The read half of /api/admin/*. Every route here requires only the readonly
// role, which the caller has already checked -- these routes are why the
// readonly role exists at all.
//
// Returns null when `segments` names no read route, so the caller can fall
// through to the operation dispatcher.

const AUDIT_PAGE_MAX = 200

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
