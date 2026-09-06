import { tallyFor } from './feedbackStore.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

const CONFIG = { supabaseUrl: 'http://stub.invalid', supabaseSecretKey: 'stub' }

// `capture`, if given, receives the requested URL as `capture.url` -- letting
// tests assert on the query PostgREST actually received, not just on what
// the stub chose to hand back regardless of it.
function withRows(rows, fn, capture) {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (capture) capture.url = String(url)
    return { ok: true, status: 200, json: async () => rows, text: async () => '' }
  }
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

// The mock above returns canned rows regardless of the request URL, so none
// of the checks above would notice if tallyFor stopped filtering on
// counts_toward_threshold or stopped scoping by cluster id -- the stub can't
// tell the difference between a correct query and a broken one. Capture the
// actual URL and assert on it directly so a dropped/malformed/negated filter
// fails the suite instead of passing silently.
const capture = {}
await withRows(
  [{ reporter_user_id: 'u1', variant_label: null }],
  () => tallyFor(CONFIG, 42),
  capture
)
check('tallyFor requests counts_toward_threshold=is.true',
  capture.url.includes('counts_toward_threshold=is.true'))
check('tallyFor scopes the query to the given cluster id',
  capture.url.includes('cluster_id=eq.42'))

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
