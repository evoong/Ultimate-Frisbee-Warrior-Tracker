# App-wide loading states

Design doc. 2026-09-13.

Style rule for this file and everything it produces: no em dashes, no emojis,
in prose or in code comments (CLAUDE.md rule, restated in
`.claude/commands/commit.md`).

## The problem

The reported symptom was narrow: on the Stats page the leaderboard appears
first and the KPI cards land above it a moment later, pushing the leaderboard
down. Reading the code showed that symptom is one instance of a general
condition, so the brief was widened to the whole app.

### The reported bug, exactly

On a cold load of `/stats`, three paints happen in sequence.

1. Mount. `useApiCall` starts `loading` at `false` (`hooks/backend/stats.ts:15`)
   and no fetch has fired yet, because the default season resolution at
   `pages/Stats.tsx:154` is still waiting on three parallel queries. So
   `rangePending` is `false` with no data, which every panel reads as *empty*
   rather than *loading*. The leaderboard renders "No stats available yet" at
   192px. The KPI row's gate at `pages/Stats.tsx:681`,
   `(playerLines.length > 0 || gamesInFilter > 0)`, is false, so the three
   cards are not in the DOM at all.
2. Seasons land, the default applies, `fetchStats` fires, `rangePending` flips
   true. Panels swap to their cold skeletons, and the KPI row appears out of
   nothing, inserting roughly 170px above the leaderboard and pushing the rest
   of the page down. This is the jolt that was reported.
3. Stats land and everything settles.

Two defects of the same class. The page has no representation of "nothing has
been requested yet", and the KPI row has no skeleton at all. The `cold`/`busy`/
`Swap` work from PR #139 covered every panel on the page except that row.

### The general condition

Four competing loading idioms, no shared convention.

| Idiom | Where |
| --- | --- |
| Layout matched skeletons | `Schedule.tsx:2647`, `RosterCardSkeleton`, `Strategy.tsx:971`, Stats panels |
| Centered "Loading..." text | `Schedule.tsx:1571`, `Roster.tsx:988`, `Roster.tsx:1065`, `Stats.tsx:998`, `PublicTeams.tsx:42` |
| Spinners | `Chat.tsx:158`, `App.tsx:97`, `App.tsx:36`, Roster photo upload |
| Nothing, so an empty state flashes | Stats cold load |

Three of the four page level skeletons have gone stale. Roster's
(`Roster.tsx:1164`) still draws two full width `h-10` bars for the
`SeasonMultiSelect` that PR #142 deleted. Strategy's (`Strategy.tsx:975`) draws
the same removed full width selector. Schedule's (`Schedule.tsx:2647`) is built
from pre-ledger shadcn `Card` markup while the real list below it is the
`schedule-scope` ledger with crest, identity, score and verdict grid tracks.
All three drifted during PRs #141 and #142, and nothing caught it.

The two pieces that already solve this well, `Swap`'s height glide and
`.st-swap`'s cross fade, are locked inside `.stats-scope` even though every
page has the same problem.

### The boot chain

Before any page renders, a signed in user sees three non app states.

1. `index.html` ships an empty `#root` and there is no inline theme script. The
   `dark` class is applied by a `useEffect` at `App.tsx:59`, after React mounts,
   so every dark mode user gets a white flash on every cold load.
2. `useAuth().loading` renders a full screen centered spinner (`App.tsx:97`).
3. The route chunk loads behind `PageFallback` (`App.tsx:36`), a second full
   screen centered spinner. The sidebar and nav that exist a moment later are
   absent, so the whole layout reflows when they arrive.

Critical path JavaScript before React can paint anything, including a
`Suspense` fallback:

| Chunk | Size |
| --- | --- |
| `vendor` | 797.1 KB |
| `vendor-supabase` | 198.3 KB |
| `vendor-react` | 174.1 KB |
| `vendor-radix` | 163.9 KB |
| `index` | 67.5 KB |
| `vendor-router` | 38.6 KB |

About 1.44 MB uncompressed. Measured transfer is 481 KB gzipped.

### Measured, not estimated

A throwaway spike measured this before any of the work was planned in detail.
Real headless Chrome over CDP, cold cache, Lighthouse Slow 4G (1.6 Mbit/s,
150ms RTT) and 4x CPU throttling, serving a production build over gzip. Three
runs per configuration, all within a few milliseconds of each other. The
patched column is a hand written approximation of section 1, built only to get
a number and then deleted.

| Metric | Baseline | With boot shell |
| --- | --- | --- |
| first-paint | 866 ms | 757 ms |
| First Contentful Paint | 2604 ms | 740 ms |
| Shell visible to the user | 2589 ms | 702 ms |
| Light background shown to a dark mode user | 1725 ms | 0 ms |
| Largest Contentful Paint | 3172 ms | 3300 ms |
| CLS | not recorded (see below) | not recorded (see below) |
| Transfer | 481 KB | 487 KB |
| index.html, gzipped | 3344 B | 4801 B |

So the app currently shows a dark mode user a near white empty page for 1.73
seconds, and shows nobody any content at all for 2.6 seconds. Both numbers are
removable. The cost is 1.4 KB of HTML.

Two results from the spike are load bearing and are carried into the design
below rather than left as trivia.

**LCP moved the wrong way, by 128 ms.** The boot shell becomes an LCP candidate
and is then replaced, which pushes the final LCP later. It is small and it
trades against a 1.86 second FCP improvement, but it is a real regression and
PR 3 must measure it rather than assume it away.

**The CLS readings in the table above are not evidence of anything, and that
is itself the finding.** Both columns report 0, and at the time that was read
as a fact about layout shift semantics: that removing a subtree and rendering a
different one scores zero however bad it looks. That reasoning is plausible but
it was not what produced these zeros.

Re-tested directly afterwards against a page built to shift -- a 120px block
inserted above existing content after 600ms, with a six second settle -- the
same harness still reported `cls: 0` with an empty shift list while FCP and LCP
came back normally at 204ms. A further probe found `layout-shift` present in
`PerformanceObserver.supportedEntryTypes`, and the DOM mutation confirmed to
have happened, and `performance.getEntriesByType('layout-shift')` still empty.
Chrome's own stderr shows `CVDisplayLinkCreateWithCGDisplay failed` throughout.

So headless Chrome in this environment advertises the Layout Instability API
and records nothing through it. Every CLS number gathered here is a null
reading wearing a plausible value, which is the most dangerous shape a
measurement can take.

Two consequences, both binding on the verification section below:

- **CLS must be measured somewhere with display server access** -- a normal
  terminal session on this machine, or Linux CI -- and never trusted from a
  sandboxed shell. A run that reports 0 must first prove it can report
  non-zero.
- **The claim that CLS is blind to the boot handoff is now unproven rather
  than established.** It may still be true on the semantics, and the screenshot
  comparison is still worth having, but this document must not present it as a
  measured result.

## Decisions

Settled with the user before design, recorded here because each one closes off
alternatives that would otherwise look reasonable later.

1. **Scope is the whole boot chain plus every page.** Not per page data loading
   alone. The boot flash is the loudest defect and no amount of per page
   skeleton work hides it.
2. **The first frame is an optimistic shell from a cached hint.** An inline
   script paints the real shell before React, using a hint persisted at login.
   Accepted cost: a user who signed out on another device sees their old shell
   for about 200ms before it resolves to Home.
3. **Behaviour is shared, appearance stays per scope.** `Swap` and the busy dim
   are promoted to scope agnostic primitives. Each visual system keeps writing
   its own skeleton shapes in its own tokens. This respects the rule in
   CLAUDE.md that the three visual systems do not collapse into one component,
   because the promoted code carries no colour. Verified: `.st-swap` is
   `transition: opacity 180ms ease` plus `opacity: .4`, `pointer-events: none`
   and `transition-delay: 140ms`; `.st-reveal` is `overflow: hidden` plus a two
   property transition. There is no colour token in either.
4. **Skeleton character stays as it is.** The existing `animate-pulse` shadcn
   `Skeleton` primitive is kept unchanged. Shimmer, static and a shallower
   breath were all shown as live comparisons and rejected. Consequence:
   `lib/shadcn/skeleton.tsx` is not modified by any of this work, and every new
   skeleton composes it.
5. **Boot skeletons are route aware.** Each route ships a skeleton shaped like
   itself rather than one generic arrangement of bars, so nothing in the body
   relayouts when the real page mounts.
6. **Content replaces a skeleton by cross fading in place**, 180ms, opacity
   only, nothing moves. Rejected: the current `FadeIn` behaviour, a 500ms fade
   while sliding up 8px, which is movement with no cause once a skeleton
   already occupies the space.
7. **`FadeIn` is flattened to opacity only**, with an opt in `slide` prop.
8. **No AI attribution in commits or PR bodies.** The user's standing rule,
   reaffirmed against this session's contrary system instruction.

## Architecture

### Two tiers of skeleton, on purpose

The boot skeleton must paint before the route chunk downloads, so it cannot
import anything from `pages/`. Importing a skeleton from `pages/Schedule.tsx`
would pull the whole 82 KB page chunk and defeat the purpose. That constraint,
not preference, is what forces two tiers.

**Boot tier.** Exactly five small route skeletons that live in the main bundle,
one per entry in `NAV_ITEMS` (`lib/nav.ts:29`): schedule, roster, stats,
strategy at `/playbook`, chat at `/coach`. Plus one generic fallback for
authenticated paths that are not nav items, such as `/teams`. Approximate by
necessity: a heading block and panel blocks holding the page's gross footprint.
Used by the pre React shell and by the `Suspense` fallback.

**Panel tier.** Precise skeletons co-located with the components they mirror,
used once the chunk is live. These land bar for bar on the content.

The handoff between tiers does not reflow because both render inside the same
already painted shell.

### Anti-drift

Co-location alone did not prevent the three stale skeletons, so two structural
rules do the work instead.

**Skeleton only what depends on the data. Render everything else for real.**
Page headers do not wait on a fetch. `<h1>Roster</h1>` is a string; the view
mode toggle, the Manage button and the season picker are static chrome. They
were being redrawn as grey bars purely because the skeleton was a whole page
substitute, and a redrawn thing is a thing that can drift. Page level skeletons
therefore stop replacing the page and start living inside it: real header, real
toolbar, real picker, skeletons only in the list or panel or board below. This
removes the entire drift class that produced the three stale skeletons, and it
is better in its own right because the page identifies itself immediately.

**Build skeletons from the real layout containers.** Where a skeleton genuinely
is data shaped, it renders the actual layout element with `Skeleton` in the leaf
slots only. `GameRowSkeleton` renders the real `.sch-row` grid driven by the
same `--sch-cols-sm` and `--sch-cols-md` custom properties, so adding a details
column moves the skeleton automatically.

## Section 1: the boot chain

### Inline script

A synchronous inline `<script>` in `<head>`, about 1 KB, running before first
paint. It does three things.

**Theme.** Read `ufwt_theme`, the same `THEME_KEY` already used at
`App.tsx:28`, fall back to `prefers-color-scheme`, set `.dark` on
`document.documentElement`. This kills the white flash for signed out visitors
too. The existing effect at `App.tsx:59` stays as the writer. The inline script
is only a reader, so there is one owner of the value.

**Shell hint.** Read `ufwt_shell`:

```
{ v: 1, signedIn: boolean, teamName: string, initials: string,
  route: string, collapsed: boolean }
```

`route` holds the `Tab` key from `lib/nav.ts`, not a raw pathname. A deep link
such as `/stats/rankings` or `/schedule/412` therefore still resolves to a boot
skeleton, through the same `tabForPath()` the nav already uses. Storing a raw
pathname would miss on every deep link, which is exactly the case a returning
user hits.

Written by `AuthContext` on resolve, on team switch and on route change.
Cleared on logout. Versioned, so a shape change invalidates rather than
corrupts. Every access wrapped in try/catch, because `localStorage` throws in a
private window and that must degrade to "no hint" rather than to a broken boot.

Nothing sensitive goes in the hint. Team name and initials are already on
screen for that user. No ids that grant anything, no email, no token. This is a
standing rule for the field, not a one time check, because hints accrete fields.

**Paint.** If `signedIn`, clone `<template data-boot="{route}">` into `#root`.
If not, leave `#root` empty: a signed out visitor is usually a first time
visitor with no hint to use, and Home and Login paint from React.

Three mechanics here were established by measurement and each one silently
costs the entire benefit if got wrong.

**The clone runs during parse, from an inline script placed after the templates
in the body. Never on `DOMContentLoaded`.** `type="module"` scripts are
deferred, and `DOMContentLoaded` waits for every deferred script to execute, so
hooking it makes the shell wait for the whole 481 KB bundle it exists to
precede. Measured: the `DOMContentLoaded` version left FCP completely unchanged
at 2.6 seconds while looking entirely correct in the source.

**The shell carries real text, not only grey bars.** First Contentful Paint
counts text, images, SVG and canvas. A `div` with a background colour is not
contentful, so a skeleton built purely from bars leaves FCP pinned to React's
first render however early the shell paints. Measured: bars only held FCP at
2604 ms with the shell visible from 702 ms; adding the page heading and the
team name moved FCP to 740 ms. The text is also the honest thing to show, and
it is what section 3's rule already requires, since a page title does not
depend on fetched data. So the shell renders:

- the page's own `<h1>`, from a route to title map;
- the team name and the product overline in the sidebar header, from the hint.

**Render blocking stylesheets set the floor.** Nothing paints, shell included,
until both `<link rel="stylesheet">` elements resolve: the built CSS chunk and
a third party request to `fonts.googleapis.com`. That floor is the 757 ms
first-paint above. Making the Google Fonts request non render blocking would
lower it further and is listed as a follow up rather than done here, because it
changes font loading behaviour for the whole app and deserves its own change.

### Templates are generated, not hand written

A small Vite plugin runs `renderToStaticMarkup` over the same
`<BootShell route={...} />` React components that serve as the `Suspense`
fallback, and injects the results as `<template>` elements in `index.html`.

This is the answer to drift for the boot tier. The pre React frame and the
React fallback are the same component, so they cannot disagree, and the handoff
at mount is visually a no-op. Cost is roughly 2 to 3 KB gzipped for five routes.

### Critical CSS

The token blocks and skeleton classes the boot markup needs, inlined as a
`<style>` in head, about 1.5 KB. Without it the boot markup paints unstyled,
which is worse than painting nothing.

### On mount

`App.tsx:97` (the auth spinner) and `App.tsx:36` (`PageFallback`) both become
`<BootShell route={...} />`. Both full screen spinners are deleted.

`createRoot().render()` replaces `#root`'s static children with React's render
of the identical tree in one frame. `hydrateRoot` is deliberately not used: it
would demand an exact match and import a class of hydration mismatch bugs for
no visual gain, since the markup is being replaced by an identical tree either
way.

## Section 2: shared primitives

**`Swap` moves up.** `components/stats/Swap.tsx` becomes `components/Swap.tsx`,
props unchanged (`busy`, `className`, `children`). Four import paths change:
`RankingsTable.tsx`, `ProgressionChart.tsx`, `ChemistryHub.tsx`,
`PerformanceChart.tsx`.

Its two documented traps travel verbatim in the comments, because both are
invisible until broken:

- A width change is treated as a window resize and applied instantly. Animated,
  the panel visibly lags a drag.
- The `-1` first measurement seed makes the first measurement count as a
  resize. Without it every panel glides up from zero on first paint.

**CSS promotion.** `.st-swap` and `.st-reveal` become `.ufwt-swap` and
`.ufwt-reveal` in `index.css`. Five call sites move with them. The `.st-` names
are deleted rather than aliased, because two names for one thing leaves the next
person unsure which to reach for. CLAUDE.md's Stats section documents these by
name and is updated in the same change.

**`Resolve`, a new primitive.** The existing pattern is a hard swap,
`cold ? <Skeleton/> : <Content/>`, so there is nothing on screen to fade from.
`Resolve` keeps both mounted for the handover:

```tsx
<Resolve loading={cold} skeleton={<LeaderboardSkeleton/>}>
  {realContent}
</Resolve>
```

When `loading` goes false it holds the skeleton in an absolutely positioned
overlay for 180ms at `opacity: 0` while the content goes 0 to 1 underneath. The
container is `position: relative`. The overlay unmounts after 180ms.

Two behaviours must be explicit, because both are reachable in normal use and
neither is the obvious default:

- If `loading` flips back to true while the overlay is still fading out, the
  pending timer is cleared and the skeleton is restored immediately. A range
  change landing inside 180ms of the previous one is common on Stats.
- Under `prefers-reduced-motion: reduce` the overlay is never mounted at all.
  Content replaces the skeleton in one frame. A zero duration transition that
  still mounts an overlay is a frame of stacked content for no benefit.

`Resolve` and `Swap` compose and own different things. `Swap` owns the height
change. `Resolve` owns the content change. Existing Stats panels already have
`Swap` and gain `Resolve` inside it.

**`FadeIn` flattened.** Today it runs
`fade-in slide-in-from-bottom-2 fill-mode-both duration-500`. Two problems. The
8px slide is movement with no cause once a skeleton occupies the space. And
`fill-mode: both` is exactly what caused the bug CLAUDE.md already warns about,
"the dim goes on a wrapper, never on a FadeIn": the animation keeps ownership of
`opacity` after it ends, so a transition on the same element silently never
runs. Keeping the current behaviour guarantees someone hits that again.

`FadeIn` becomes opacity only at 180ms, same curve as `Resolve`, with no
`fill-mode: both`. It gains an opt in `slide` prop. Twelve call sites across
five pages are reviewed. `FadeIn` is retired anywhere a skeleton precedes the
content and survives only for genuine entrances from nothing.

The single `slide` caller is Chat's per message list (`Chat.tsx:166`). A message
rising into a chat log is a real convention rather than decoration, so that one
keeps its movement.

**Reduced motion.** One global block in `index.css` covering `.ufwt-swap`,
`.ufwt-reveal`, `Resolve`'s classes and `FadeIn`, mirroring what
`stats-theme.css` already does at line 1123. Every new primitive collapses to
instant.

## Section 3: per surface work

### The read and write split

Stated once so it stops being decided ad hoc.

- **Skeletons** are for content arriving that will occupy space.
- **Inline progress** is for an action the user just initiated.

So every button spinner stays exactly as it is: `FeedbackDialog.tsx:204`,
`OrganizationSettingsDialog.tsx:331`, `OrganizationSettingsDialog.tsx:604`, and
"Creating..." at `Schedule.tsx:2503`. Chat's three bouncing dots
(`Chat.tsx:184`) stay as well. That is a response streaming in, not a panel
loading, and it is already the right idiom.

### Inventory

| Surface | Today | Change |
| --- | --- | --- |
| Boot theme, auth gate, route chunk | White flash, two full screen spinners | Section 1, `BootShell` |
| Stats cold load | Empty state flash, KPI row absent from the DOM | `rangePending` covers not started; `KpiSkeleton`, `MetricCardSkeleton` |
| Stats opponent history `Stats.tsx:998` | "Loading..." | Row skeletons |
| Schedule list `Schedule.tsx:2647` | Stale Card shape against the ledger | `GameRowSkeleton`, co-located, same grid tracks |
| Schedule events `Schedule.tsx:1571` | "Loading events..." | Event row skeletons |
| Roster page gate `Roster.tsx:1163` | Stale header | Real header plus `RosterCardSkeleton` body |
| Roster pairings `Roster.tsx:988` | "Loading..." | Skeletons |
| Roster stats `Roster.tsx:1065` | "Loading..." | Skeletons |
| Strategy gate `Strategy.tsx:971` | Stale header | Real header plus board and step skeletons |
| Chat history `Chat.tsx:158` | Spinner | Message bubble skeletons |
| PublicTeams `PublicTeams.tsx:42` | "Loading teams..." | Team row skeletons |
| Passkeys and OrgSettings dialogs | Generic `h-12` bars | Aligned to the real row shape |
| Every button during a write | Spinner | Unchanged |

### The Stats fix, specifically

`rangePending` becomes:

```
statsArr === undefined || loading || (tab === 'overview' && pairingsLoading)
```

Every panel below already has a `cold` branch and a `Swap`, so they all gain a
first paint skeleton from this one change, and "No stats available yet" stops
flashing before anything has been requested. `ProgressionChart` reads
`cumulativeLoading` and gets the same treatment against `cumulativeRaw`.

`KpiSkeleton` is added to `KpiBento.tsx`, built from the same
`.st-panel .st-kpi` classes as the real cards, so its height matches by
construction rather than by a guessed fixed height. The row renders skeleton
then cards instead of nothing then cards, wrapped in `Swap` so any residual
difference glides.

The Me tab gate at `Stats.tsx:641` gets the same treatment. It currently renders
one `Skeleton h-9` inside a panel at roughly 70px and then swaps it for an
`<h2>` plus a three card grid at roughly 140px, which is the identical push down
one tab over. `MetricCardSkeleton` matches the `SHOW_TURNOVERS` column count.

**`Roster.tsx:1162` is the reference implementation, not a parallel invention.**
Its gate, `players === undefined && (loading || awaitingSeasonDefault)`,
explicitly covers the window before the fetch fires while the season default
resolves. That is precisely what Stats is missing. Both sites should cite each
other.

## Verification

### The metric is CLS, measured for real

"Nothing jumped" has an exact standard definition and the browser computes it: a
`PerformanceObserver` on `layout-shift` entries. Cumulative shift for a cold
load of each route is the pass or fail number. Unlike sampling
`getBoundingClientRect()` on an interval, it cannot miss a shift between
samples. The target is effectively zero rather than the 0.1 "good" threshold,
because with skeletons that land where content lands any residual shift is a bug
with an address.

**A zero is only meaningful once the harness has proved it can report non
zero.** Headless Chrome without display server access advertises the Layout
Instability API and records nothing through it, so every run reads zero however
badly the page jumps. Before trusting any CLS figure, point the same harness at
a fixture built to shift and confirm it reports a non zero value. See the
measured-not-estimated section above for how this was learned.

### Driven over CDP against real headless Chrome

Both traps documented in CLAUDE.md bite this work specifically.

- **No `--virtual-time-budget`.** It runs timers but produces no rendering
  steps, so `rAF` barely ticks and ResizeObserver never fires. Every `Swap`
  reads as stuck at its old height and `layout-shift` entries never arrive. The
  measurement would report a broken app that is not broken.
- **No narrow viewport screenshots.** Chrome will not lay out below about 500px
  on macOS in either headless mode, so mobile verification is by measured
  geometry and `scrollWidth === clientWidth`, never by eye.

Conditions: `Network.emulateNetworkConditions` at Slow 4G and
`Emulation.setCPUThrottlingRate`. At full speed the windows being fixed barely
exist and the bug is invisible. Both themes, every route, cold cache.

### Assertions beyond CLS

1. **Theme at first paint.** `<html>` carries the correct class before anything
   from `/assets` executes. Binary, and it is the white flash fix. Measure the
   flash as `darkClassAt - firstPaint`, never as `darkClassAt - FCP`.
   first-paint is when the light background appears; FCP cannot happen until
   React renders, and React sets the class in that same tick, so measuring
   against FCP always reports approximately zero and hides the defect
   completely. The baseline number is 1725 ms and it must go to 0.
2. **FCP moves to the HTML.** Measured with and without the inline shell on a
   throttled cold cache. First Contentful Paint should stop waiting on 1.44 MB
   of JavaScript. This is the number that justifies section 1.
3. **Reduced motion.** With `prefers-reduced-motion: reduce` emulated, assert on
   `el.getAnimations()` durations rather than sampled frames, per CLAUDE.md.
4. **The boot to React handoff is a no-op.** Screenshot the last pre mount frame
   and the first post mount frame. They must be identical. This proves the
   shared `BootShell` removed the seam rather than moving it. Do not lean on CLS
   here: the zeros this document reported for the boot handoff came from an
   environment that records no layout shift at all, so whether CLS covers that
   seam is an open question rather than a settled one. The screenshot comparison
   is the check that does not depend on the answer.
5. **LCP did not regress further than measured.** The spike moved it from
   3172 ms to 3300 ms. Treat 3300 ms as the ceiling; if PR 3 lands worse than
   that, the shell is holding the LCP candidate too long and the largest block
   in it should shrink.

### Regression guard

Three skeletons went stale in one PR pair and nothing noticed, so co-location
is necessary but not sufficient. The CDP script is checked into `scripts/` and
added to `ci.yml` beside the existing frontend build at line 23, failing on a
per route CLS regression. This is the only part of the design that prevents a
repeat rather than fixing the current instance.

One precondition, learned the hard way: **the job must first prove it can
report a non-zero CLS.** Headless Chrome without display server access
advertises the Layout Instability API and records nothing through it, so a
guard running there would pass every future run while catching nothing, which
is worse than having no guard. Give the CI job a fixture page that shifts on
purpose and fail the build if that fixture reports zero. Linux CI runners
generally do record layout shift; a sandboxed macOS shell does not.

## Sequencing

Five PRs, each branched off `main`. Never pushed direct to `main`. No AI
attribution in commit messages or PR bodies.

1. **Primitives.** `Swap` promotion, `.ufwt-swap` and `.ufwt-reveal`, `Resolve`,
   `FadeIn` flattened with the `slide` opt in, the reduced motion block,
   CLAUDE.md updates. Unblocks everything. The only visible change is `FadeIn`'s
   motion.
2. **Stats.** The reported bug: not started `rangePending`, `KpiSkeleton`,
   `MetricCardSkeleton`, opponent history. Deliberately early so the thing that
   was actually asked for lands before the large refactor.
3. **Boot chain.** Inline script, hint, Vite plugin, `BootShell`, critical CSS,
   both spinners replaced. Highest risk, and it touches `index.html` plus build
   config, so it travels alone.
4. **Schedule, Roster, Strategy.** The three stale skeletons rebuilt on real
   header and skeleton body. Largest diff, lowest risk.
5. **Chat, PublicTeams, dialogs.** The tail.

Each PR carries the CLS measurement for the routes it touches, and each of
those measurements is preceded by the positive-control run described above. A
CLS figure gathered without it is not evidence.

## Out of scope

- **The 797 KB `vendor` chunk.** Trimming it would shrink the boot window at the
  source rather than papering over it, and it is very likely the single highest
  leverage follow up. Not in this work.
- **The render blocking `fonts.googleapis.com` stylesheet.** It sets the 757 ms
  first-paint floor that even the boot shell cannot beat, and it is a third
  party request on the critical path. Worth its own change, because making it
  non blocking changes font swap behaviour across the whole app.
- **Image and avatar CLS**, font swap reflow, route transition choreography, and
  optimistic UI for writes. All were offered and deliberately not selected.
- **`lib/shadcn/skeleton.tsx`.** Unchanged by decision 4.
- **Five Stats panels still hard-swap rather than cross-fading.**
  `PerformanceChart.tsx`, `RankingsTable.tsx`, `ChemistryHub.tsx`,
  `ProgressionChart.tsx` and `AssistMatrix.tsx` all gained `Swap` for the
  height transition but were not also brought onto `Resolve` for the content
  handover, so their skeletons still cut directly to content instead of
  cross-fading. Only the two KPI rows do both. This is a real gap against the
  "existing Stats panels already have `Swap` and gain `Resolve` inside it"
  statement above, noted here deliberately rather than fixed here: converting
  five panels is its own change and is deferred to a later PR.

## Risks

| Risk | Mitigation |
| --- | --- |
| Stale shell hint shows the wrong shell briefly | Accepted explicitly. Bounded to about 200ms, resolves to the correct page. |
| `localStorage` throws in a private window | Every access in try/catch, degrading to no hint. |
| Vite plugin adds `react-dom/server` to the build | Build time only, never shipped to the client. Verify it does not enter any client chunk. |
| Boot markup paints unstyled | Critical CSS inlined in head, asserted by the first paint screenshot. |
| Inlined templates grow `index.html` | Budgeted at 2 to 3 KB gzipped for five routes. Measure in PR 3 and reject growth beyond it. |
| `FadeIn` change has a blast radius beyond loading | Twelve call sites, all reviewed in PR 1. Chat keeps its slide through the opt in. |
| New skeletons drift again | Real header and skeleton body removes the class that drifted. CI CLS check catches the rest. |
