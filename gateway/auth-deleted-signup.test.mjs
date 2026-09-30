import assert from 'node:assert/strict'
import { handleAuthRequest } from './auth-handlers.ts'

const config = {
  supabaseUrl: 'https://example.test',
  publishableKey: 'pub-key',
  jwksUrl: 'https://example.test/.well-known/jwks.json',
}
const session = {
  access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
  user: { id: 'u1', email: 'Deleted@Example.com' },
}
const realFetch = globalThis.fetch
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

async function run(path, options, lookup, expectedStatus, expectedLocation) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/rest/v1/rpc/is_email_deleted')) {
      assert.equal(init.method, 'POST')
      assert.equal(init.headers.apikey, config.publishableKey)
      assert.equal(init.headers.Authorization, `Bearer ${config.publishableKey}`)
      assert.equal(JSON.parse(init.body).p_email.toLowerCase(), 'deleted@example.com')
      if (lookup === 'network') throw new Error('offline')
      if (lookup === 'invalid') return reply({ error: 'broken' })
      if (lookup === 'http') return reply({ error: 'unavailable' }, 500)
      return reply(lookup)
    }
    if (url.endsWith('/auth/v1/signup')) return reply({ user: session.user })
    if (url.includes('/auth/v1/token?grant_type=pkce') || url.endsWith('/auth/v1/verify')) {
      return reply(lookup === 'missing_email' ? { ...session, user: { id: 'u1' } } : session)
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const request = new Request(`https://app.test${path}`, options)
  const response = await handleAuthRequest(config, request, new URL(request.url))
  assert.equal(response.status, expectedStatus)
  if (expectedLocation) assert.equal(response.headers.get('Location'), expectedLocation)
  if (lookup !== false) assert.ok(!response.headers.getSetCookie().some(c => /ufwt_(at|rt)=/.test(c)), 'no session cookies issued')
  return { response, calls }
}

try {
  const signup = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'Deleted@Example.com', password: 'password123' }) }
  const blocked = await run('/auth/signup', signup, true, 403)
  assert.match((await blocked.response.json()).error, /deleted.*cannot be recreated/i)
  assert.ok(!blocked.calls.some(url => url.endsWith('/auth/v1/signup')))
  const active = await run('/auth/signup', signup, false, 200)
  assert.ok(active.calls.some(url => url.endsWith('/auth/v1/signup')))
  for (const failure of ['http', 'invalid', 'network']) {
    const result = await run('/auth/signup', signup, failure, 503)
    assert.ok(!result.calls.some(url => url.endsWith('/auth/v1/signup')))
  }
  for (const path of ['/auth/callback?code=abc', '/auth/callback?token_hash=abc&type=signup']) {
    const options = path.includes('code=') ? { headers: { Cookie: '__Host-ufwt_pkce=verifier' } } : {}
    await run(path, options, true, 302, '/?auth_error=account_deleted')
    await run(path, options, 'http', 503)
    await run(path, options, 'network', 503)
    const missing = await run(path, options, 'missing_email', 503)
    assert.ok(!missing.calls.some(url => url.endsWith('/rest/v1/rpc/is_email_deleted')))
    const valid = await run(path, options, false, 302, '/')
    assert.ok(valid.response.headers.getSetCookie().some(c => /ufwt_at=/.test(c)))
  }
  console.log('✓ gateway/auth-deleted-signup.test.mjs all passed')
} finally {
  globalThis.fetch = realFetch
}
