import { runJamSync } from './jamSync.ts'

let failed = 0
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'}  ${name}`)
  if (!cond) failed++
}

// runJamSync runs under the service-role key, so the team filter is the only
// thing standing between a caller and every team's data. These tests intercept
// global fetch and assert on the URLs it actually builds.
const CONFIG = { supabaseUrl: 'http://stub.invalid', supabaseSecretKey: 'stub' }

async function urlsFor(options) {
  const urls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { ok: true, status: 200, json: async () => [], text: async () => '' }
  }
  try {
    const result = await (options === undefined
      ? runJamSync(CONFIG)
      : runJamSync(CONFIG, options))
    return { urls, result }
  } finally {
    globalThis.fetch = realFetch
  }
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

console.log(failed === 0 ? '\nall jamSync checks passed' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
