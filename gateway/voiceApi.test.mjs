// Offline tests for the voice API surface (gateway/voice.ts), modeled on
// gateway/chatApi.test.mjs: a stubbed global fetch (JWKS + PostgREST) and
// real RS256 JWTs, calling the web-standard handlers directly.
import assert from 'node:assert/strict'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

process.env.VERCEL = '1'
process.env.SUPABASE_URL = 'https://example.test'
process.env.SUPABASE_SECRET_KEY = 'service-role-key'
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-key'
process.env.SUPABASE_JWKS_URL = 'https://example.test/auth/v1/.well-known/jwks.json'
process.env.GEMINI_API_KEY = 'mock-gemini-key'

const { handleVoiceSessionRequest, handleVoiceToolRequest, handleVoiceLogRequest } = await import('./voice.ts')
const { requireTeamMember } = await import('./chat.ts')

const SUPABASE = 'https://example.test'
const JWKS_URL = `${SUPABASE}/auth/v1/.well-known/jwks.json`

const { privateKey, publicKey } = await generateKeyPair('RS256')
const jwk = await exportJWK(publicKey)
jwk.kid = 'test-key'

const ORG = 7
const SESSION = '22222222-2222-4222-8222-222222222222'

async function makeToken(opts = {}) {
  const o = { sub: 'user-editor', email: 'editor@example.com', isAnon: false, ...opts }
  const b = new SignJWT({ email: o.email, is_anonymous: o.isAnon })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setSubject(o.sub)
  return b.sign(privateKey)
}

// PostgREST stub: membership rows by user_id, plus a chat_logs capture.
let loggedRows = null
function stubFetch(members) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url === JWKS_URL) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/rest/v1/chat_action_proposals') && init?.method === 'POST') {
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify([{ id: '11111111-1111-4111-8111-111111111111', summary: 'Logged Goal', ...body }]), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/rest/v1/chat_logs') && (init?.method === 'POST' || init?.method === 'PATCH')) {
      const body = JSON.parse(init.body)
      if (Array.isArray(body)) loggedRows = body
      else loggedRows = (loggedRows ?? []).concat([body])
      return new Response(JSON.stringify(body), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/rest/v1/chat_logs')) {
      return new Response(JSON.stringify(loggedRows ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('team_members')) {
      return new Response(JSON.stringify(members), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('players')) {
      return new Response(JSON.stringify([{ id: 701, display_name: 'Recent Star', first_name: 'Recent', last_name: 'Star', organization_id: ORG }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('seasons')) {
      return new Response(JSON.stringify([{ id: 1, name: '2026', organization_id: ORG, is_active: true }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('games') || url.includes('game_events') || url.includes('player_stats') || url.includes('lineup')) {
      if (url.includes('games?')) {
        return new Response(JSON.stringify([{ id: 901, season_id: 1, opponent: 'Rivals', game_date: '2026-10-25', game_time: '18:00', organization_id: ORG }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('organizations')) {
      return new Response(JSON.stringify([{ id: ORG, name: 'Test Org', tier: 'premium' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('player_links')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

function config() {
  return {
    supabaseUrl: SUPABASE,
    publishableKey: 'publishable-key',
    jwksUrl: JWKS_URL,
    supabaseSecretKey: 'service-role-key',
    geminiApiKey: 'mock-gemini-key',
    posthogProjectToken: null,
    posthogHost: null,
    langsmithApiKey: null,
    langsmithProject: null,
  }
}

function req(path, token, body) {
  const h = { 'Content-Type': 'application/json' }
  if (token) h.cookie = `ufwt_at=${token}`
  return new Request(`http://localhost${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) })
}

console.log('--- Voice API tests ---')
let n = 0
function ok(label) { n++; console.log(`✓ ${label}`) }

// ── Session endpoint ─────────────────────────────────────────────────────────
globalThis.fetch = stubFetch([{ team_id: ORG, role: 'editor' }])

// 401: no bearer
{
  const res = await handleVoiceSessionRequest(config(), req('/api/chat/voice/session', null, { organization_id: ORG, session_id: SESSION }))
  assert.equal(res.status, 401)
  ok('401 with no auth token')
}

// 403: guest (anonymous token)
{
  const res = await handleVoiceSessionRequest(config(), req('/api/chat/voice/session', await makeToken({ sub: 'guest-1', isAnon: true }), { organization_id: ORG, session_id: SESSION }))
  assert.equal(res.status, 403)
  ok('403 for anonymous guest')
}

// 403: signed-in non-member
{
  globalThis.fetch = stubFetch([{ team_id: 999, role: 'editor' }])
  const res = await handleVoiceSessionRequest(config(), req('/api/chat/voice/session', await makeToken({ sub: 'non-member' }), { organization_id: ORG, session_id: SESSION }))
  assert.equal(res.status, 403)
  ok('403 for signed-in non-member')
  globalThis.fetch = stubFetch([{ team_id: ORG, role: 'editor' }])
}

// 400: bad session_id / missing fields
{
  const token = await makeToken()
  for (const body of [
    { organization_id: ORG, session_id: 'not-a-uuid' },
    { organization_id: ORG },
    { session_id: SESSION },
  ]) {
    const res = await handleVoiceSessionRequest(config(), req('/api/chat/voice/session', token, body))
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
  ok('400 for bad session_id / missing fields')
}

// 200: member session — token minted (stubbed Gemini auth endpoint)
{
  const token = await makeToken()
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('generativelanguage.googleapis.com') && url.includes('authTokens')) {
      return new Response(JSON.stringify({ name: 'tokens/abc' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return realFetch(input, init)
  }
  const res = await handleVoiceSessionRequest(config(), req('/api/chat/voice/session', token, { organization_id: ORG, session_id: SESSION }))
  globalThis.fetch = realFetch
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.text()}`)
  ok('200 member session (token minted via stubbed authTokens.create)')
}

// ── Tool endpoint ────────────────────────────────────────────────────────────
globalThis.fetch = stubFetch([{ team_id: ORG, role: 'editor' }])
const editorToken = await makeToken()

// 200 read tool returns output
{
  const res = await handleVoiceToolRequest(config(), req('/api/chat/voice/tool', editorToken, { organization_id: ORG, session_id: SESSION, name: 'query_stat_breakdown', args: { breakdown: 'player' } }))
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok('output' in data, 'read tool response carries output')
  ok('read tool returns output')
}

// 200 write tool (editor) returns proposal, writes nothing
{
  const res = await handleVoiceToolRequest(config(), req('/api/chat/voice/tool', editorToken, { organization_id: ORG, session_id: SESSION, name: 'create_game_event', args: { eventType: 'Goal', playerName: 'Recent Star' } }))
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(data.proposal, 'write tool response carries a proposal')
  assert.equal(data.proposal.tool_name, 'create_game_event')
  ok('write tool as editor returns a proposal (and does not write)')
}

// member below editor: permission error
{
  globalThis.fetch = stubFetch([{ team_id: ORG, role: 'member' }])
  const memberToken = await makeToken({ sub: 'user-member' })
  const res = await handleVoiceToolRequest(config(), req('/api/chat/voice/tool', memberToken, { organization_id: ORG, session_id: SESSION, name: 'create_game_event', args: { eventType: 'Goal', playerName: 'Recent Star' } }))
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(data.error || (data.output && typeof data.output === 'object' && data.output.error), `member got: ${JSON.stringify(data).slice(0, 200)}`)
  ok('plain member write tool returns the permission error')
  globalThis.fetch = stubFetch([{ team_id: ORG, role: 'editor' }])
}

// 400: bad session_id / organization_id
{
  for (const body of [
    { organization_id: ORG, session_id: SESSION, args: {} },
    { organization_id: ORG, name: 'query_stat_breakdown', args: {} },
    { session_id: SESSION, name: 'query_stat_breakdown', args: {} },
  ]) {
    const res = await handleVoiceToolRequest(config(), req('/api/chat/voice/tool', editorToken, body))
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`)
  }
  ok('400 for bad tool request bodies')
}

// ── Log endpoint ─────────────────────────────────────────────────────────────
loggedRows = null
{
  const res = await handleVoiceLogRequest(config(), req('/api/chat/voice/log', editorToken, {
    organization_id: ORG,
    session_id: SESSION,
    turns: [
      { role: 'user', content: 'Who leads in goals?' },
      { role: 'assistant', content: 'Recent Star, with 12 goals.' },
    ],
  }))
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.ok, true)
  assert.ok(Array.isArray(loggedRows), 'chat_logs POST captured')
  assert.equal(loggedRows.length, 2, 'both turns logged')
  assert.equal(loggedRows[0].role, 'user')
  assert.equal(loggedRows[1].role, 'assistant')
  assert.equal(loggedRows[0].session_id, SESSION)
  assert.ok(loggedRows[0].user_id, 'user_id stamped from the token')
  assert.equal(loggedRows[0].organization_id, ORG, 'organization_id stamped')
  ok('voice log writes both roles with the right org/user')
}

console.log(`all voice API checks passed (${n})`)
