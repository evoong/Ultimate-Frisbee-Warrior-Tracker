import { createAdminLookup, hasAtLeastAdmin } from './adminAuth.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// --- hasAtLeastAdmin: pure rank comparison ---

check('superadmin satisfies readonly',   hasAtLeastAdmin('superadmin', 'readonly') === true)
check('superadmin satisfies support',    hasAtLeastAdmin('superadmin', 'support') === true)
check('support satisfies readonly',      hasAtLeastAdmin('support', 'readonly') === true)
check('support does not satisfy superadmin', hasAtLeastAdmin('support', 'superadmin') === false)
check('readonly does not satisfy support',   hasAtLeastAdmin('readonly', 'support') === false)
check('null satisfies nothing',          hasAtLeastAdmin(null, 'readonly') === false)
// Same-rank boundary: a role satisfies its own requirement exactly.
check('readonly satisfies readonly',     hasAtLeastAdmin('readonly', 'readonly') === true)
check('superadmin satisfies superadmin', hasAtLeastAdmin('superadmin', 'superadmin') === true)

// --- createAdminLookup: fetch stubbed, no stack required ---

const CONFIG = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'secret' }
const realFetch = globalThis.fetch

function stub(impl) {
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return impl(calls.length) }
  return calls
}
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

// A matching row yields the role.
stub(() => ok([{ role: 'support' }]))
check('returns the row role', await createAdminLookup(CONFIG).roleFor('u1') === 'support')

// No row means not an admin.
stub(() => ok([]))
check('no row yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// An unrecognized role string must not be trusted through.
stub(() => ok([{ role: 'wizard' }]))
check('unknown role yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// Fail closed on a non-2xx response.
stub(() => new Response('nope', { status: 500 }))
check('non-2xx yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// Fail closed when fetch itself throws.
stub(() => { throw new Error('refused') })
check('thrown fetch yields null', await createAdminLookup(CONFIG).roleFor('u1') === null)

// onLookupError fires, and does not turn a failure into an allow.
{
  let seen = null
  stub(() => { throw new Error('boom') })
  const lookup = createAdminLookup({ ...CONFIG, onLookupError: e => { seen = e } })
  const role = await lookup.roleFor('u1')
  check('onLookupError receives the error', seen instanceof Error)
  check('a reported error still denies', role === null)
}

// onLookupError fires on a !res.ok response too, and the result still denies.
{
  let seen = null
  stub(() => new Response('nope', { status: 500 }))
  const lookup = createAdminLookup({ ...CONFIG, onLookupError: e => { seen = e } })
  const role = await lookup.roleFor('u1')
  check('onLookupError fires on non-2xx', seen instanceof Error)
  check('a non-2xx response still denies', role === null)
}

// A malformed 2xx body (parses but isn't an array) must still report via
// onLookupError -- silently swallowing this would hide a schema mismatch or
// backend bug behind an ordinary-looking denial.
{
  let seen = null
  stub(() => ok({}))
  const lookup = createAdminLookup({ ...CONFIG, onLookupError: e => { seen = e } })
  const role = await lookup.roleFor('u1')
  check('onLookupError fires on a non-array 2xx body', seen instanceof Error)
  check('a non-array 2xx body still denies', role === null)
}

// ...and unlike the !res.ok/thrown-fetch paths, that malformed-2xx deny IS
// cached for the full TTL: one fetch covers two calls on the same instance.
{
  const calls = stub(() => ok('nope'))
  const lookup = createAdminLookup(CONFIG)
  await lookup.roleFor('u1')
  await lookup.roleFor('u1')
  check('malformed-2xx deny is cached', calls.length === 1)
}

// A successful result is cached: one fetch for two calls on the same instance.
{
  const calls = stub(() => ok([{ role: 'readonly' }]))
  const lookup = createAdminLookup(CONFIG)
  await lookup.roleFor('u1')
  await lookup.roleFor('u1')
  check('success is cached within the TTL', calls.length === 1)
}

// An error result is NOT cached: a transient outage must not lock an admin
// out for the remainder of the TTL once the backend recovers.
{
  const calls = stub(n => (n === 1 ? new Response('down', { status: 503 }) : ok([{ role: 'support' }])))
  const lookup = createAdminLookup(CONFIG)
  const first = await lookup.roleFor('u1')
  const second = await lookup.roleFor('u1')
  check('first call denied', first === null)
  check('error result was not cached', calls.length === 2)
  check('recovery is visible immediately', second === 'support')
}

// Distinct users do not share a cache entry.
{
  const calls = stub(n => ok([{ role: n === 1 ? 'support' : 'readonly' }]))
  const lookup = createAdminLookup(CONFIG)
  check('user 1 role', await lookup.roleFor('u1') === 'support')
  check('user 2 role', await lookup.roleFor('u2') === 'readonly')
  check('two users cost two fetches', calls.length === 2)
}

// The user id must be encoded into the query, not interpolated raw.
{
  const calls = stub(() => ok([]))
  await createAdminLookup(CONFIG).roleFor('a b&c')
  check('user id is URL-encoded', calls[0].includes('a%20b%26c'))
}

globalThis.fetch = realFetch
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
