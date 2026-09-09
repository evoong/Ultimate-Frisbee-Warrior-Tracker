# Ultimate Frisbee Warrior Tracker

## New-environment setup (do this in order)
1. `npm install` — root deps (Express server, gateway).
2. `cd frontend && npm install` — frontend has its **own** package.json/node_modules, separate from root. Both are required; root install alone leaves Vite unable to start.
3. Create `.env` in repo root (gitignored, not checked in) with:
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`, `GEMINI_API_KEY`, `SENTRY_DSN`.
   No `.env.example` exists — get real Supabase values from the Supabase dashboard (project `ultimate-frisbee-warrior-tracker`, ref `pyqngqyqwevfpaxcmfnd`, org `caypalgdyzpvqqecqhfd`, region `ca-central-1`) → Project Settings → API for the URL/keys, → Database for `DATABASE_URL`. `server/index.ts` throws at import time (crashes the whole process) if `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are blank — there's no graceful fallback. `SENTRY_DSN` is different: it's optional and safe to leave blank (`server/instrument.ts` only calls `Sentry.init` when it's set) — get the real value from the Sentry org `eric-4a`'s `ufwt-backend` project (Settings → Client Keys (DSN)) if you want backend error reporting locally.
   Also create `frontend/.env` (separate file, same gitignore treatment) with `VITE_SENTRY_DSN` — same optional/blank-is-fine rule, value comes from the `ufwt-frontend` Sentry project instead. The Cloudflare Worker's DSN (`SENTRY_DSN_WORKER`) needs no local setup — it's already committed as a plain `vars` entry in `wrangler.jsonc` since Sentry DSNs are public client keys, not secrets.
4. Start both dev servers from `.claude/launch.json`: "Express API Server" (port 3001) and "Vite Frontend" (port 5199, cwd `frontend`). The frontend alone will run but backend-dependent features (chat, uploads) need the Express server too.
5. Local JWT signing key: `npm run db:signing-key`. Do this **before** first
   starting the stack. Without it the local stack signs HS256 and serves an
   **empty** JWKS (`{"keys":[]}`), so `verifyAccessToken` in `gateway/jwt.ts`
   cannot verify any locally minted token and every gateway-authenticated
   request fails locally for a reason that looks like a code bug.
   `supabase/config.toml` points at `./signing_keys.json`, which is gitignored
   because it is a private key -- generate your own per clone.
6. Local database: `npm run db:start` (needs Docker), then `npm run db:reset`
   to load the baseline plus seed data and test identities. `npm run db:test`
   runs the pgTAP permission suite. Copy `.env.local.example` to `.env.local`
   and fill in the keys printed by `supabase status`. If you started the stack
   before step 5, restart it (`npm run db:stop && npm run db:start`) so GoTrue
   picks up the key.

## MCP server (AI tool access)
- `MCP_ORGANIZATION_ID` is required for the local stdio server
  (`mcp-server/index.ts`). It refuses to start without one, deliberately,
  because an accidental default of `1` is a cross-team leak. It must be a
  positive integer; the Worker agent enforces the same rule.
- For the hosted Worker agent (`gateway/mcpAgent.ts`), the OAuth-authenticated
  identity must be a member of that team, or no tools are registered at all.
- That membership is re-checked on **every tool call**, not only when the
  Durable Object wakes, so revoking a role takes effect within the lookup's
  30s cache rather than lasting for the life of the warm instance. The check is
  installed by wrapping the MCP SDK's `executeToolHandler`; if that seam ever
  disappears, `init()` throws rather than serving tools unguarded.

## Design system

The app ships **three** visual systems. Know which one you are in before
styling anything.

**Global (everything except the schedule list and the Stats page).** shadcn tokens in
`frontend/index.css`, retuned away from stock. Three things about them are
load-bearing:

- **The neutrals are genuinely neutral -- hue 0, saturation 0.** They used to
  be hue 240 at 4-6% saturation, which is shadcn's stock zinc/slate default
  and the single most recognisable tell of an unstyled shadcn app; it also put
  a faint blue cast under every surface. Do not reintroduce a hue here. A grey
  with a hue in it is what makes the one accent below stop being the only
  colour on screen.
- **Dark is near-black: 4% ground, 6-8% panels.** The old dark theme was 10%
  ground on 16% cards -- a mid grey pretending to be dark, where the page, a
  card and the sidebar were all the same value and the accent had nothing to
  be bright against.
- **`--border` / `--input` / `--sidebar-*` in dark are solid greys, not white
  at low alpha,** even though a translucent hairline is the look. Tailwind
  opacity modifiers (`divide-border/60` in `OrganizationSettingsDialog.tsx`)
  emit invalid colour if the token already carries an inline `/ 0.09`. The
  values there are what white at ~8-13% composites to on those panels. The
  scoped schedule tokens *do* use real alpha, because every call site there is
  hand-written.

Light and dark are both live, toggled by a `dark` class on `<html>`
(`App.tsx`) and persisted to localStorage. `frontend/orgTheme.css` is a **dead
file**: a "Field Dark" lime-on-near-black system that nothing imports, and its
type choices (Bebas Neue / DM Sans / Space Mono) are **no longer this
project's design intent** -- the typefaces below are. Do not wire it up.

**Type: Geist and Geist Mono**, loaded in `frontend/index.html` as variable
fonts (300-800), set on `body` in `index.css` and exposed to the schedule
scope as `--sch-mono` and to the nav shell as `.nav-mono`. Geist is a
geometric grotesk drawn for interfaces; the mono is its companion, so numbers
sit on the same skeleton as the text beside them. This replaced Space Mono,
which was a wide slab-serif typewriter face and read as retro rather than as
product. `font-mono` in Tailwind still maps to the generic system stack, so
mono has to go through `.nav-mono` or `var(--sch-mono)`.

**Icons: `@phosphor-icons/react`, never `lucide-react`,** in the nav shell
(`components/nav/`, `AppSidebar.tsx`, `lib/nav.ts`, `App.tsx`), everywhere in
the schedule (`components/schedule/`, `pages/Schedule.tsx`), and everywhere in
Stats (`components/stats/`, `pages/Stats.tsx`). Phosphor takes
a `weight` prop (`regular` / `bold` / `fill`), **not** `strokeWidth` -- a
`strokeWidth` passed to a Phosphor icon lands on the `<svg>` and does nothing.
Active nav items use `weight="fill"`, small glyphs that need to survive at
14px use `bold`, everything else is `regular`. The rest of the app (Roster,
Stats, Strategy, Login, dialogs, and the shadcn primitives in `lib/shadcn/`)
is **still on lucide** -- that is a known, deliberate boundary, not an
oversight; porting a page means porting all of its icons at once.
`pages/Stats.tsx` imports no lucide at all any more, and neither does
anything under `components/stats/`. The two shared components it still calls
(`PlayerCombobox`, and `SeasonMultiSelect` via Schedule and Roster) are
lucide-based and shared with pages that have not been ported, which is why
they were left alone -- porting one means porting every page that renders it.

The one addition to the shadcn tokens is the `--nav-accent*` family, defined
in both theme blocks of `index.css`. The global palette has no accent at all
-- `--accent` is a grey -- so the nav had nothing to mark "you are here" with.
These are deliberately the **same sharp azure cyan** as the schedule ledger's
`--sch-accent`, so one colour keeps meaning one thing across the app; the two
sets are one accent expressed in two scopes, so **retune them together or not
at all**. Use them only for state: the active nav item's rail and icon, the
active bottom-nav cell, and the current team's monogram/check in the switcher.
Never for a logo, a heading, or decoration -- the brand tile is deliberately
neutral (`--sidebar-primary`) for exactly this reason. Add a second accent and
both stop meaning anything.

Cyan, and not the deep olive that was here before: the olive sat at 31% L on a
light sidebar and 46% on a dark one, so it read as a muddy neutral in both,
and it shared a hue family with the win/loss result colours, which are
semantic and must never be confusable with "selected". Cyan is clear of green,
red and amber.

The four roles are not interchangeable, and the reason each exists is a
constraint you will re-derive the hard way if you collapse them:

- `--nav-accent` draws **solid shapes** -- the 2px rail, the bottom-nav bar, a
  filled tile.
- `--nav-accent-ink` is for **glyphs and text** on a pale ground, one step
  deeper so a small glyph still reads.
- `--nav-accent-on` sits **on** a filled tile and **inverts between themes**:
  light's tile is a deep cyan so its text is white, dark's tile is a bright
  cyan so its text is cyan-black. Reusing one value for both fails contrast
  in one of them.
- `--nav-accent-wash` is the **tint source, low alpha only**. A deep cyan at
  10% loses its hue and reads as plain grey; the wash is lighter and more
  saturated so the tint still looks cyan. Never draw a solid shape with it,
  and never tint with `--nav-accent`.

Every pairing above clears its WCAG target in both themes (shapes >=3:1, text
and glyphs >=4.5:1) -- the numbers are in the `index.css` comments. Re-check
them if you touch a value.

**Nav shell (`frontend/components/nav/`, `components/AppSidebar.tsx`).** Not a
scoped system -- it is the global one, plus the tokens above.

- **The account card is the only thing in the sidebar footer.** Theme,
  organization settings, passkeys, feedback and sign-out used to be five
  sibling rows there, each carrying the same visual weight as Schedule. They
  live inside `UserMenu`'s popover now. Adding a new sixth footer row is the
  regression this was written to prevent; put it in the popover.
- **The theme toggle is an exception and lives in the header**, with the
  utility icons, in both layouts (`ThemeToggle`). It is flipped often and
  idly, so burying a one-tap control two clicks deep is worse than a row.
- **The bar above the content is a utility strip, not a page header, and it
  must never learn the page's name again.** It used to open with an `<h1>` of
  the active tab's label, which put "Schedule" on screen three times at once
  -- the lit sidebar row, this bar, and the page's own title -- and spent 56px
  of every viewport restating what the highlighted nav item already said. The
  page is the thing that titles the page: **every page owns an `<h1>` at the
  top of its own content** (`pages/Schedule.tsx`, `Roster`, `Strategy`,
  `Chat`, `components/stats/StatsHeader`), with its page-specific actions on
  the same line, right-aligned. Add a page and give it its own heading; do not
  reach back up into the shell for one. Nothing in the strip changes when you
  change page, which is the whole point of it.
- **The strip is `h-12` and holds exactly two controls, one at each end.**
  `PanelToggle` left, `ThemeToggle` right, `px-3`, nothing between them. Both
  are the same 36px square with an 18px Phosphor glyph at neutral ink -- two
  icons alone on a rule read as one instrument, and a size or weight mismatch
  is instantly visible when there is nothing else to look at. 48px is the
  thinnest bar those squares fit in with air; do not pad it back to 56 and do
  not park anything in the middle.
- **There is one panel toggle and it lives in the strip.** It sat in the
  sidebar's own header for a while (Gemini-style, beside the workspace), which
  was right while the row opposite it carried the page title -- next to a
  title it read as page chrome, in the one row where the two regions are
  hardest to tell apart. With the title gone that row is no longer about the
  page, so the toggle sits at a fixed point on screen in both states, which is
  what a control you use to get the panel *back* has to be. A second copy in
  the sidebar header would be two buttons doing one job in adjacent rows. The
  sidebar header is the `WorkspaceSwitcher` and nothing else. shadcn's
  `SidebarTrigger` is still unused; `SidebarRail` stays as the silent
  drag-edge, and Cmd/Ctrl-B still works.
- **The active item is a 2px rail plus weight and ink, and no fill at all.**
  It used to also carry a wash of the accent, which is one bit of state said
  three ways, and a low-alpha tint of a deep accent lands as a muddy grey, so
  the row read as "faintly shaded" rather than "selected". Note that
  `sidebarMenuButtonVariants` ships its *own* `data-[active=true]` fill,
  weight and colour; `NAV_ITEM_CLASS` overrides all three and relies on
  tailwind-merge to collapse them. Drop the `data-[active=true]:bg-transparent`
  and the stock grey block comes straight back.
- **Inactive nav items sit at 75% ink, and that number is a floor, not a
  taste.** `--sidebar-foreground/75` over `--sidebar-background` is ~5.9:1 in
  light; at `/60` it falls under 4.5:1, which is a contrast failure dressed up
  as hierarchy. Dark has ~8:1 of headroom at the same alpha, so one value
  covers both. Dim further and you are failing WCAG, not designing.
- **The active rail is drawn inside the button.**
  `sidebarMenuButtonVariants` carries `overflow-hidden` and `SidebarContent`
  scrolls with `overflow-auto`, so a `::before` at a negative left offset --
  flush to the sidebar's outer edge, which is the obvious thing to reach for
  -- gets clipped by one or the other and silently disappears.
- **Mobile mirrors desktop, deliberately.** The mobile header carries the same
  `WorkspaceSwitcher` and `UserMenu` as the rail (`variant="bar"`), and the
  bottom nav's active cell gets the same accent bar rotated to its top edge
  and the same filled glyph. Changing one shell's chrome without the other is
  what produced the five loose header icons in the first place.
- **Tab labels and paths move together**, and old paths must keep working.
  `lib/nav.ts` owns both, plus `renamedPathFor()`, which App's unknown-path
  effect consults *before* bouncing to /schedule -- without it every link ever
  shared under an old name silently lands on the wrong page. `public/robots.txt`
  lists these paths too. Pages deep-link through `pathForTab()`, not literals.
- **Account identity comes from the email local part** (`nav/identity.ts`).
  `auth.users` has an id and an email and nothing else -- no profile row, no
  link to a `players` record -- so there is no real display name to show
  without adding a fetch to the app shell. A guest is anonymous and has no
  email at all, and is also a member of no team, which is why the switcher
  falls back to the product wordmark for them.

**Schedule ledger (`frontend/components/schedule/`).** A scoped system under
`.schedule-scope`, defined in `components/schedule/schedule-theme.css`.
Everything is namespaced `--sch-*` and `.sch-*` so it cannot leak into
Roster / Stats / Strategy.

Rules that keep it coherent -- follow them or the component stops matching
itself:

- **Pure neutrals, never Tailwind greys.** Hue 0, saturation 0. Inside the
  scope do not reach for `slate-*`, `gray-*`, `zinc-*` or `indigo-*`; use
  `hsl(var(--sch-ink))`, `--sch-ink-mid`, `--sch-ink-faint`.
- **Hover is an overlay, not a second surface colour.** `--sch-overlay` plus
  `--sch-overlay-a` (black at 3.5% in light, white at 4.5% in dark) so a row
  lands on the same value whether it sits on the ledger's white or on the
  featured row's cyan tint. A hardcoded hover colour could only ever be right
  on one of them.
- **One accent, reserved for state.** A sharp azure cyan (`--sch-accent`),
  used only for the travelling rail, the featured row's wash and crest, and
  the "next" chip. It is never decoration -- when it appears it means "this
  row is active". It is the same cyan as the nav shell's `--nav-accent`, and
  `--sch-accent` / `--sch-accent-ink` / `--sch-accent-wash` split by role
  exactly as the nav tokens do (solid shape / glyph and text / low-alpha tint).
- **Borders and hairlines, not shadows.** There is no `box-shadow` anywhere in
  the scope and no radius above 6px. The ledger is one 1px frame at radius 6px
  with 1px rules between rows; chips are radius 4px, deliberately not pills.
  `--sch-rule` and `--sch-rule-strong` already carry their alpha inline, so
  never add a second one at the call site.
- **Contrast is a hard requirement, and it is direction-dependent.**
  `--sch-ink-mid` is ~9:1 in both themes. In dark that meant going *brighter*
  (72% L); in light it meant going *darker* (32% L). "Brighter" is not the
  goal, contrast is.
- **The result is a second colour family, semantic and never the accent, and
  it is ONE token per outcome.** `--sch-win` / `--sch-loss` / `--sch-tie` are
  used three ways each: as the chip's text, as the chip's field at 10% and its
  edge at 22%, and as the ink of *our* number in the score. One token for all
  three is what keeps a chip and the score beside it obviously the same
  statement. Light takes the deep end of each hue (green-700 / red-700 /
  amber-700) because a 500-weight green on a 10% tint over white is ~1.5:1 --
  a colour you can see but not read; dark takes the 500s. Same recipe,
  opposite direction. The opponent's number stays neutral at `--sch-ink-mid`:
  two saturated numbers facing each other down a long list is a scoreboard,
  and the pair has to read as one figure with ours on top.
  `.sch-score--win|loss|tie` only rebinds `--sch-out`, so a fourth outcome is
  two lines and the three `.sch-score-*` colour rules never change.
- **Outcome chips are a tint, not a block.** 10% field, 22% edge, full-strength
  text. Saturated fills and neon borders shout the same result from every row
  and turn a list into a set of warning lights.
- **Scores align on the dash, and that is why the verdict track is a fixed
  width.** `.sch-score` is a `2ch 1.5ch 2ch` grid so the dash forms a spine
  down the list regardless of digit count -- but the identity track is the
  row's only `1fr`, so it absorbs all the slack, and a content-sized chip
  track drags the score column left every time a label is longer than "Win".
  One "Default Win" in the list and the spine is gone. The track is `5.75rem`
  on desktop / `4.25rem` on mobile and the chip fills it (`width: 100%`), in a
  cell that is `justify-self-stretch` -- `justify-self-end` would give the chip
  its own content width back and reintroduce the bug one level down. Verify
  with a measured `dashX`, not by eye.
- **The verdict closes the row and the crest opens it.** Track order is
  crest, identity, drop-in fields, score, verdict, caret -- the F-pattern the
  eye actually walks, ending on the answer. Below `md` the 68px track cannot
  hold "Default Win", so the chip falls back to the bare outcome
  (`CHIP_SHORT`); the asterisk still says it was entered by hand and the row's
  `aria-label` carries the full wording at every width.
- **The crest is a real shadcn `<Avatar>`, not a styled span.** The monogram is
  its fallback, so the day `MatchData.crestUrl` is populated a logo drops into
  `<AvatarImage>` and the grid does not move. It is a squircle at 8px, not a
  circle, because every other tile in the product (account card, workspace
  switcher, team monogram) is a squircle at 6-7px.
- **The chip must not set the row height.** Row height comes from the crest
  (34px mobile / 36px desktop) plus padding. At 11px over 4px of padding the
  chip is ~19px, well under it. Check that sum before adding padding.
- **Type.** Team names use Geist at weight 620 with `-0.014em` tracking. Every
  number and every piece of metadata uses **Geist Mono** (`--sch-mono`).
  Secondary text always sets an explicit `line-height` and slightly negative
  tracking; never let it inherit the default leading.

Structure and behaviour:

- **`GameRow` takes `matchData` and nothing else.** It does no data fetching and
  knows nothing about the `games` table -- `toMatchData()` in
  `pages/Schedule.tsx` is the only place that knows what an `outcome_override`
  is. Keep that boundary: it is what lets a second sport reuse the row. It is
  also why `crestInitials()` is a local copy of `nav/identity.ts`'s `initials()`
  rather than an import.
- **Rows are CSS Grid, never a flex stack.** Tracks are passed in as
  `--sch-cols-sm` / `--sch-cols-md` custom properties, so each entry in
  `matchData.details[]` becomes one more desktop track (hidden below `md`).
  Adding venue, duration or division is one array entry -- do not nest flexbox
  to squeeze a field in.
- **The accent rail belongs to `GameLedger`, not to the row.** One rail per list
  slides between rows on hover and on focus, so dragging the pointer down reads
  as continuous travel rather than a string of blinks. It is a 2px bar moved by
  `translateY(--rail-y) scaleY(--rail-h)` to stay on the compositor. `parkIndex`
  is the row it rests on when idle (the featured fixture); with no park it fades
  out. Do not reintroduce a per-row `::before` rail.
- **Hover is staggered, and reduced motion is honoured.** Rail and background at
  0ms, name shift at 90ms, caret at 140ms via `.sch-stagger-*`. Every transition
  collapses under `prefers-reduced-motion: reduce`.
- **Utility icons go through `IconButton`.** One 34px square, one 16px Phosphor
  glyph at `regular` weight (`SCHEDULE_ICON_PROPS`). Do not hand-roll another
  icon button in the schedule header -- mismatched glyph weights are the
  loudest tell that a toolbar was assembled rather than designed. Pass `active`
  only for real toggles; it emits `aria-pressed`. `tone="accent"` is the one
  primary action and is that same square with its **ink inverted**, not a
  coloured button: a lone tinted chip on the end of a toolbar reads as a stray
  control rather than as the end of the row.
- **shadcn primitives live in `frontend/lib/shadcn/`**, not `components/ui/`,
  and there is no `components.json`, so `npx shadcn add` will not work -- add the
  file by hand. Unused primitives are normal there (`separator`, `sheet` and
  `tooltip` currently have no importers).

**Stats (`frontend/components/stats/`).** A scoped system under
`.stats-scope`, defined in `components/stats/stats-theme.css`, covering the
whole page -- every tab, every panel, both tables and the standings dialog.
There is no shadcn `Card` left on Stats and no `lucide` import. Same
architecture as the schedule ledger and deliberately so -- namespaced
`--st-*` / `.st-*`, pure neutrals, hairlines not shadows, no radius above
6px, Geist Mono for every number. Read the ledger's rules first; the ones
below are the ones that are specific to a page whose subject is numbers.

- **Three colour families, and the third one is what is new.** The neutral
  ramp and the one cyan accent are the same as everywhere else. On top of
  them sit `--st-goals` / `--st-assists` / `--st-turnovers`: semantic data,
  used four ways each (the chart bar, the figure's ink, a chip's text, and
  that chip's field at 10% with a 22% edge), exactly the way the ledger uses
  win/loss/tie. Light takes the deep end of each hue and dark the bright
  end; all three clear 4.5:1 on their own theme's panel, so each doubles as
  text without needing a second "ink" variant.
- **Assists is violet, not cyan, and that is not a taste.** Cyan is the
  app's state accent. A chart full of cyan bars sitting under a cyan "you
  are here" tab rail is the same collision the olive accent had with the
  win/loss colours -- the accent stops meaning anything. Violet sits ~65
  degrees clear of the cyan, of the green and of the amber. Turnovers is
  amber rather than red because red is the ledger's *loss* colour and a
  turnover is a caution, not a result.
- **The turnover series is currently switched off at the display layer, and
  `--st-turnovers` is not dead code.** No screen in the app can record a
  `Turnover` / `Throwaway` / `Drop` event, so every turnover figure was a
  guaranteed 0 -- a column of zeros reads as "this team never turns it over"
  rather than as "nobody tracked it". `SHOW_TURNOVERS` in
  `frontend/lib/features.ts` is the one switch: it gates the leaderboard
  series, the rankings column and its formula-builder option, the
  progression stat, the Me tab's metric card, the leader cards' second strip
  cell, the Roster summary / per-game / by-season columns and the turnover
  breakdown card, and the Schedule box score's TO column. The whole data
  path underneath -- `isTurnoverEvent`, every aggregation, the columns,
  the tokens -- is untouched, so flipping the flag brings all of it back
  with its layout and colours intact. Do not "clean up" what looks unused
  behind the flag, and gate any new turnover surface through it.
  Two knock-on rules while it is off: grids that were sized for four cards
  (the Me tab, the Roster summary) size for three, and a leader card's strip
  is still two cells -- the second falls back to a neutral G+A, because the
  strip is two columns at every width by design.
- **The accent is spent on state and nothing else: the active tab's rail, the
  checked state in a filter popover, and the one thing you are looking at**
  -- the progression chart's focused line, the assist web's focused node.
  Not on the leader's crest -- "top scorer" is a fact about the data, not a
  state, and a ring there was decoration. Not on the active filter segment
  either: a filter says which slice you are looking at, the accent says where
  you are in the app, and spending it on both leaves them wearing one colour
  in one header. The active segment is a raised neutral surface instead.
- **A card binds one series and everything inside reads it.** `--st-series`
  is set once by `.st-goals` on the card; the figure, the overline's glyph,
  the chip and the meter fill all resolve from it, so a card cannot end up
  with a green number over an amber bar. `.st-strip-cell` deliberately
  **resets** it to `--st-ink` -- without that reset the binding leaks into
  the footer and paints the team card's "Allowed" the same green as a
  positive point differential, which says the opposite of what it means.
- **All three KPI cards have one anatomy**: overline, identity, hero figure,
  hairline-separated footer strip. That is why the leader cards carry the
  player's *other* two numbers -- it fills the card, it is genuinely useful,
  and it is what keeps the three the same object rather than two designs.
  The strip is two columns at every width: four across fits only if
  "ALLOWED" sits ~2px inside its cell on a third-width card, which does not
  survive a font fallback.
- **The strip pins itself with `margin-top: auto` in the stylesheet, not
  with a `mt-auto` utility.** Both are one class of specificity, so which
  one won came down to whether Vite injected the scoped stylesheet before or
  after Tailwind's utilities layer.
- **`PerformanceChart` takes `players` and nothing else** -- no query, no
  filter state -- the same boundary `GameRow` keeps against `games`.
  `pages/Stats.tsx` is the only place that knows what a `player_stats` row
  is; `PlayerLine` is what crosses.
- **The chart has no x-axis on purpose.** A numeric axis under a ranked list
  is a ruler nobody reads, so the value is printed at the tip of its own bar
  (`LabelList`) instead. `<XAxis hide />` still has to be present to
  establish the numeric domain, and its domain carries 12% headroom so the
  printed value stays inside the plot.
- **Recharts offsets a custom axis tick by `tickSize + tickMargin`.** The
  YAxis sets both to 0 so the tick's `x` is the axis's own right edge and
  `NameTick`'s offsets are measured from something real. Left at the
  defaults you get `width - 8`, the rank column lands at -6, single-digit
  ranks are clipped away entirely and double-digit ones lose their leading
  digit -- which looks exactly like a data bug and is not one.
- **Series colours reach Recharts as `hsl(var(--st-goals))`,** not as hex.
  SVG resolves custom properties from the element's own context and the
  chart renders inside `.stats-scope`, so the bars re-theme on the dark
  toggle for free. Hardcode a hex and one theme is wrong.
- **Radix popovers portal to `<body>`, outside the scope.** Any
  `PopoverContent` in this system has to carry `stats-scope` in its own
  className or every `--st-*` inside it resolves to nothing. The Recharts
  tooltip does not -- it renders inside the chart wrapper.
- **Floating layers are the one place a shadow is allowed.** The tooltip and
  the filter popovers have no surface to seam against, so they take
  `--st-lift`. Nothing in the document flow does.
- **The filter lives in the page header and its state lives in `Stats()`.**
  It was a titled "Filters" Card with a `<Label>` over a full-width
  `<Select>` -- roughly a third of the first screen spent saying "this
  season" before a number appeared. `PlayerStatsView` now takes
  `filterType` / `selectedSeasonIds` / `selectedGameIds` / `games` /
  `allSeasons` as props; do not re-fetch games or seasons down there.
- **The season default applies exactly once, guarded by a ref.** The old
  guard was "filterType is still `all` and nothing is selected", which is
  also true the moment someone deliberately switches back to All-time -- so
  any later refetch of games or seasons dragged them back into a season.

The lower half -- chemistry, the assist matrix, the progression chart -- adds
these:

- **One dropdown idiom for the whole page** (`components/stats/Picker.tsx`,
  `MultiPicker` / `SinglePicker`). It replaced three separate controls doing
  the same job: a shadcn `<Select>` under a `<Label>`, and two hand-rolled
  click-outside popovers (`SeasonMultiSelect`, `PlayerMultiSelect`) with their
  own trigger styling and their own lucide chevrons. `PlayerMultiSelect` was
  deleted with its last caller; `SeasonMultiSelect` stays because Schedule and
  Roster still use it. Add a fourth dropdown here and it goes through Picker.
- **The assist matrix has two views of one data set -- a web and a table --
  and the web is the default** (`components/stats/AssistWeb.tsx`, chosen with
  a segmented control in the panel head, remembered per device in
  localStorage). The web is the ring this page used to have and lost: every
  connected player on the circumference, every assist a curved line between
  two of them. It was removed for being a hairball, and it is back only
  because the three things that made it one are fixed. Undo any of them and
  it is a hairball again:
  - **Focus + dim, exactly as the progression chart does it.** One player is
    always focused -- the same selection the picker and the table's columns
    read -- their lines are drawn at full strength and every other line drops
    to `--st-ink / 0.13`. Every edge at full strength in one colour is what
    made a real roster's worth of lines unreadable.
  - **Direction is colour, so one ring says what two used to.** A line into
    the focused player is `--st-goals`, a line out of them is `--st-assists`
    -- the same two series the table's two columns take, so the two views are
    one statement in one palette. It is also why A->B and B->A stay two
    separate lines: they are two different facts about the focused player.
    The old graph had to merge them into a single line with a combined count
    precisely because both were drawn in the same colour.
  - **Only the focused player's lines carry a count, and only their partners
    carry a name.** All a dimmed line has to say is "this pairing exists". A
    count bubble on every line and a name on every node was the other half of
    what made the picture unreadable.
  - **A count bubble goes out near its partner's end of the line, never at
    the midpoint.** Every lit line meets the focused player, so the midpoint
    is the one place they cannot go: a dozen lines converge there and the
    bubbles land on one small arc, overlapping each other and the hub. Out at
    the partner's end the lines have fanned apart, and a number beside a face
    answers "whose is this" without the eye tracing a curve back. `BUBBLE_T`
    is that preference list and the placement is greedy -- busiest line first,
    each taking the first candidate clear of every node disc and every bubble
    already down, falling back to the roomiest candidate rather than to the
    midpoint. Verify it by measuring the rendered circles against each other
    and against the node discs, not by eye.
  - **The svg paints in three passes -- every line, then every arrowhead,
    then every count.** One group per edge instead and a line crossing an
    earlier edge is painted straight through that edge's bubble, so whether a
    number is legible depends on which pairing came first out of the query.
  The two curves of a pair separate *because the perpendicular flips with the
  line's direction*, so the offset is taken on the same side every time.
  Choosing a side by id order -- the obvious thing to reach for -- cancels
  that flip out and lays the two lines exactly on top of each other, which
  reads as one connection. Node positions still carry no information: they
  come out of the same greedy farthest-point placement (`spreadOrder`), whose
  only job is keeping the busiest nodes from clustering. Node *size* is
  degree, and the radius scales down as the ring fills rather than the roster
  being capped -- a cap silently drops somebody's connections off the
  picture.
- **The web's type is in svg user units, so it scales with the picture.** The
  ring renders ~480px wide in a desktop panel and ~300px on a phone, which
  takes a 9.5-unit name down to 7.5 real pixels; the `max-width: 640px` block
  is the same type at the same rendered size, not bigger type. The svg is
  deliberately `overflow: visible` -- a name sits outside the ring with only
  the viewBox margin behind it -- and `fitLabel()` caps a label at 12
  characters, so a long first name spills into the wrapper's padding instead
  of over the panel's border. Verify a narrow layout by measuring
  (`scrollWidth === clientWidth`, and the label rects against the svg's), not
  by screenshot: Chrome will not lay out below ~500px on macOS, and the media
  query keys off the *viewport*, so a 360px probe div in a 900px window is
  silently testing the desktop sizes.
- **The two views are the same data twice, and the colours say so.** The page
  used to draw two rings, "Assists" and "Goals", over identical edges,
  differing only in which end of an edge counted as the selected player's
  own. That difference is now the table's two columns and the web's two line
  colours: "assisted by" counts goals the selected player scored (green),
  "assisted to" counts assists they threw (violet). One shared "connection"
  colour would lose that.
- **A meter gets its own fixed track (`.st-track`), never the flexible cell.**
  Inside the name cell it stretches to whatever the panel is wide -- 740px on
  the chemistry list, at which point it reads as a loading bar rather than as
  a comparison -- and because the name cell is the row's only `1fr` it also
  strands the count 700px from the name it belongs to. Same reasoning as the
  ledger's fixed verdict track; verify it the same way, by measuring.
- **"Lethal" belongs to the count, not to row 1.** Three pairings on 3 are
  three lethal pairings; badging whichever of them the sort happened to put
  first says the other two are something lesser. The badge goes to every pair
  whose count equals the maximum, once that maximum clears `LETHAL_MIN`.
- **The chemistry row drops its meter below `sm` (`.st-track--optional`).** It
  carries two names where every other row carries one, so it runs out of width
  first: at 360px each name was being shrunk to ~31px, which ellipsises
  "Marisol O." to "Ma…". The number already says which pairing is biggest; a
  name cut to two characters says nothing.
- **Progression lines are keyed by player id, not display name.** `point[
  String(p.id)]`, with `name` only for the legend and tooltip. Keyed by name,
  two players called "Sam" collapse onto one line and silently sum.
- **Focus + dim, and the focused line is the accent.** Eight lines in eight
  unrelated hues is spaghetti -- no line is readable because every line
  competes -- and the twelve-colour palette it drew from meant a player
  changed colour whenever the selection did. Now every line is
  `--st-ink / 0.16` and one is `--st-accent`. That is a correct use of the
  accent: "the line you are looking at" is state. The dimmed lines still
  carry the shape of the pack, which is the context that makes one line worth
  following.
- **Dimmed lines are painted before the focused one.** SVG has no `z-index`;
  paint order is the only stacking there is, so the `<Line>` array is sorted
  by `id === focusId` before it renders.
- **Focus is derived, never stored in an effect.** A pinned player who drops
  out of range -- a filter change, subs toggled off -- simply stops matching
  and the focus falls back to the leader. The assist matrix's selected player
  works the same way. An effect resetting either would fight the click that
  caused the change.
- **The progression chart keeps a horizontal-only hairline grid** at
  `--st-rule`, which is not Recharts' stock dashed grey grid but is also not
  nothing: a cumulative chart with no reference lines is a shape you cannot
  read a value off.
- **The season picker is numeric, with `ALL_SEASONS` (-1) as the sentinel.**
  It used to be a string that was either an id or the literal `'__all__'`,
  which every call site had to know about. `null` is a third state and means
  "not resolved yet" -- it is what stops the fetch firing an all-time query on
  mount and then immediately refiring for the default season.

The two tables -- Player Rankings and League Standings -- add these:

- **Numbers right, text left, and the rule cannot hang off `:first-child`.**
  It used to, and it was true right up until both tables grew a rank gutter
  and the name became the *second* cell -- at which point every player and
  team name silently right-aligned and drifted away from the form dots
  underneath it. `.st-th--left` / `.st-td--left` mark the text columns
  explicitly.
- **`.st-name` sets its own font-family, and that is load-bearing.** In a
  list row it inherits Geist and looks right; inside a `.st-td` it would
  inherit Geist Mono, so the same player rendered in two typefaces on two
  tabs of the same page. It is also `display: block`, because the ellipsis
  needs a block box to clip against.
- **A rank gutter shows row position, not a stored rank.** Sort the rankings
  by turnovers and "1" has to mean the top of what is on screen, or the
  column is lying about the order you just chose. Standings is the opposite
  and shows the real rank, because there the sort is a way to *read* a table
  whose ordering is defined by the league.
- **Both tables scroll inside their own panel (`.st-scroll`), never the
  page.** Eight columns of `white-space: nowrap` do not fit a 360px phone and
  never will; the panel is the thing that is too narrow, not the document.
- **The column system lives in `components/stats/columns.ts` and reads
  `PlayerLine`,** not `PlayerStat`. It used to read the raw SQL row, whose
  fields are the strings Postgres returns from a `SUM()`, so every column
  evaluation ran its own `parseInt`. The parsing happens once now, where the
  rest of the page already does it.
- **`RankingsTable` owns its own display preferences.** Visible columns,
  widths, sort, and any formula columns are per-device viewing state in
  localStorage that nobody else ever sees, so they live in the component
  rather than in `PlayerStatsView` -- which took ~120 lines of state and
  handlers out of a component that is about stats, not about a table's
  chrome.
- **The formula builder uses segmented controls, not `<Select>`s.** With
  three or four options apiece, a dropdown hides the whole choice behind a
  click and saves no space at all.
- **Sort sentinels are -100 / -101, deliberately not -1.**
  `allColumns.findIndex` returns -1 for a column that no longer exists, and a
  sentinel colliding with that would make a stale sort read back as "no sort"
  while the table stayed sorted.
- **`StandingsTable` takes rows, not a league.** It never sees a
  `league_teams` row, a stage, or an `eff_home_score`; `StandingsRow` is what
  crosses. Same boundary `GameRow` keeps against `games`, and the reason the
  form guide is computed on the page side where the league's own rules
  already live.
- **The form guide is squares, not circles.** Nothing else in the product is
  a circular indicator, and a row of coloured dots reads as a loading spinner
  caught mid-animation. They bind `--st-up` / `--st-down` / `--st-tie`, the
  same three tokens the point differential and the head-to-head strip use, so
  a win is one colour everywhere on the page.
- **Radix Dialogs portal to `<body>` exactly as popovers do.** The manage-
  standings `DialogContent` carries `stats-scope` itself; without it every
  `--st-*` inside resolves to nothing.

Verifying a visual change: there is no test harness checked in. Render the
component against mock data from a throwaway Vite entry at the `frontend/` root
(an `harness.html` + `harness.tsx` pair; Vite dev serves it directly),
screenshot it in both themes, then delete the harness and revert the temporary
`tailwind.config.js` `content` entry it needed. Two traps:

- Headless Chrome's `--virtual-time-budget` does not advance the CSS animation
  clock, so transitions read as stuck at their start value -- assert on
  `el.getAnimations()` instead of on sampled intermediate frames.
- **Chrome will not render a layout viewport narrower than ~500px on macOS**,
  in either headless mode: `--window-size=390,900` silently lays out at 500 and
  crops the screenshot, which looks exactly like a horizontal-overflow bug and
  is not one. Verify narrow layouts by measuring instead -- dump geometry into
  the DOM and read it back with `--dump-dom` -- and check `scrollWidth ===
  clientWidth` rather than eyeballing a cropped PNG.

## References
- Bugs and feature requests are tracked as GitHub issues in this repo (`gh issue list`), not in a separate tracker.
- Project notes/planning doc in Notion: https://app.notion.com/p/e2e903a5dd4347c7be8fe9a0ab39b4f1?v=3d08e4449db2814b9332000c33d32b8b

## Gotchas
- Windows: `node node_modules/.bin/tsx <file>` fails with a syntax error — `.bin/tsx` is a POSIX shell shim, not a Node script. Use `node node_modules/tsx/dist/cli.mjs <file>` (or `npx tsx <file>`) instead. `.claude/launch.json`'s "Express API Server" config already uses the fixed form, but `package.json`'s own `server`/`dev` npm scripts still use the broken one and will fail the same way if run directly.
- Vercel CLI (`vercel env pull`) cannot reveal env vars marked "Sensitive" in any environment — it always returns `[SENSITIVE]` placeholders. Don't rely on it to recover secrets; get them from the Supabase dashboard instead.
- `npm test` runs `node server.test.mjs`, which does `import "dotenv/config"` and builds its Supabase client from the root `.env` file, not `.env.local`. The root `.env` points at PRODUCTION. Running `npm test` therefore reads and asserts against the live production database, not the local Supabase stack. Never run it casually, and never run it at all while testing anything migration-related. Use `npm run db:test` for the local pgTAP suite instead.
- `server.test.mjs` asserts that `players` still has `phone`, `first_name_edit`, and `last_name_edit` columns. The team-permissions migrations move those columns to `player_private`. The assertion passes today only because `npm test` reads production, which these migrations have not been applied to yet. Once production is cut over, that assertion will fail. Whoever runs the production cutover must update `server.test.mjs` to match the new `players`/`player_private` split in the same change.
- Deleting a sole captain's `auth.users` row (Supabase dashboard "delete user", the admin API, or any GDPR deletion path) fails with a bare `team % must have at least one captain` error. This is `enforce_last_captain()` on `team_members` doing its job — the same trigger that blocks demoting or removing a team's last captain also fires when that captain's account is deleted, since `team_members.user_id` cascades from `auth.users`. Before deleting a sole captain's account, promote another member to captain (`set_member_role`) and, if appropriate, `remove_member` the original captain first.
