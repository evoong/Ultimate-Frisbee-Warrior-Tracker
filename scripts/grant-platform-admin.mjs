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
// id with the service role; auth.users is not exposed over REST.
const lookup = await fetch(
  `${url}/auth/v1/admin/users?page=1&per_page=200`, { headers }
)
if (!lookup.ok) {
  console.error(`user lookup failed (${lookup.status}): ${await lookup.text()}`)
  process.exit(1)
}
const { users } = await lookup.json()
const target = users.find(u => (u.email ?? '').toLowerCase() === email.toLowerCase())
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
