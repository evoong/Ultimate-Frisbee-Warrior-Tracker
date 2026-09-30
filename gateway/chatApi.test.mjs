// Offline tests for the Task 4 chat API surface: the undo error mapper
// (mapRollbackError), the Worker handlers (direct calls with a stubbed
// global fetch, modeled on server/test/billingCheckout.test.mjs's
// JWKS-token + REST-stub approach), and the Express mirrors (real HTTP
// against createServer(app) with the same stubs) so both runtimes'
// contracts are asserted to match. POST /api/chat's { reply, actions }
// shape is deliberately NOT covered here: it needs the Gemini round-trip
// (runChatAgent), whose wire protocol is too brittle to stub offline; the
// receipt plumbing behind it is covered by gateway/agent/agent.test.mjs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

process.env.VERCEL = '1'
process.env.SUPABASE_URL = 'https://example.test'
process.env.SUPABASE_SECRET_KEY = 'service-role-key'
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-key'
process.env.SUPABASE_JWKS_URL = 'https://example.test/auth/v1/.well-known/jwks.json'
process.env.POSTHOG_PROJECT_TOKEN = 'posthog-token'
process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_mock'
process.env.APP_URL = 'http://localhost:5199'

const SUPABASE = 'https://example.test'
const JWKS_URL = `${SUPABASE}/auth/v1/.well-known/jwks.json`

const { privateKey, publicKey } = await generateKeyPair('RS256')
const jwk = await exportJWK(publicKey)
jwk.kid = 'test-key'

// ── In-memory PostgREST stub ────────────────────────────────────────────────
// eq filters, select projection (so a handler that asks for snapshot columns
// visibly fails), order desc, limit, and return=representation semantics for
// PATCH/DELETE — the same convention as gateway/agent/agent.test.mjs.
const ORG = 7
const SESSION = '22222222-2222-4222-8222-222222222222'
const ACTION_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '33333333-3333-4333-8333-333333333333'

const EVENT_ROW = { id: 3, player_id: 702, related_player_id: null, event_type: 'Goal', game_id: 901, event_timestamp: '2026-09-28T18:30:00Z', notes: null, organization_id: ORG }

function appliedAction() {
  return {
    id: ACTION_ID,
    organization_id: ORG,
    session_id: SESSION,
    user_id: 'user-editor',
    request_id: REQUEST_ID,
    action_type: 'create_game_event',
    description: 'Logged Goal for Recent Star',
    status: 'applied',
    before_rows: {},
    after_rows: { event: { ...EVENT_ROW } },
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }
}

function freshStores() {
  return {
    team_members: [
      { user_id: 'user-editor', team_id: ORG, role: 'editor' },
      { user_id: 'user-member', team_id: ORG, role: 'member' },
    ],
    chat_actions: [
      appliedAction(),
      // Another user's action in the same org/session: must never come back.
      { id: '44444444-4444-4444-8444-444444444444', organization_id: ORG, session_id: SESSION, user_id: 'user-other', request_id: REQUEST_ID, action_type: 'create_game_event', description: "someone else's action", status: 'applied', before_rows: {}, after_rows: {}, created_at: new Date(Date.now() - 30_000).toISOString() },
    ],
    game_events: [{ ...EVENT_ROW }],
    chat_logs: [
      { session_id: SESSION, role: 'user', content: 'log a goal', organization_id: ORG, user_id: 'user-editor', request_id: REQUEST_ID, created_at: new Date(Date.now() - 90_000).toISOString() },
      { session_id: SESSION, role: 'assistant', content: 'done', organization_id: ORG, user_id: 'user-editor', request_id: REQUEST_ID, created_at: new Date(Date.now() - 80_000).toISOString() },
    ],
  }
}

let tables = freshStores()
const writes = { patches: [], deletes: [] }
// When set, the next non-GET REST call answers 500 (drives the generic 500 path).
let failNextWrite = false

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') return realFetch(url, init)
  if (target.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] })

  const table = target.pathname.split('/rest/v1/')[1]
  if (!table) throw new Error(`unmocked fetch: ${url}`)
  const method = init.method ?? 'GET'
  const body = init.body !== undefined ? JSON.parse(String(init.body)) : undefined

  if (method !== 'GET' && failNextWrite) {
    failNextWrite = false
    return new Response('injected failure', { status: 500 })
  }

  if (table === 'team_members' && method === 'GET') {
    const userId = target.searchParams.get('user_id')?.replace('eq.', '')
    // membership.load selects team_id,role only; the stub keeps user_id for
    // its own filtering and strips it from the response.
    return Response.json((tables.team_members ?? []).filter(r => r.user_id === userId).map(({ user_id, ...row }) => row))
  }

  const store = (tables[table] ??= [])
  const eqMatch = (r) => {
    for (const [k, v] of target.searchParams.entries()) {
      if (k === 'select' || k === 'order' || k === 'limit') continue
      if (!v.startsWith('eq.') || String(r[k]) !== v.slice(3)) return false
    }
    return true
  }

  if (method === 'GET') {
    let rows = store.filter(eqMatch)
    const select = target.searchParams.get('select')
    if (select && select !== '*') {
      const cols = select.split(',')
      rows = rows.map(r => Object.fromEntries(cols.filter(c => c in r).map(c => [c, r[c]])))
    }
    if ((target.searchParams.get('order') ?? '').endsWith('.desc')) rows = [...rows].reverse()
    const limit = Number(target.searchParams.get('limit'))
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit)
    return Response.json(rows)
  }
  if (method === 'PATCH') {
    writes.patches.push({ table, params: Object.fromEntries(target.searchParams), body })
    const matched = store.filter(eqMatch)
    for (const r of matched) Object.assign(r, body)
    return Response.json(matched)
  }
  if (method === 'DELETE') {
    writes.deletes.push({ table, params: Object.fromEntries(target.searchParams) })
    const removed = store.filter(eqMatch)
    tables[table] = store.filter(r => !eqMatch(r))
    return Response.json(removed)
  }
  if (method === 'POST') {
    const rows = Array.isArray(body) ? body : [body]
    store.push(...rows)
    return Response.json(rows)
  }
  throw new Error(`unmocked REST: ${method} ${url}`)
}

async function tokenFor(sub, extra = {}) {
  return new SignJWT({ email: `${sub}@example.test`, ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

const chatConfig = {
  supabaseUrl: SUPABASE,
  publishableKey: 'publishable-key',
  jwksUrl: JWKS_URL,
  supabaseSecretKey: 'service-role-key',
}

const undoRequest = (body, token, url = 'http://app.test/api/chat/undo') => new Request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { cookie: `ufwt_at=${token}` } : {}) },
  body: JSON.stringify(body),
})

function reset() {
  tables = freshStores()
  writes.patches.length = 0
  writes.deletes.length = 0
  failNextWrite = false
}

// ── Phase A: the error mapper (pure) ────────────────────────────────────────
const { mapRollbackError, handleChatUndoRequest, handleChatHistoryRequest, handleChatHistoryDeleteRequest } = await import('./chat.ts')

{
  const cases = [
    ['action not found', { status: 404, error: 'action not found' }],
    // Substring, not exact sentence: chatRecovery's wording can drift.
    ['lookup: action not found ( drifted wrapper )', { status: 404, error: 'action not found' }],
    ['action is not in applied state', { status: 409, error: 'action already undone or in progress' }],
    ['MISMATCH', { status: 409, error: 'action cannot be undone: the affected data has changed since the action was taken' }],
    ['action cannot be undone: the affected data has changed', { status: 409, error: 'action cannot be undone: the affected data has changed since the action was taken' }],
    ['cannot invert unknown action type: whatever', { status: 500, error: 'undo failed' }],
    ['Supabase DELETE failed (500): internal detail with paths', { status: 500, error: 'undo failed' }],
  ]
  for (const [msg, expected] of cases) {
    const mapped = mapRollbackError(new Error(msg))
    assert.equal(mapped.status, expected.status, `status for ${msg}`)
    assert.equal(mapped.body.error, expected.error, `body for ${msg}`)
  }
  // Non-Error throws and internals never leak.
  const mapped = mapRollbackError('a raw string failure with internals')
  assert.equal(mapped.status, 500)
  assert.equal(mapped.body.error, 'undo failed')
  assert.ok(!JSON.stringify(mapped).includes('internals'))
  console.log('✓ mapRollbackError maps every thrown class, substring-matched, no internals leak')
}

// ── Phase B: Worker handlers ─────────────────────────────────────────────────

// Validation (before any auth: no cookie, no REST hit needed).
{
  const missingId = await handleChatUndoRequest(chatConfig, undoRequest({ organization_id: ORG }))
  assert.equal(missingId.status, 400)
  assert.equal((await missingId.json()).error, 'action_id must be a UUID')

  const badId = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: 'not-a-uuid', organization_id: ORG }))
  assert.equal(badId.status, 400)
  assert.equal((await badId.json()).error, 'action_id must be a UUID')

  const missingOrg = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID }))
  assert.equal(missingOrg.status, 400)
  assert.equal((await missingOrg.json()).error, 'organization_id required')
  console.log('✓ undo validation: missing/non-UUID action_id and missing organization_id all 400')
}

// Auth: 401 unauthenticated, 403 guest, 403 below editor.
{
  const unauthenticated = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID, organization_id: ORG }))
  assert.equal(unauthenticated.status, 401)

  const guest = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID, organization_id: ORG }, await tokenFor('guest-user', { is_anonymous: true, email: '' })))
  assert.equal(guest.status, 403)

  const member = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID, organization_id: ORG }, await tokenFor('user-member')))
  assert.equal(member.status, 403)
  assert.equal(tables.chat_actions[0].status, 'applied', 'no rollback ran')
  console.log('✓ undo auth: 401 unauthenticated, 403 guest, 403 member below editor')
}

// Happy path: editor undoes an applied action; session_id in the body is
// accepted but never used for scoping (a wrong session_id still undoes).
{
  reset()
  const res = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID, organization_id: ORG, session_id: 'wrong-session-on-purpose' }, await tokenFor('user-editor')))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { ok: true, action: { id: ACTION_ID, status: 'undone' } })
  assert.equal(tables.chat_actions[0].status, 'undone')
  assert.equal(tables.game_events.length, 0, 'inverse op (DELETE of the created event) ran')
  const statuses = writes.patches.filter(p => p.table === 'chat_actions').map(p => p.body.status)
  assert.deepEqual(statuses, ['undoing', 'undone'], 'CAS claim then completion PATCH')
  console.log('✓ undo happy path: 200, action undone, inverse executed, session_id not a scoping key')
}

// 404: no such action for this user.
{
  reset()
  const res = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: '55555555-5555-4555-8555-555555555555', organization_id: ORG }, await tokenFor('user-editor')))
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'action not found')
  console.log('✓ undo of unknown action -> 404')
}

// 409 already undone / in progress.
{
  reset()
  tables.chat_actions[0].status = 'undoing'
  const res = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID, organization_id: ORG }, await tokenFor('user-editor')))
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'action already undone or in progress')
  console.log('✓ undo of in-progress action -> 409 already undone or in progress')
}

// 409 intervening edit: verification MISMATCH, receipt reverted to applied.
{
  reset()
  tables.game_events[0].notes = 'someone edited this after the action'
  const res = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID, organization_id: ORG }, await tokenFor('user-editor')))
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'action cannot be undone: the affected data has changed since the action was taken')
  assert.equal(tables.chat_actions[0].status, 'applied', 'failed rollback reverts the receipt to applied')
  assert.equal(tables.game_events.length, 1, 'no inverse op ran')
  console.log('✓ undo after intervening edit -> 409 MISMATCH, receipt reverted')
}

// 500 generic: a mid-rollback infra failure maps to a safe body.
{
  reset()
  failNextWrite = true
  const res = await handleChatUndoRequest(chatConfig, undoRequest({ action_id: ACTION_ID, organization_id: ORG }, await tokenFor('user-editor')))
  assert.equal(res.status, 500)
  const text = JSON.stringify(await res.json())
  assert.equal(JSON.parse(text).error, 'undo failed')
  assert.ok(!text.includes('example.test'), 'no internals in the 500 body')
  console.log('✓ undo infra failure -> 500 with generic message, no internals leaked')
}

// History GET: { messages, actions }, receipts scoped to user+org+session,
// snapshot columns never selected.
{
  reset()
  const url = `http://app.test/api/chat/history?session_id=${SESSION}&organization_id=${ORG}`
  const res = await handleChatHistoryRequest(chatConfig, new Request(url, { headers: { cookie: `ufwt_at=${await tokenFor('user-editor')}` } }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(Array.isArray(body.messages), 'messages is an array (existing shape)')
  assert.equal(body.messages.length, 2)
  assert.deepEqual(body.messages.map(m => m.role), ['user', 'assistant'])
  assert.equal(body.actions.length, 1, "the other user's action is filtered out")
  assert.deepEqual(Object.keys(body.actions[0]).sort(), ['description', 'id', 'request_id', 'status'])
  assert.equal(body.actions[0].id, ACTION_ID)
  assert.equal(body.actions[0].status, 'applied')
  console.log('✓ history GET: { messages, actions }, user-scoped, no snapshot columns')
}

// History DELETE: clears chat_logs only; chat_actions survive.
{
  reset()
  const url = `http://app.test/api/chat/history?session_id=${SESSION}&organization_id=${ORG}`
  const res = await handleChatHistoryDeleteRequest(chatConfig, new Request(url, { method: 'DELETE', headers: { cookie: `ufwt_at=${await tokenFor('user-editor')}` } }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.deepEqual(writes.deletes.map(d => d.table), ['chat_logs'], 'only chat_logs was deleted')
  assert.equal(tables.chat_actions.length, 2, 'chat_actions receipts survive history clearing (binding spec rule)')
  console.log('✓ history DELETE: chat_logs gone, chat_actions intact')
}

// ── Phase C: Express parity (real HTTP against server/index.ts) ──────────────
{
  const { default: app } = await import('../server/index.ts')
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    // Undo happy path: identical status + body to the Worker's.
    reset()
    let res = await fetch(`${origin}/api/chat/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('user-editor')}` },
      body: JSON.stringify({ action_id: ACTION_ID, organization_id: ORG }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, action: { id: ACTION_ID, status: 'undone' } })
    assert.equal(tables.game_events.length, 0)
    console.log('✓ Express undo happy path matches the Worker (status + body + effect)')

    // Editor gate: a member gets 403 in this runtime too.
    reset()
    res = await fetch(`${origin}/api/chat/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('user-member')}` },
      body: JSON.stringify({ action_id: ACTION_ID, organization_id: ORG }),
    })
    assert.equal(res.status, 403)
    assert.equal(tables.chat_actions[0].status, 'applied')
    console.log('✓ Express undo gates on editor tier (member -> 403)')

    // Shared mapper parity: same 409 MISMATCH body both runtimes produce.
    reset()
    tables.game_events[0].notes = 'intervening edit'
    res = await fetch(`${origin}/api/chat/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `ufwt_at=${await tokenFor('user-editor')}` },
      body: JSON.stringify({ action_id: ACTION_ID, organization_id: ORG }),
    })
    assert.equal(res.status, 409)
    assert.equal((await res.json()).error, 'action cannot be undone: the affected data has changed since the action was taken')
    console.log('✓ Express undo MISMATCH maps through the same mapper (409, same body)')

    // History: { messages, actions } matches the Worker's shape.
    reset()
    res = await fetch(`${origin}/api/chat/history?session_id=${SESSION}&organization_id=${ORG}`, {
      headers: { cookie: `ufwt_at=${await tokenFor('user-editor')}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages.length, 2)
    assert.equal(body.actions.length, 1)
    assert.deepEqual(Object.keys(body.actions[0]).sort(), ['description', 'id', 'request_id', 'status'])
    console.log('✓ Express history returns { messages, actions } with the same shape')

    // Delete: chat_actions still intact afterwards.
    reset()
    res = await fetch(`${origin}/api/chat/history?session_id=${SESSION}&organization_id=${ORG}`, {
      method: 'DELETE',
      headers: { cookie: `ufwt_at=${await tokenFor('user-editor')}` },
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.deepEqual(writes.deletes.map(d => d.table), ['chat_logs'])
    assert.equal(tables.chat_actions.length, 2)
    console.log('✓ Express history DELETE leaves chat_actions intact')
  } finally {
    server.close()
  }
}

globalThis.fetch = realFetch
console.log('✓ gateway/chatApi.test.mjs all passed')
