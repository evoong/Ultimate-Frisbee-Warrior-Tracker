import { handleAdminRead } from './reads.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// sbWrite/sbGet go through global fetch, so capturing it is enough to assert
// exactly which RPC fired and with which params.
const CONFIG = { supabaseUrl: 'https://example.test', supabaseSecretKey: 'secret' }
const CTX = { config: CONFIG, adminId: 'u1', adminRole: 'readonly', requestId: 'req-1' }
const realFetch = globalThis.fetch

function stubRpc(body) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      path: String(url).split('/rest/v1')[1],
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(body ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return calls
}

const ORGS_URL = 'https://example.test/api/admin/orgs'

async function orgs(query) {
  return handleAdminRead(CTX, ['orgs'], new URL(`${ORGS_URL}${query}`))
}

// --- orgs: limit clamping ---
{
  const calls = stubRpc({ rows: [], total: 0 })
  const res = await orgs('?limit=999')
  check('orgs limit=999 clamps to 200', res?.status === 200 && calls[0].body.p_limit === 200)
}
{
  const calls = stubRpc({ rows: [], total: 0 })
  const res = await orgs('?limit=abc')
  check('orgs limit=abc falls back to 50', res?.status === 200 && calls[0].body.p_limit === 50)
}
{
  const calls = stubRpc({ rows: [], total: 0 })
  await orgs('?limit=0')
  check('orgs limit=0 falls back to the default 50', calls[0].body.p_limit === 50)
}

// --- orgs: offset clamping ---
{
  const calls = stubRpc({ rows: [], total: 0 })
  const res = await orgs('?offset=-5')
  check('orgs negative offset clamps to 0', res?.status === 200 && calls[0].body.p_offset === 0)
}

// --- orgs: q passthrough, null when absent ---
{
  const calls = stubRpc({ rows: [], total: 0 })
  const res = await orgs('?q=jam')
  check('orgs q passes through', res?.status === 200 && calls[0].body.p_q === 'jam')
  check('orgs calls admin_list_organizations', calls[0].path === '/rpc/admin_list_organizations')
}
{
  const calls = stubRpc({ rows: [], total: 0 })
  const res = await orgs('')
  check('orgs absent q passes null', res?.status === 200
    && 'p_q' in calls[0].body && calls[0].body.p_q === null)
  check('orgs absent offset passes 0', calls[0].body.p_offset === 0)
}

// --- orgs: sort/dir passthrough ---
{
  const calls = stubRpc({ rows: [], total: 0 })
  await orgs('?sort=members&dir=desc')
  check('orgs sort and dir pass through', calls[0].body.p_sort === 'members' && calls[0].body.p_dir === 'desc')
}

// --- dashboard: invalid from/to is a 400, not an RPC call ---
{
  const calls = stubRpc({})
  const res = await handleAdminRead(CTX, ['dashboard'], new URL('https://example.test/api/admin/dashboard?from=not-a-date'))
  check('dashboard rejects a bad from with 400', res?.status === 400 && res.body.error === 'from must be YYYY-MM-DD')
  check('dashboard rejects a bad from without calling the RPC', calls.length === 0)
}
{
  const calls = stubRpc({})
  const res = await handleAdminRead(CTX, ['dashboard'], new URL('https://example.test/api/admin/dashboard?to=2026/09/01'))
  check('dashboard rejects a bad to with 400', res?.status === 400 && res.body.error === 'to must be YYYY-MM-DD')
  check('dashboard rejects a bad to without calling the RPC', calls.length === 0)
}

// --- dashboard: valid dates pass through ---
{
  const calls = stubRpc({})
  const res = await handleAdminRead(CTX, ['dashboard'],
    new URL('https://example.test/api/admin/dashboard?from=2026-08-26&to=2026-09-25&grain=week'))
  check('dashboard passes valid dates and grain through', res?.status === 200
    && calls[0].body.p_from === '2026-08-26' && calls[0].body.p_to === '2026-09-25'
    && calls[0].body.p_grain === 'week')
  check('dashboard calls admin_dashboard', calls[0].path === '/rpc/admin_dashboard')
}

// --- dashboard: absent from/to pass null, grain passes through as-is ---
{
  const calls = stubRpc({})
  const res = await handleAdminRead(CTX, ['dashboard'], new URL('https://example.test/api/admin/dashboard'))
  check('dashboard absent from/to pass null', res?.status === 200
    && calls[0].body.p_from === null && calls[0].body.p_to === null
    && 'p_grain' in calls[0].body)
}
{
  // No gateway-side grain validation: a bad grain must reach the RPC and let
  // its whitelist raise, rather than being silently dropped or 400'd here.
  const calls = stubRpc({})
  const res = await handleAdminRead(CTX, ['dashboard'],
    new URL('https://example.test/api/admin/dashboard?grain=fiscal-quarter'))
  check('dashboard passes an unknown grain through unchecked', res?.status === 200 && calls[0].body.p_grain === 'fiscal-quarter')
}

globalThis.fetch = realFetch
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
