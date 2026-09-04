// One-shot production cutover. Run AFTER migrations are applied.
//   CUTOVER_CONFIRM=1 node --env-file=.env scripts/cutover-production.mjs
// Idempotent: safe to re-run.
//
// Guard: this script writes to whatever SUPABASE_URL resolves to. Because
// production is its entire purpose, it cannot refuse a non-local host the
// way scripts/seed-local-users.mjs does -- but it requires an explicit
// CUTOVER_CONFIRM=1 opt-in before touching anything but localhost/127.0.0.1.
// Local rehearsal (--env-file=.env.local, host 127.0.0.1) needs no
// confirmation and stays frictionless.
//
// Warning: this makes persistent writes, not a rolled-back transaction. A
// local rehearsal leaves a second captain (captain@local.test AND
// eric@venn.ca) on team 1, a renamed team, and an eric@venn.ca account in
// the local database -- which fails several files in the pgTAP suite
// (13_escalation.test.sql among them, since it needs a sole captain to
// removal-test against). This is expected, not a regression. Always run
// `npm run db:reset` after rehearsing and confirm `npm run db:test` is
// green again before doing anything else.
import { createClient } from '@supabase/supabase-js'

const CAPTAIN_EMAIL = 'eric@venn.ca'
const TEAM_ID = 1
const TEAM_NAME = 'Disc-iples'
const INVITE_EMAILS = ['scruffy.selling@gmail.com', 'riceboxrandompurchases@gmail.com']

const SUPABASE_URL = process.env.SUPABASE_URL
if (!SUPABASE_URL) {
  console.error('SUPABASE_URL is required')
  process.exit(1)
}

const resolvedHost = new URL(SUPABASE_URL).hostname
console.log(`resolved SUPABASE_URL host: ${resolvedHost}`)

const isLocal = resolvedHost === 'localhost' || resolvedHost === '127.0.0.1'
if (!isLocal && process.env.CUTOVER_CONFIRM !== '1') {
  console.error(
    `refusing to run against non-local host "${resolvedHost}" without CUTOVER_CONFIRM=1. ` +
    `Set CUTOVER_CONFIRM=1 in the environment to proceed against production.`
  )
  process.exit(1)
}

const db = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)

// 1. eric@venn.ca was hardcoded as owner in migration 016 but has no
//    account, so uid-keyed membership has nothing to point at. Creating
//    the account is also the stronger posture: an address that already
//    exists cannot be signed up by someone else to claim the captaincy.
const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 })
let captain = existing.users.find(u => u.email?.toLowerCase() === CAPTAIN_EMAIL)
if (!captain) {
  const { data, error } = await db.auth.admin.createUser({
    email: CAPTAIN_EMAIL,
    email_confirm: true,
  })
  if (error) throw new Error(`createUser: ${error.message}`)
  captain = data.user
  console.log(`created captain account ${CAPTAIN_EMAIL} -> ${captain.id}`)
} else {
  console.log(`captain account already exists -> ${captain.id}`)
}

// 2. Captain row, and the rename.
const { error: memberErr } = await db.from('team_members')
  .upsert({ team_id: TEAM_ID, user_id: captain.id, role: 'captain' },
          { onConflict: 'team_id,user_id' })
if (memberErr) throw new Error(`team_members: ${memberErr.message}`)

const { error: nameErr } = await db.from('organizations')
  .update({ name: TEAM_NAME }).eq('id', TEAM_ID)
if (nameErr) throw new Error(`rename: ${nameErr.message}`)
console.log(`team ${TEAM_ID} renamed to ${TEAM_NAME}, captain assigned`)

// 3. Accounts that hold no membership keep the access they have under 017,
//    as a pending invite rather than an abrupt cut.
//
//    team_invites' only uniqueness on (team_id, email) is the partial
//    index `team_invites_pending_unique ... where accepted_at is null`, so
//    PostgREST's upsert (which emits a plain ON CONFLICT (team_id, email)
//    with no predicate) cannot match it -- Postgres rejects that as
//    error 42P10, "no unique or exclusion constraint matching the ON
//    CONFLICT specification". Express the same idempotence by hand:
//    look for a pending invite first, update it if found, insert if not.
for (const email of INVITE_EMAILS) {
  const expiresAt = new Date(Date.now() + 90 * 864e5).toISOString()

  const { data: pending, error: selectErr } = await db.from('team_invites')
    .select('id')
    .eq('team_id', TEAM_ID)
    .eq('email', email)
    .is('accepted_at', null)
    .maybeSingle()
  if (selectErr) throw new Error(`invite lookup ${email}: ${selectErr.message}`)

  if (pending) {
    const { error } = await db.from('team_invites')
      .update({ expires_at: expiresAt })
      .eq('id', pending.id)
    if (error) throw new Error(`invite update ${email}: ${error.message}`)
    console.log(`pending invite refreshed for ${email}`)
  } else {
    const { error } = await db.from('team_invites').insert({
      team_id: TEAM_ID,
      email,
      role: 'member',
      invited_by: null,
      expires_at: expiresAt,
    })
    if (error) throw new Error(`invite insert ${email}: ${error.message}`)
    console.log(`pending invite created for ${email}`)
  }
}

// 4. Report, so the operator can eyeball the end state.
const { data: members } = await db.from('team_members').select('role').eq('team_id', TEAM_ID)
const { data: invites } = await db.from('team_invites')
  .select('email').eq('team_id', TEAM_ID).is('accepted_at', null)
console.log(`\nfinal state: ${members.length} members, ${invites.length} pending invites`)
if (!isLocal) {
  console.log('expected (production): 10 members, 3 pending invites')
}
