import assert from 'node:assert/strict'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { handleFlagsRequest } from './flags.ts'

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(publicKey), kid: 'test' }
const config = { supabaseUrl: 'https://db.test', supabaseSecretKey: 'secret', jwksUrl: 'https://db.test/jwks' }
const token = await new SignJWT({ email: 'member@test.local', is_anonymous: false })
  .setProtectedHeader({ alg: 'RS256', kid: 'test' })
  .setSubject('verified-user')
  .setIssuer(`${config.supabaseUrl}/auth/v1`)
  .setExpirationTime('1h')
  .sign(privateKey)
const originalFetch = globalThis.fetch
const calls = []
const ok = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
let memberships = [{ team_id: 3, role: 'member' }, { team_id: 7, role: 'captain' }]
globalThis.fetch = async url => {
  const path = new URL(url)
  calls.push(path)
  if (path.pathname === '/jwks') return ok({ keys: [jwk] })
  if (path.pathname === '/rest/v1/team_members') {
    assert.equal(path.searchParams.get('user_id'), 'eq.verified-user')
    return ok(memberships)
  }
  if (path.pathname === '/rest/v1/feature_flags') return ok([
    { key: 'show_turnovers', default_on: false },
    { key: 'new_ui', default_on: true },
  ])
  if (path.pathname === '/rest/v1/org_feature_flags') {
    assert.equal(path.searchParams.get('org_id'), 'in.(3,7)')
    return ok([
      { org_id: 3, flag_key: 'show_turnovers', enabled: true },
      { org_id: 7, flag_key: 'new_ui', enabled: false },
    ])
  }
  throw new Error(`unexpected request: ${url}`)
}

try {
  const request = (query = '', cookie = true) => new Request(`https://app.test/api/flags${query}`, {
    headers: cookie ? { cookie: `__Host-ufwt_at=${token}` } : {},
  })
  const multiOrg = await handleFlagsRequest(config, request('?org_id=999&organization_id=999'))
  assert.equal(multiOrg.status, 200)
  assert.deepEqual(await multiOrg.json(), { flags: {
    3: { show_turnovers: true, new_ui: true },
    7: { show_turnovers: false, new_ui: false },
  } })
  assert.ok(calls.every(url => !url.search.includes('999')))
  const callCount = calls.length
  const unsigned = await handleFlagsRequest(config, request('', false))
  assert.equal(unsigned.status, 401)
  assert.equal(calls.length, callCount)
  memberships = []
  calls.length = 0
  const noTeams = await handleFlagsRequest(config, request())
  assert.equal(noTeams.status, 200)
  assert.deepEqual(await noTeams.json(), { flags: {} })
  assert.ok(calls.every(url => url.pathname !== '/rest/v1/org_feature_flags'))
  const guestToken = await new SignJWT({ email: '', is_anonymous: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject('guest-user')
    .setIssuer(`${config.supabaseUrl}/auth/v1`)
    .setExpirationTime('1h')
    .sign(privateKey)
  const guest = await handleFlagsRequest(config, new Request('https://app.test/api/flags', {
    headers: { cookie: `__Host-ufwt_at=${guestToken}` },
  }))
  assert.equal(guest.status, 403)
  console.log('flags endpoint: multi-org, unsigned, zero-org, caller org ignored — passed')
} finally {
  globalThis.fetch = originalFetch
}
