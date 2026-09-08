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

The app ships **two** visual systems. Know which one you are in before styling
anything.

**Global (everything except the schedule list).** shadcn tokens in
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
(`components/nav/`, `AppSidebar.tsx`, `lib/nav.ts`, `App.tsx`) and everywhere
in the schedule (`components/schedule/`, `pages/Schedule.tsx`). Phosphor takes
a `weight` prop (`regular` / `bold` / `fill`), **not** `strokeWidth` -- a
`strokeWidth` passed to a Phosphor icon lands on the `<svg>` and does nothing.
Active nav items use `weight="fill"`, small glyphs that need to survive at
14px use `bold`, everything else is `regular`. The rest of the app (Roster,
Stats, Strategy, Login, dialogs, and the shadcn primitives in `lib/shadcn/`)
is **still on lucide** -- that is a known, deliberate boundary, not an
oversight; porting a page means porting all of its icons at once.

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
- **Controls sit with what they act on.** `ThemeToggle` changes the page, so
  it is in the content header; `PanelToggle` (collapse/expand) changes the
  panel, so it is in the panel's own header beside the workspace, Gemini-style
  -- not next to the page title, where it read as page chrome and sat in the
  one row where the two regions are hardest to tell apart. shadcn's
  `SidebarTrigger` is no longer used in `App.tsx`; `SidebarRail` stays as the
  silent drag-edge, and Cmd/Ctrl-B still works.
- **Collapsed, the panel toggle takes the top slot.** The header row becomes a
  column (`group-data-[collapsible=icon]:flex-col`) with the toggle first,
  because once the labels are gone it is the only way back out -- it must not
  be the thing that hides. It moves by `order-first`, not by a second DOM
  order, so the tab sequence is identical in both states. The 3rem rail leaves
  exactly 2rem of content width: a `size-8` control fits, a larger one does
  not.
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
