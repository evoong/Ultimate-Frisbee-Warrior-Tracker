import { readFileSync } from 'node:fs'
import { createMembershipLookup, hasAtLeast } from './membership.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// --- hasAtLeast: pure rank comparison ---

check('captain satisfies member',   hasAtLeast('captain', 'member') === true)
check('captain satisfies editor',   hasAtLeast('captain', 'editor') === true)
check('editor satisfies member',    hasAtLeast('editor', 'member') === true)
check('editor does not satisfy captain', hasAtLeast('editor', 'captain') === false)
check('member does not satisfy editor',  hasAtLeast('member', 'editor') === false)
check('no membership satisfies nothing', hasAtLeast(null, 'member') === false)

// --- createMembershipLookup: real queries against the local stack ---
//
// Skipping is not an option here: an unreachable stack must fail this file
// loudly (a thrown error / non-zero exit), never pass by silently doing
// nothing. That is exactly the empty-table-reads-as-success failure mode
// this project has been bitten by before.

function loadLocalEnv() {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  const env = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

const env = loadLocalEnv()
const supabaseUrl = env.SUPABASE_URL
const supabaseSecretKey = env.SUPABASE_SECRET_KEY

if (!supabaseUrl || !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(supabaseUrl)) {
  throw new Error(
    `gateway/membership.test.mjs requires a local Supabase URL in .env.local, got: ${supabaseUrl ?? '(missing)'}`
  )
}
if (!supabaseSecretKey) {
  throw new Error('gateway/membership.test.mjs requires SUPABASE_SECRET_KEY in .env.local')
}

// Resolve seeded user ids at test time (they change on every db:reset)
// via GoTrue's admin users endpoint. The endpoint's `email` query param is
// not an actual server-side filter (it returns the whole user list
// regardless), so filter client-side instead of trusting it.
async function resolveUserId(email) {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    headers: { apikey: supabaseSecretKey, Authorization: `Bearer ${supabaseSecretKey}` },
  })
  if (!res.ok) {
    throw new Error(`could not list local users to resolve ${email}: HTTP ${res.status}`)
  }
  const body = await res.json()
  const user = (body.users ?? []).find(u => u.email === email)
  if (!user) {
    throw new Error(`local stack has no seeded user ${email} -- run \`npm run db:reset\` first`)
  }
  return user.id
}

const captainId = await resolveUserId('captain@local.test')
const editorId = await resolveUserId('editor@local.test')
const outsiderId = await resolveUserId('outsider@local.test')

// Sanity check against the fixture described in the seed script, so a
// broken resolveUserId fails loudly here rather than producing confusing
// downstream failures.
check('resolved distinct ids for captain/editor/outsider',
  new Set([captainId, editorId, outsiderId]).size === 3)

// --- roleFor / teamsFor against the real seeded fixture ---

const lookup = createMembershipLookup({ supabaseUrl, supabaseSecretKey })

check('captain is captain of team 1',
  await lookup.roleFor(captainId, 1) === 'captain')
check('captain has no role on team 2',
  await lookup.roleFor(captainId, 2) === null)

const captainTeams = await lookup.teamsFor(captainId)
check('teamsFor(captain) returns exactly team 1 as captain',
  JSON.stringify(captainTeams) === JSON.stringify([{ team_id: 1, role: 'captain' }]))

const outsiderTeams = await lookup.teamsFor(outsiderId)
check('teamsFor(outsider) returns exactly team 2 as captain',
  JSON.stringify(outsiderTeams) === JSON.stringify([{ team_id: 2, role: 'captain' }]))

// --- fail-closed: an unavailable lookup must never read as "allowed" ---
//
// This is the single most important test in the file. If a non-ok response
// from PostgREST were ever mistaken for "no rows" (e.g. by not checking
// res.ok, or by treating a parse failure as []-but-cached, or by throwing
// and letting a caller's catch block default to "allow"), this is what
// would catch it: a bad key must produce HTTP 401, and the lookup must map
// that to an empty, non-cached result rather than throwing or reading as
// membership.
const brokenLookup = createMembershipLookup({
  supabaseUrl,
  supabaseSecretKey: 'sb_secret_deliberately_invalid_key',
})
const failClosedTeams = await brokenLookup.teamsFor(captainId)
check('fail-closed: bad secret key -> teamsFor returns [] rather than throwing or allowing',
  Array.isArray(failClosedTeams) && failClosedTeams.length === 0)
const failClosedRole = await brokenLookup.roleFor(captainId, 1)
check('fail-closed: bad secret key -> roleFor returns null rather than throwing or allowing',
  failClosedRole === null)

// --- no memberships at all ---

const anonId = '99999999-9999-9999-9999-999999999999'
const anonTeams = await lookup.teamsFor(anonId)
check('user with no memberships -> teamsFor returns []',
  Array.isArray(anonTeams) && anonTeams.length === 0)
const anonRole = await lookup.roleFor(anonId, 1)
check('user with no memberships -> roleFor returns null',
  anonRole === null)

process.exit(failed ? 1 : 0)
