// Creates the six test identities against the LOCAL Supabase only.
// Refuses to run against anything else.
const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_SECRET_KEY

if (!/127\.0\.0\.1|localhost/.test(URL)) {
  console.error(`refusing to seed users against non-local URL: ${URL}`)
  process.exit(1)
}
if (!KEY) {
  console.error('SUPABASE_SECRET_KEY is required (see `supabase status`)')
  process.exit(1)
}

const USERS = [
  'captain@local.test',
  'editor@local.test',
  'member@local.test',
  'unlinked@local.test',
  'outsider@local.test',
]

async function api(path, init) {
  const res = await fetch(`${URL}${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

for (const email of USERS) {
  const { status, body } = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'localdev123', email_confirm: true }),
  })
  console.log(status < 300 ? `created ${email} ${body.id}` : `skip ${email}: ${JSON.stringify(body)}`)
}

// A real anonymous user, so guest behavior is exercised against the same
// shape production produces rather than a hand-faked JWT claim.
const anon = await fetch(`${URL}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
})
console.log('anonymous user:', anon.status)
