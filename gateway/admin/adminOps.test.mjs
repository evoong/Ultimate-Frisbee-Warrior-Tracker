import { z } from 'zod'
import { AdminOpError, createRegistry, defineOperation, dispatchOperation } from './operations.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// Every audit write goes through sbWrite to /admin_audit_log, so capturing
// fetch is enough to assert exactly what the dispatcher logged.
const realFetch = globalThis.fetch
function capture() {
  const audits = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/admin_audit_log')) audits.push(JSON.parse(init.body))
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return audits
}

const CTX = {
  config: { supabaseUrl: 'https://example.test', supabaseSecretKey: 'secret' },
  adminId: '11111111-1111-1111-1111-111111111111',
  adminRole: 'support',
  requestId: 'req-1',
}

let applied = 0
const bump = defineOperation({
  name: 'bump',
  minRole: 'support',
  input: z.object({ id: z.number().int() }),
  target: i => ({ id: i.id }),
  preview: async () => ({ would: 'bump' }),
  apply: async (_ctx, i) => { applied++; return { before: { n: 1 }, after: { n: 2, id: i.id } } },
})

const nuke = defineOperation({
  name: 'nuke',
  minRole: 'superadmin',
  input: z.object({}),
  target: () => ({}),
  preview: async () => ({}),
  apply: async () => { throw new Error('kaboom') },
})

const registry = createRegistry([bump, nuke])

// --- happy path ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'bump', 'apply', { id: 7 })
  check('apply returns 200', res.status === 200)
  check('apply ran the operation', applied === 1)
  check('apply wrote exactly one audit row', audits.length === 1)
  check('audit result is ok', audits[0].result === 'ok')
  check('audit records the operation name', audits[0].operation === 'bump')
  check('audit records the admin id', audits[0].admin_id === CTX.adminId)
  check('audit denormalizes the role', audits[0].admin_role === 'support')
  check('audit carries the request id', audits[0].request_id === 'req-1')
  check('audit records before', audits[0].before.n === 1)
  check('audit records after', audits[0].after.n === 2)
  check('audit records the target', audits[0].target.id === 7)
}

// --- preview writes nothing at all ---
{
  applied = 0
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'bump', 'preview', { id: 7 })
  check('preview returns 200', res.status === 200)
  check('preview does not apply', applied === 0)
  check('preview writes no audit row', audits.length === 0)
}

// --- insufficient role is denied AND logged ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'nuke', 'apply', {})
  check('insufficient role returns 403', res.status === 403)
  check('a denial is audited', audits.length === 1 && audits[0].result === 'denied')
}

// --- a readonly admin cannot even preview a mutation ---
{
  const audits = capture()
  const ro = { ...CTX, adminRole: 'readonly' }
  const res = await dispatchOperation(registry, ro, 'bump', 'preview', { id: 1 })
  check('readonly cannot preview a support operation', res.status === 403)
  check('a denied preview is audited', audits.length === 1 && audits[0].result === 'denied')
}

// --- bad input is rejected and logged ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'bump', 'apply', { id: 'seven' })
  check('invalid input returns 400', res.status === 400)
  check('invalid input is audited as denied', audits.length === 1 && audits[0].result === 'denied')
}

// --- unknown operation ---
{
  const audits = capture()
  const res = await dispatchOperation(registry, CTX, 'no_such_op', 'apply', {})
  check('unknown operation returns 404', res.status === 404)
  check('an unknown operation writes no audit row', audits.length === 0)
}

// --- a throwing operation is logged as error, and the detail is not leaked ---
{
  const audits = capture()
  const su = { ...CTX, adminRole: 'superadmin' }
  const res = await dispatchOperation(registry, su, 'nuke', 'apply', {})
  check('a thrown operation returns 500', res.status === 500)
  check('the failure is audited as error', audits.length === 1 && audits[0].result === 'error')
  check('the audit row keeps the detail', audits[0].error.includes('kaboom'))
  check('the client response does not leak the detail',
        !JSON.stringify(res.body).includes('kaboom'))
  check('the client response carries the request id',
        JSON.stringify(res.body).includes('req-1'))
}

// --- AdminOpError chooses its own status and is safe to show the client ---
{
  const conflict = defineOperation({
    name: 'conflict',
    minRole: 'support',
    input: z.object({}),
    target: () => ({}),
    preview: async () => ({}),
    apply: async () => {
      throw new AdminOpError(
        'player 5 is already linked to user abc',
        409,
        'that player is already linked to another account'
      )
    },
  })
  const reg2 = createRegistry([conflict])
  const audits = capture()
  const res = await dispatchOperation(reg2, CTX, 'conflict', 'apply', {})
  check('AdminOpError sets the status', res.status === 409)
  check('a sub-500 AdminOpError audits as denied',
        audits.length === 1 && audits[0].result === 'denied')
  check('the audit row keeps the internal message',
        audits[0].error.includes('already linked to user abc'))
  check('the client sees only the clientMessage',
        JSON.stringify(res.body).includes('already linked to another account')
        && !JSON.stringify(res.body).includes('user abc'))
}

// --- operation definitions: schema and role wiring ---
{
  const { ADMIN_OPERATIONS } = await import('./ops.ts')
  const byName = new Map(ADMIN_OPERATIONS.map(o => [o.name, o]))

  check('all ten operations are registered', ADMIN_OPERATIONS.length === 10)
  for (const n of ['set_member_role', 'remove_member', 'invite_member', 'revoke_invite',
                   'set_player_link', 'approve_player_link', 'merge_players', 'delete_org',
                   'transfer_captainship', 'create_invite_link']) {
    check(`${n} is registered`, byName.has(n))
  }

  // Destructive operations are superadmin-only; routine support work is not.
  check('merge_players is superadmin', byName.get('merge_players').minRole === 'superadmin')
  check('delete_org is superadmin',    byName.get('delete_org').minRole === 'superadmin')
  check('set_member_role is support',  byName.get('set_member_role').minRole === 'support')
  check('transfer_captainship is superadmin', byName.get('transfer_captainship').minRole === 'superadmin')
  check('create_invite_link is support', byName.get('create_invite_link').minRole === 'support')

  const transfer = byName.get('transfer_captainship').input
  check('transfer_captainship requires a reason', !transfer.safeParse({
    org_id: 1, new_captain_user_id: '11111111-1111-4111-8111-111111111111' }).success)
  check('transfer_captainship requires a valid target UUID', !transfer.safeParse({
    org_id: 1, new_captain_user_id: 'nope', reason: 'Emergency ownership recovery' }).success)

  // team_invites.role forbids 'captain'; the schema must reject it up front
  // rather than letting a bare check-constraint error reach the operator.
  const inv = byName.get('invite_member').input
  check('invite_member accepts editor', inv.safeParse({ team_id: 1, email: 'a@b.co', role: 'editor' }).success)
  check('invite_member rejects captain', !inv.safeParse({ team_id: 1, email: 'a@b.co', role: 'captain' }).success)
  check('invite_member rejects a non-email', !inv.safeParse({ team_id: 1, email: 'nope', role: 'member' }).success)

  const smr = byName.get('set_member_role').input
  check('set_member_role accepts captain', smr.safeParse(
    { team_id: 1, user_id: '11111111-1111-4111-8111-111111111111', role: 'captain' }).success)
  check('set_member_role rejects an unknown role', !smr.safeParse(
    { team_id: 1, user_id: '11111111-1111-4111-8111-111111111111', role: 'wizard' }).success)
  check('set_member_role rejects a non-uuid user', !smr.safeParse(
    { team_id: 1, user_id: 'me', role: 'member' }).success)

  // delete_org demands the typed name, so a mis-click cannot destroy a tenant.
  const del = byName.get('delete_org').input
  check('delete_org requires confirm_name', !del.safeParse({ organization_id: 1 }).success)
  check('delete_org accepts a confirm_name', del.safeParse(
    { organization_id: 1, confirm_name: 'Warriors' }).success)

  // merge_players must refuse a self-merge before any SQL runs.
  const mp = byName.get('merge_players').input
  check('merge_players rejects a self-merge', !mp.safeParse({ keep_id: 5, merge_id: 5 }).success)
  check('merge_players accepts two distinct ids', mp.safeParse({ keep_id: 5, merge_id: 6 }).success)
}

// --- the last-captain trigger is translated, not leaked as a 500 ---
{
  const { ADMIN_OPERATIONS } = await import('./ops.ts')
  const setRole = ADMIN_OPERATIONS.find(o => o.name === 'set_member_role')
  const audits = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/admin_audit_log')) { audits.push(JSON.parse(init.body)); return new Response('[]', { status: 200 }) }
    // The pre-read finds the member...
    if (u.includes('/team_members') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify([{ team_id: 1, user_id: 'u', role: 'captain' }]),
                          { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // ...and the PATCH trips the trigger.
    return new Response('team 1 must have at least one captain', { status: 400 })
  }
  const reg = createRegistry([setRole])
  const su = { ...CTX, adminRole: 'superadmin' }
  const res = await dispatchOperation(reg, su, 'set_member_role', 'apply',
    { team_id: 1, user_id: '11111111-1111-4111-8111-111111111111', role: 'member' })
  check('a last-captain violation is a 409, not a 500', res.status === 409)
  check('the operator is told how to fix it',
        JSON.stringify(res.body).includes('at least one captain'))
  check('a last-captain violation audits as denied',
        audits.length === 1 && audits[0].result === 'denied')
}

globalThis.fetch = realFetch
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
