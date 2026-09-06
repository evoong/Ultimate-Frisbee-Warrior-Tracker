import { decideEscalation, DISPATCH_THRESHOLD, CONFLICT_MARGIN } from './feedbackTriage.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// These rules decide whether user-submitted text becomes production code, so
// every boundary below is asserted rather than assumed. The counts passed in
// are DISTINCT reporters -- collapsing repeat submissions is the store's job,
// not this module's, but the constants only make sense under that reading.

// --- below threshold: nothing happens, for either type ---
check('2 reporters on a bug holds',
  decideEscalation('bug', [{ label: null, reporters: 2 }]).action === 'hold')
check('2 reporters on a feature holds',
  decideEscalation('feature', [{ label: null, reporters: 2 }]).action === 'hold')

// --- at threshold: bugs dispatch, features wait for a human ---
const bugAtThreshold = decideEscalation('bug', [{ label: null, reporters: 3 }])
check('3 reporters on a bug dispatches', bugAtThreshold.action === 'dispatch')
check('a non-conflicting dispatch carries no variant',
  bugAtThreshold.variantLabel === null)
check('3 reporters on a feature awaits approval',
  decideEscalation('feature', [{ label: null, reporters: 3 }]).action === 'await_approval')

// --- conflict with a decisive margin: the winner is named ---
const decisive = decideEscalation('bug', [
  { label: 'sidebar-left', reporters: 6 },
  { label: 'sidebar-right', reporters: 3 },
])
check('a 2x margin resolves the conflict', decisive.action === 'dispatch')
check('the resolved conflict names the winning variant',
  decisive.variantLabel === 'sidebar-left')

// --- conflict without a decisive margin: a human decides ---
// 4-vs-3 is the case the margin exists to catch: a bare majority would
// otherwise ship the losing half's least-favorite outcome unreviewed.
const narrow = decideEscalation('bug', [
  { label: 'sidebar-left', reporters: 4 },
  { label: 'sidebar-right', reporters: 3 },
])
check('a bare majority does NOT dispatch', narrow.action === 'decision_needed')
check('the decision_needed outcome carries the full tally',
  narrow.tally.length === 2)

// --- a conflict whose winner is decisive but under the minimum ---
// 2-vs-0 clears 2x trivially; it must still fail the 3-reporter floor.
check('a decisive margin under the reporter minimum holds',
  decideEscalation('bug', [
    { label: 'sidebar-left', reporters: 2 },
    { label: 'sidebar-right', reporters: 0 },
  ]).action === 'hold')

// --- a winning feature variant still requires approval ---
check('a resolved feature conflict still awaits approval',
  decideEscalation('feature', [
    { label: 'sidebar-left', reporters: 6 },
    { label: 'sidebar-right', reporters: 2 },
  ]).action === 'await_approval')

// --- the constants are the documented ones ---
check('dispatch threshold is 3', DISPATCH_THRESHOLD === 3)
check('conflict margin is 2x', CONFLICT_MARGIN === 2)

console.log(failed === 0 ? '\nall passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
