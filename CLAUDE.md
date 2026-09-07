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

**Global (everything except the schedule list).** Stock shadcn tokens in
`frontend/index.css` -- hue-240 cool neutrals, `--primary` is just black/white,
and `--accent` is a grey rather than an accent colour. Light and dark are both
live, toggled by a `dark` class on `<html>` (`App.tsx`) and persisted to
localStorage. `frontend/orgTheme.css` is a **dead file**: a "Field Dark"
lime-on-near-black system that nothing imports. Do not wire it up casually --
it would restyle every page at once and effectively drop the light theme. Its
font choices are still treated as this project's design intent (see below).

The one addition to those stock tokens is `--nav-accent` / `--nav-accent-ink` /
`--nav-accent-on`, defined in both theme blocks of `index.css`. The global
palette has no accent at all -- `--accent` is a grey -- so the nav had nothing
to mark "you are here" with. These are deliberately the **same chartreuse** as
the schedule ledger's `--sch-accent`, so one colour keeps meaning one thing
across the app. Use them only for state: the active nav item's rail, wash and
icon, the active bottom-nav cell, and the current team's monogram/check in the
switcher. Never for a logo, a heading, or decoration -- the brand tile is
deliberately neutral (`--sidebar-primary`) for exactly this reason. Add a
second accent and both stop meaning anything.

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
- **Inactive nav items sit at 75% ink, and that number is a floor, not a
  taste.** `--sidebar-foreground/75` over `--sidebar-background` is ~4.8:1 in
  light, just clear of 4.5:1; at `/60` it falls to ~3.2:1, which is a contrast
  failure dressed up as hierarchy. Dark has ~8:1 of headroom at the same alpha,
  so one value covers both. Dim further and you are failing WCAG, not designing.
- **The active rail is drawn inside the button.** `sidebarMenuButtonVariants`
  carries `overflow-hidden` and `SidebarContent` scrolls with `overflow-auto`,
  so a `::before` at a negative left offset -- flush to the sidebar's outer
  edge, which is the obvious thing to reach for -- gets clipped by one or the
  other and silently disappears.
- **Mobile mirrors desktop, deliberately.** The mobile header carries the same
  `WorkspaceSwitcher` and `UserMenu` as the rail (`variant="bar"`), and the
  bottom nav's active cell gets the same accent bar rotated to its top edge.
  Changing one shell's chrome without the other is what produced the five
  loose header icons in the first place.
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
`.schedule-scope`, defined in `components/schedule/schedule-theme.css`. It
exists because the global tokens are exactly the generic slate/zinc default the
schedule redesign was asked to avoid. Everything is namespaced `--sch-*` and
`.sch-*` so it cannot leak into Roster / Stats / Strategy.

Rules that keep it coherent -- follow them or the component stops matching
itself:

- **Warm neutrals, never Tailwind greys.** The ink ramp is hue ~28-40 at very
  low saturation. Inside the scope do not reach for `slate-*`, `gray-*`,
  `zinc-*` or `indigo-*`; use `hsl(var(--sch-ink))`, `--sch-ink-mid`,
  `--sch-ink-faint`.
- **One accent, reserved for state.** Chartreuse (`--sch-accent`), used only for
  the travelling rail, the featured-row wash, and the primary icon button. It is
  never decoration -- when it appears it means "this row is active".
- **Borders and hairlines, not shadows.** There is no `box-shadow` anywhere in
  the scope and no `rounded-2xl`. The ledger is one 1px frame at radius 5px with
  1px rules between rows; chips are radius 3px, deliberately not pills.
- **Contrast is a hard requirement, and it is direction-dependent.**
  `--sch-ink-mid` is ~9:1 in both themes. In dark that meant going *brighter*
  (65% -> 76% L); in light it meant going *darker* (46% -> 30% L). "Brighter" is
  not the goal, contrast is.
- **Outcome chips keep a dark field in both themes** (deep green / oxblood with
  bright text, ~9.2:1 and ~5.7:1). Holding them steady across the theme toggle
  is what keeps win/loss instantly readable; do not invert them for light mode.
- **Type.** Team names use the inherited sans at weight 650 with `-0.021em`
  tracking. Every number and every piece of metadata uses **Space Mono**
  (`--sch-mono`, loaded in `frontend/index.html`, two weights, `display=swap`) --
  that is `orgTheme.css`'s declared `--font-mono`, so it honours existing intent
  rather than introducing a new face. Secondary text always sets an explicit
  `line-height` and slightly negative tracking; never let it inherit the default
  leading.
- **Scores align on the dash.** `.sch-score` is a `2ch 1.75ch 2ch` grid so the
  dash forms a spine down the list regardless of digit count. Any new
  score-like column should do the same.

Structure and behaviour:

- **`GameRow` takes `matchData` and nothing else.** It does no data fetching and
  knows nothing about the `games` table -- `toMatchData()` in
  `pages/Schedule.tsx` is the only place that knows what an `outcome_override`
  is. Keep that boundary: it is what lets a second sport reuse the row.
- **Rows are CSS Grid, never a flex stack.** Tracks are passed in as
  `--sch-cols-sm` / `--sch-cols-md` custom properties, so each entry in
  `matchData.details[]` becomes one more desktop track (hidden below `md`).
  Adding venue, duration or division is one array entry -- do not nest flexbox
  to squeeze a field in.
- **The accent rail belongs to `GameLedger`, not to the row.** One rail per list
  slides between rows on hover and on focus, so dragging the pointer down reads
  as continuous travel rather than a string of blinks. It is a 1px bar moved by
  `translateY(--rail-y) scaleY(--rail-h)` to stay on the compositor. `parkIndex`
  is the row it rests on when idle (the featured fixture); with no park it fades
  out. Do not reintroduce a per-row `::before` rail.
- **Hover is staggered, and reduced motion is honoured.** Rail and background at
  0ms, name shift at 90ms, caret at 140ms via `.sch-stagger-*`. Every transition
  collapses under `prefers-reduced-motion: reduce`.
- **Utility icons go through `IconButton`.** One 34px square, one 16px lucide
  glyph at `strokeWidth 1.75` (`SCHEDULE_ICON_PROPS`). Do not hand-roll another
  icon button in the schedule header -- mismatched stroke weights are the
  loudest tell that a toolbar was assembled rather than designed. Pass `active`
  only for real toggles; it emits `aria-pressed`.
- **shadcn primitives live in `frontend/lib/shadcn/`**, not `components/ui/`,
  and there is no `components.json`, so `npx shadcn add` will not work -- add the
  file by hand. Unused primitives are normal there (`separator`, `sheet`,
  `tooltip` and `avatar` currently have no importers).

Verifying a visual change: there is no test harness checked in. Render the
component against mock data from a throwaway Vite entry at the `frontend/` root,
screenshot it in both themes and at 390px, then delete the harness and revert
the temporary `tailwind.config.js` `content` entry it needed. Note that headless
Chrome's `--virtual-time-budget` does not advance the CSS animation clock, so
transitions read as stuck at their start value -- assert on
`el.getAnimations()` instead of on sampled intermediate frames.

## References
- Bugs and feature requests are tracked as GitHub issues in this repo (`gh issue list`), not in a separate tracker.
- Project notes/planning doc in Notion: https://app.notion.com/p/e2e903a5dd4347c7be8fe9a0ab39b4f1?v=3d08e4449db2814b9332000c33d32b8b

## Gotchas
- Windows: `node node_modules/.bin/tsx <file>` fails with a syntax error — `.bin/tsx` is a POSIX shell shim, not a Node script. Use `node node_modules/tsx/dist/cli.mjs <file>` (or `npx tsx <file>`) instead. `.claude/launch.json`'s "Express API Server" config already uses the fixed form, but `package.json`'s own `server`/`dev` npm scripts still use the broken one and will fail the same way if run directly.
- Vercel CLI (`vercel env pull`) cannot reveal env vars marked "Sensitive" in any environment — it always returns `[SENSITIVE]` placeholders. Don't rely on it to recover secrets; get them from the Supabase dashboard instead.
- `npm test` runs `node server.test.mjs`, which does `import "dotenv/config"` and builds its Supabase client from the root `.env` file, not `.env.local`. The root `.env` points at PRODUCTION. Running `npm test` therefore reads and asserts against the live production database, not the local Supabase stack. Never run it casually, and never run it at all while testing anything migration-related. Use `npm run db:test` for the local pgTAP suite instead.
- `server.test.mjs` asserts that `players` still has `phone`, `first_name_edit`, and `last_name_edit` columns. The team-permissions migrations move those columns to `player_private`. The assertion passes today only because `npm test` reads production, which these migrations have not been applied to yet. Once production is cut over, that assertion will fail. Whoever runs the production cutover must update `server.test.mjs` to match the new `players`/`player_private` split in the same change.
- Deleting a sole captain's `auth.users` row (Supabase dashboard "delete user", the admin API, or any GDPR deletion path) fails with a bare `team % must have at least one captain` error. This is `enforce_last_captain()` on `team_members` doing its job — the same trigger that blocks demoting or removing a team's last captain also fires when that captain's account is deleted, since `team_members.user_id` cascades from `auth.users`. Before deleting a sole captain's account, promote another member to captain (`set_member_role`) and, if appropriate, `remove_member` the original captain first.
