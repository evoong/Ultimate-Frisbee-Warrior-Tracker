// The ONLY way to mint a platform admin. Deliberately not a migration:
// migrations are committed to git and an operator's email does not belong
// there. Deliberately not an admin-console operation either -- a compromised
// admin session must not be able to create more admins.
//
// Usage: node --env-file=.env.local scripts/grant-platform-admin.mjs <email> <role>
//        node --env-file=.env       scripts/grant-platform-admin.mjs <email> <role>

const ROLES = ['superadmin', 'support', 'readonly']

const [email, role] = process.argv.slice(2)
if (!email || !ROLES.includes(role)) {
  console.error(`usage: grant-platform-admin.mjs <email> <${ROLES.join('|')}>`)
  process.exit(1)
}

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  process.exit(1)
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }

// GoTrue's admin list endpoint is the only way to resolve an email to a user
// id with the service role; auth.users is not exposed over REST. It is paged
// (per_page defaults to a small number and even 200 is not a real bound), so
// we must walk pages until GoTrue returns a short page -- otherwise a user
// past page 1 would be reported as "no user found", which reads as "this
// user doesn't exist" when the truth is "there are more pages we didn't
// check". MAX_PAGES is just a circuit breaker against a pathological/looping
// response; hitting it is reported distinctly from a genuine miss.
const PER_PAGE = 200
const MAX_PAGES = 500 // 100k users; a sane upper bound, not an expected size

let target
let page = 1
let sawLastPage = false
for (; page <= MAX_PAGES; page++) {
  const lookup = await fetch(
    `${url}/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`, { headers }
  )
  if (!lookup.ok) {
    console.error(`user lookup failed (${lookup.status}): ${await lookup.text()}`)
    process.exit(1)
  }
  const { users } = await lookup.json()
  target = users.find(u => (u.email ?? '').toLowerCase() === email.toLowerCase())
  if (target) break
  if (users.length < PER_PAGE) {
    sawLastPage = true
    break
  }
}

if (!target && !sawLastPage) {
  console.error(
    `gave up after ${MAX_PAGES} pages (${MAX_PAGES * PER_PAGE} users) without finding ` +
    `${email} or reaching the last page -- this is NOT the same as "no such user"; ` +
    `the search was inconclusive. Increase MAX_PAGES or investigate before assuming ` +
    `this user doesn't exist.`
  )
  process.exit(1)
}
if (!target) {
  console.error(`no user found with email ${email}`)
  process.exit(1)
}

const res = await fetch(`${url}/rest/v1/platform_admins?on_conflict=user_id`, {
  method: 'POST',
  headers: { ...headers, Prefer: 'return=representation,resolution=merge-duplicates' },
  body: JSON.stringify({ user_id: target.id, role, note: `granted via script for ${email}` }),
})
if (!res.ok) {
  console.error(`grant failed (${res.status}): ${await res.text()}`)
  process.exit(1)
}
console.log(`granted ${role} to ${email} (${target.id})`)
