import { CHAT_FUNCTION_DECLARATIONS, WRITE_FUNCTIONS } from './gameActions.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// This is the invariant that can actually fail. Task 5's guard in chat.ts
// gates writes on `WRITE_FUNCTIONS.has(call.name!)` -- a plain string set,
// disconnected at the type level from CHAT_FUNCTION_DECLARATIONS. Nothing
// stops WRITE_FUNCTIONS from drifting out of sync with the real function
// list (a typo'd name, a new handler nobody added to the set, a renamed
// declaration). These tests catch that drift structurally, without needing
// a live Supabase stack or a below-member role (which does not exist in the
// TeamRole type -- see the report for why the guard's blocking branch
// itself is untested).

const declaredNames = CHAT_FUNCTION_DECLARATIONS.map(d => d.name)

// The one read-only function today. Kept as an explicit constant (rather
// than "everything not in WRITE_FUNCTIONS") so check 3 below actually
// proves every declared name is accounted for by *someone's* classification,
// not just vacuously true because WRITE_FUNCTIONS is treated as complete by
// definition.
const READ_ONLY_FUNCTIONS = new Set(['query_stat_breakdown'])

// 1. Every name in WRITE_FUNCTIONS is a real declared function. This is
// exactly the failure the brief's fabricated list (recordEvent, updateScore,
// createGame, updateGame, deleteEvent -- none of which exist) would have
// caused: a guard that matches nothing and silently leaves every write
// ungated.
for (const name of WRITE_FUNCTIONS) {
  check(`WRITE_FUNCTIONS name "${name}" is a real declared function`,
    declaredNames.includes(name))
}

// 2. The one read-only function must never be gated as a write.
check('query_stat_breakdown is NOT in WRITE_FUNCTIONS',
  !WRITE_FUNCTIONS.has('query_stat_breakdown'))

// 3. Every declared function is classified as exactly one of
// WRITE_FUNCTIONS or READ_ONLY_FUNCTIONS. This is the one that fails the
// day someone adds a sixth handler and forgets to list it anywhere --  the
// real hazard of an explicit list.
for (const name of declaredNames) {
  const inWrite = WRITE_FUNCTIONS.has(name)
  const inReadOnly = READ_ONLY_FUNCTIONS.has(name)
  check(`declared function "${name}" is classified exactly once (write xor read-only)`,
    inWrite !== inReadOnly)
}

// Same check from the other direction: nothing in either classification
// set names a function that isn't actually declared (catches a stale entry
// left behind after a handler is removed or renamed).
for (const name of [...WRITE_FUNCTIONS, ...READ_ONLY_FUNCTIONS]) {
  check(`classified name "${name}" corresponds to a declared function`,
    declaredNames.includes(name))
}

check('declared function count equals WRITE_FUNCTIONS + READ_ONLY_FUNCTIONS count',
  declaredNames.length === WRITE_FUNCTIONS.size + READ_ONLY_FUNCTIONS.size)

process.exit(failed ? 1 : 0)
