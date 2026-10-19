import assert from 'node:assert/strict'
import { handleAuthRequest } from './auth-handlers.ts'

const config = { supabaseUrl: 'https://example.test', publishableKey: 'pub-key', jwksUrl: 'https://example.test/.well-known/jwks.json' }
// Unsigned JWT with a far-future exp: resolveAccessToken only checks expiry.
const jwt = `x.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.y`
const realFetch = globalThis.fetch
const reply = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })

async function run({ cookie = true, body, invites = [{ id: 1 }], deleted = false, otp = 200 }) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const u = String(input)
    calls.push({ u, init })
    if (u.includes('/rest/v1/team_invites')) {
      assert.equal(init.headers.Authorization, `Bearer ${jwt}`, 'permission lookup uses the caller token')
      return reply(invites)
    }
    if (u.endsWith('/rest/v1/rpc/is_email_deleted')) return reply(deleted)
    if (u.endsWith('/auth/v1/otp')) return reply({}, otp)
    throw new Error(`unexpected fetch ${u}`)
  }
  const headers = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `__Host-ufwt_at=${jwt}` } : {}) }
  const request = new Request('https://app.test/auth/invite-email', { method: 'POST', headers, body: JSON.stringify(body) })
  const response = await handleAuthRequest(config, request, new URL(request.url))
  return { response, calls }
}

try {
  const ok = await run({ body: { teamId: 1, email: ' New@Example.com ' } })
  assert.equal(ok.response.status, 200)
  const otp = ok.calls.find(c => c.u.endsWith('/auth/v1/otp'))
  assert.deepEqual(JSON.parse(otp.init.body), { email: 'new@example.com', create_user: true })
  assert.ok(ok.calls[0].u.includes('email=eq.new%40example.com'))

  const anon = await run({ cookie: false, body: { teamId: 1, email: 'a@b.co' } })
  assert.equal(anon.response.status, 401)

  const notManager = await run({ body: { teamId: 1, email: 'a@b.co' }, invites: [] })
  assert.equal(notManager.response.status, 404)
  assert.ok(!notManager.calls.some(c => c.u.endsWith('/auth/v1/otp')), 'nothing mailed without a visible invite')

  const del = await run({ body: { teamId: 1, email: 'a@b.co' }, deleted: true })
  assert.equal(del.response.status, 403)
  assert.ok(!del.calls.some(c => c.u.endsWith('/auth/v1/otp')))

  const bad = await run({ body: { teamId: 'x', email: 'a@b.co' } })
  assert.equal(bad.response.status, 400)
  console.log('auth-invite-email: ok')
} finally {
  globalThis.fetch = realFetch
}
