import { runJamSync } from './jamSync.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// runJamSync runs under the service-role key, so the team filter is the only
// thing standing between a caller and every team's data. These tests intercept
// global fetch: some assert on the URLs it builds, others drive per-call
// responses (by URL, Range header, and attempt) to exercise retry and paging.
const CONFIG = { supabaseUrl: 'http://stub.invalid', supabaseSecretKey: 'stub' }

const ok = (body) => ({ ok: true, status: 200, text: async () => (body == null ? '' : JSON.stringify(body)) })
const fail = (status) => ({ ok: false, status, text: async () => 'boom' })

async function runWith(handler, options) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  try {
    const result = await (options === undefined ? runJamSync(CONFIG) : runJamSync(CONFIG, options))
    return { calls, result }
  } finally {
    globalThis.fetch = realFetch
  }
}

async function urlsFor(options) {
  const { calls, result } = await runWith(() => ok([]), options)
  return { urls: calls.map((c) => c.url), result }
}

// --- the fail-open case: an empty allow-list must grant nothing ---
//
// The obvious `options.teamIds?.length ? filter : ''` is falsy for [], which
// would drop the filter and sync EVERY team. An empty allow-list turning into
// full access is the bug this file exists to prevent regressing.
const empty = await urlsFor({ teamIds: [] })
check('empty teamIds issues NO requests at all', empty.urls.length === 0)
check('empty teamIds reports zero sources', empty.result.sources === 0)
check('empty teamIds reports no errors', empty.result.errors.length === 0)

// --- the cron path: absent teamIds legitimately covers every team ---
const cron = await urlsFor(undefined)
check('cron path queries all four tables', cron.urls.length === 4)
check('cron path applies no team filter',
  cron.urls.every(u => !u.includes('organization_id=in.')))

// --- the scoped path: every query is filtered, not just calendar_sources ---
//
// syncSource matches games by jam_uid across whatever it is handed, so an
// unscoped games fetch would let a uid shared between two teams update the
// other team's row.
const scoped = await urlsFor({ teamIds: [1, 2] })
check('scoped path queries all four tables', scoped.urls.length === 4)
check('scoped path filters EVERY query',
  scoped.urls.every(u => u.includes('organization_id=in.(1,2)')))
check('scoped path filters calendar_sources',
  scoped.urls.some(u => u.includes('/calendar_sources') && u.includes('organization_id=in.(1,2)')))
check('scoped path filters games',
  scoped.urls.some(u => u.includes('/games') && u.includes('organization_id=in.(1,2)')))
check('scoped path filters seasons',
  scoped.urls.some(u => u.includes('/seasons') && u.includes('organization_id=in.(1,2)')))
check('scoped path filters jam_sync_conflicts',
  scoped.urls.some(u => u.includes('/jam_sync_conflicts') && u.includes('organization_id=in.(1,2)')))

// --- ids are coerced before being interpolated into the query string ---
const strings = await urlsFor({ teamIds: ['3', 4] })
check('numeric strings coerce to integers',
  strings.urls.every(u => u.includes('organization_id=in.(3,4)')))

const junk = await urlsFor({ teamIds: [1, '; drop table games; --', NaN, 2.5] })
check('non-integer ids are dropped, not interpolated',
  junk.urls.every(u => u.includes('organization_id=in.(1)')))
check('no injected text reaches the query string',
  junk.urls.every(u => !u.includes('drop table')))

// A list that is non-empty but entirely junk must sync NOTHING. Asserting
// merely "no filter in the URL" would PASS on the fail-open, since an
// unfiltered query has no filter in it either. Assert no request is made.
const allJunk = await urlsFor({ teamIds: ['nope'] })
check('all-invalid ids sync nothing rather than everything', allJunk.urls.length === 0)

// --- retry + paging: a transient blip must not abort the whole run ---
//
// The reads run in one Promise.all, so before retries a single 504 on any of
// them dropped the day's sync for every team.

// A 504 on a read is retried and the run recovers.
let gamesHits = 0
const retried = await runWith((url) => {
  if (!url.includes('/games')) return ok([])
  gamesHits++
  return gamesHits === 1 ? fail(504) : ok([])
})
check('a 504 on a read is retried, not fatal', gamesHits === 2)
check('the run recovers from a transient 504', retried.result.errors.length === 0)

// A network-level failure (no response at all) is retried too.
let seasonHits = 0
const netRetried = await runWith((url) => {
  if (!url.includes('/seasons')) return ok([])
  seasonHits++
  if (seasonHits === 1) throw new Error('ECONNRESET')
  return ok([])
})
check('a network error is retried', seasonHits === 2)
check('the run recovers from a network error', netRetried.result.errors.length === 0)

// A 4xx is a real error, not a transient one: no retry, and it aborts.
let badHits = 0
let aborted = false
try {
  await runWith((url) => {
    if (!url.includes('/games')) return ok([])
    badHits++
    return fail(400)
  })
} catch {
  aborted = true
}
check('a 4xx is not retried', badHits === 1)
check('a 4xx aborts the run rather than looping', aborted)

// The unbounded games read is paged: a full page asks for the next range.
const fullPage = Array.from({ length: 1000 }, (_, i) => ({ id: i }))
const ranges = []
await runWith((url, init) => {
  if (!url.includes('/games')) return ok([])
  const range = init?.headers?.Range
  ranges.push(range)
  return ok(range === '0-999' ? fullPage : [{ id: 1000 }])
})
check('a full page triggers a second range request', ranges.length === 2)
check('paging walks successive ranges', ranges[0] === '0-999' && ranges[1] === '1000-1999')

// When the total is an exact multiple of the page size, the trailing range
// answers 416 — that is "no next page", not an error.
let exactHits = 0
const exact = await runWith((url) => {
  if (!url.includes('/games')) return ok([])
  exactHits++
  return exactHits === 1 ? ok(fullPage) : fail(416)
})
check('a 416 on the trailing page stops paging instead of throwing',
  exactHits === 2 && exact.result.errors.length === 0)

console.log(failed === 0 ? '\nall jamSync checks passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
