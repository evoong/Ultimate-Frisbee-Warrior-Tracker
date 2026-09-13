// Cumulative Layout Shift for a cold, throttled load, over CDP against real
// headless Chrome.
//
// Five things here are load bearing:
//
// 1. No --virtual-time-budget. It runs timers but produces no rendering steps,
//    so rAF barely ticks, ResizeObserver never fires and layout-shift entries
//    never arrive. Every Swap reads as stuck at its old height and the run
//    reports a broken app that is not broken.
// 2. Observers are parked on a live reference. An unreferenced
//    PerformanceObserver is collectable, and over a long settle it does get
//    collected, after which the run reports nulls while
//    performance.getEntriesByType() shows the entries plainly. Note that the
//    accumulated s.cls / s.shifts these observers build up are never actually
//    read -- the final evaluate below recomputes both straight from
//    performance.getEntriesByType('layout-shift'). The observers exist only
//    to keep those entries from being garbage collected before the script
//    reads the timeline; they do not supply the reported number themselves.
// 3. DOM work is deferred until document.documentElement exists.
//    addScriptToEvaluateOnNewDocument runs before the document is parsed, so
//    touching documentElement throws and takes the rest of the script with it.
//    The injected script below never touches the DOM at all -- it only calls
//    PerformanceObserver and reads performance.* -- so this precaution has no
//    code path here to point at. It is recorded anyway because it is a real
//    trap for anyone who extends this script to also assert on rendered
//    content; do not go looking for deferral logic in the code below, there
//    is none because there is nothing here that needs it yet.
// 4. The tab is activated. A background tab suspends rAF even though painting
//    still happens.
// 5. cls: 0 is not proof of a stable layout. Headless Chrome without access to
//    a real display server advertises 'layout-shift' in
//    PerformanceObserver.supportedEntryTypes and accepts the observe() call
//    below, but records nothing through it: a page that demonstrably shifts
//    on screen still comes back with cls: 0 and an empty shift list, and
//    Chrome's own stderr shows "CVDisplayLinkCreateWithCGDisplay failed" when
//    this happens. The observer registration above also sits inside a
//    try/catch, which would silently swallow a registration failure on top of
//    that. So a cls: 0 reading from this script means nothing on its own --
//    it is indistinguishable from an environment that cannot record shifts at
//    all -- until this same harness has been run against a fixture built to
//    shift and shown to report something non-zero. A CI job wired to this
//    script must run that positive control first, or it will pass forever
//    while catching nothing.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL_TO_LOAD = process.argv[2]
const LABEL = process.argv[3] || 'run'
const SETTLE_MS = Number(process.argv[4] || 15000)

// Lighthouse Slow 4G, plus 4x CPU. At full speed the windows being measured
// barely exist and a regression is invisible.
const NET = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }

const INIT = `
(() => {
  const s = { fcp: null, lcp: null, cls: 0, shifts: [], keep: [] };
  window.__m = s;
  try {
    const po = new PerformanceObserver(l => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') s.fcp = e.startTime;
    });
    po.observe({ type: 'paint', buffered: true });
    s.keep.push(po);
    const lo = new PerformanceObserver(l => { for (const e of l.getEntries()) s.lcp = e.startTime; });
    lo.observe({ type: 'largest-contentful-paint', buffered: true });
    s.keep.push(lo);
    const co = new PerformanceObserver(l => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        s.cls += e.value;
        s.shifts.push({ t: Math.round(e.startTime), v: Number(e.value.toFixed(4)) });
      }
    });
    co.observe({ type: 'layout-shift', buffered: true });
    s.keep.push(co);
  } catch (e) {}
})();
`

const sleep = ms => new Promise(r => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'cls-'))
const port = 9400 + Math.floor(Math.random() * 300)

// Everything from the spawn onward can fail mid-flight -- Chrome's own binary
// missing, a bad CDP response, a socket error, Chrome never exposing its
// debug port -- and this script is meant to be run over and over for
// regression detection, so a failed run must not leave an orphaned Chrome
// process or temp profile behind for the next one. The try/finally is the
// only thing that guarantees that; cleanup must not live after the last
// await in the happy path, because it would never run on any of those
// failures.
let chrome
let ws
let exitCode = 0
try {
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' })
  // A missing or unexecutable CHROME_PATH delivers an ENOENT/EACCES as an
  // async 'error' event on the child process, not as a thrown exception --
  // an unhandled one crashes the whole script before this try/finally ever
  // gets a chance to run. Capturing it here instead of letting it throw is
  // what lets the polling loop below notice it and fail through the normal
  // cleanup path.
  let spawnError = null
  chrome.on('error', err => { spawnError = err })

  let wsUrl
  for (let i = 0; i < 60 && !wsUrl && !spawnError; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl
    } catch {}
    if (!wsUrl && !spawnError) await sleep(250)
  }
  if (spawnError) {
    console.error(spawnError.stack || String(spawnError))
    exitCode = 1
    throw spawnError
  }
  if (!wsUrl) {
    console.error('chrome did not start')
    exitCode = 1
    throw new Error('chrome did not start')
  }

  ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  }
  const send = (method, params = {}, sessionId) => {
    const msgId = ++id
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params, sessionId }))
    })
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Target.activateTarget', { targetId })
  const S = (m, p) => send(m, p, sessionId)

  await S('Page.enable')
  await S('Network.enable')
  await S('Runtime.enable')
  await S('Network.setCacheDisabled', { cacheDisabled: true })
  await S('Network.clearBrowserCache')
  await S('Network.emulateNetworkConditions', NET)
  await S('Emulation.setCPUThrottlingRate', { rate: 4 })
  await S('Page.addScriptToEvaluateOnNewDocument', { source: INIT })
  await S('Page.navigate', { url: URL_TO_LOAD })
  await sleep(SETTLE_MS)

  const { result } = await S('Runtime.evaluate', {
    expression: `JSON.stringify({
      fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime ?? null,
      lcp: (window.__m || {}).lcp ?? null,
      cls: performance.getEntriesByType('layout-shift').filter(e => !e.hadRecentInput).reduce((a, e) => a + e.value, 0),
      shifts: performance.getEntriesByType('layout-shift').filter(e => !e.hadRecentInput)
        .map(e => ({ t: Math.round(e.startTime), v: Number(e.value.toFixed(4)) })).slice(0, 12),
    })`,
    returnByValue: true,
  })
  const m = JSON.parse(result.value)
  console.log(JSON.stringify({
    label: LABEL,
    url: URL_TO_LOAD,
    cls: Number(m.cls.toFixed(4)),
    fcp_ms: m.fcp == null ? null : Math.round(m.fcp),
    lcp_ms: m.lcp == null ? null : Math.round(m.lcp),
    shifts: m.shifts,
  }, null, 2))
} catch (err) {
  if (exitCode === 0) {
    console.error(err && err.stack ? err.stack : String(err))
    exitCode = 1
  }
} finally {
  // Each step here is independently fault tolerant: a failure closing the
  // socket must not skip killing Chrome, and a failure killing Chrome must
  // not skip removing the profile directory.
  try { ws && ws.close() } catch {}
  try { chrome && chrome.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

process.exit(exitCode)
