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

globalThis.fetch = realFetch
console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
