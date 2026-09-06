import { tallyFor } from './feedbackStore.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

const CONFIG = { supabaseUrl: 'http://stub.invalid', supabaseSecretKey: 'stub' }

function withRows(rows, fn) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => rows, text: async () => '',
  })
  return fn().finally(() => { globalThis.fetch = realFetch })
}

// One user, three submissions. If this ever counts 3, one person can
// unilaterally dispatch an agent at production code.
const repeat = await withRows(
  [
    { reporter_user_id: 'u1', variant_label: null },
    { reporter_user_id: 'u1', variant_label: null },
    { reporter_user_id: 'u1', variant_label: null },
  ],
  () => tallyFor(CONFIG, 1)
)
check('three submissions from one reporter count as one', repeat[0].reporters === 1)

// Distinct reporters split across variants are tallied per variant.
const variants = await withRows(
  [
    { reporter_user_id: 'u1', variant_label: 'sidebar-left' },
    { reporter_user_id: 'u2', variant_label: 'sidebar-left' },
    { reporter_user_id: 'u3', variant_label: 'sidebar-right' },
  ],
  () => tallyFor(CONFIG, 1)
)
const left = variants.find(v => v.label === 'sidebar-left')
const right = variants.find(v => v.label === 'sidebar-right')
check('variants are tallied separately', left.reporters === 2 && right.reporters === 1)

// The same person on both sides counts once per side, never twice on one.
const bothSides = await withRows(
  [
    { reporter_user_id: 'u1', variant_label: 'sidebar-left' },
    { reporter_user_id: 'u1', variant_label: 'sidebar-right' },
  ],
  () => tallyFor(CONFIG, 1)
)
check('one reporter on two variants counts once on each',
  bothSides.every(v => v.reporters === 1))

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
