# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repository.

## Rule: document style

All documents generated for this project (Markdown, READMEs, notes, comments
intended as prose) must NEVER include em dashes or emojis. Use commas, colons,
parentheses, or separate sentences instead of em dashes. Keep the tone plain and
professional.

## Rule: keep this file current

Whenever something changes logically, such as architecture, commands,
conventions, the security model, an invariant, or a "source of truth" like a
shared constant, update this file in the same change. Treat CLAUDE.md as part of
the diff, not an afterthought. If a fact here becomes wrong, fix it or delete it;
a stale CLAUDE.md is worse than none. Add new sections when a new subsystem or
convention appears.

## What this project is

Ultimate Frisbee Warrior Tracker is a full-stack web app for tracking Ultimate
Frisbee seasons, rosters, game events, scores, and player statistics. Access is
team-only, gated by an email allowlist.

## Tech stack

- Frontend: React 19 with TypeScript and Vite, Tailwind CSS, shadcn/Radix UI,
  React Router 7, TanStack Table, Recharts. Lives in `frontend/`.
- Backend: Node.js with Express (`server/index.ts`), run with `tsx`.
- Database: PostgreSQL via Supabase (REST, RPC, and Storage), protected by Row
  Level Security.
- Auth: Cookie-based sessions via a Backend-for-Frontend (BFF) gateway (see
  below). Uses `jose` for JWKS verification and Supabase Auth for identity.
- AI: Google Gemini (`@google/genai`) powers the Chat page.
- Deploy targets: Cloudflare Workers (`worker.ts`), Vercel (`api/index.ts`), and
  Replit. All three mount the same gateway.

## Commands

Run from the repo root unless noted.

- `npm run dev`: start the Express API (`:3001`) and Vite frontend (`:5000`)
  concurrently. This is the main dev command.
- `npm run build`: production build of the frontend (`frontend/dist`).
- `npm test`: backend smoke and integration tests (`node server.test.mjs`).
- `npm run deploy`: deploy to Cloudflare Workers. The frontend build runs
  automatically via the `build.command` hook in `wrangler.jsonc`, so a bare
  `npx wrangler deploy` (what the Workers Builds git integration runs) works
  from a clean checkout too. Wrangler 4 auto-detects `wrangler.jsonc`.
- `npm run deploy:vercel`: deploy to Vercel.
- Pushes to `main` auto-deploy: Vercel via its git integration, and
  ericxvoong.workers.dev via Cloudflare Workers Builds.
- Do not add a `frontend/public/_redirects` file. Wrangler 4 rejects catch-all
  rules there, `worker.ts` implements the SPA fallback in code, and Vercel
  handles rewrites in `vercel.json`.
- Typecheck frontend: `cd frontend && npx tsc --noEmit`. There is no root-level
  tsconfig; the frontend and `server/` each have their own. Note: several
  pre-existing type errors exist in `frontend/pages/*` unrelated to auth, so a
  non-empty output does not necessarily mean you broke something. Diff against
  the files you touched.

Local URLs: frontend `http://localhost:5000`, API `http://localhost:3001`. Vite
proxies `/api`, `/auth`, and `/db` to the API (see `frontend/vite.config.ts`).

## Architecture

### Layout

- `frontend/`: React SPA
  - `pages/`: one file per route (`QuickScore`, `Schedule`, `Roster`, `Stats`,
    `Ranking`, `Strategy`, `Chat`, `Login`, `ResetPassword`).
  - `components/`: shared widgets (`PlayerCombobox`, `PlayerAvatar`,
    `strategy/StrategyBoard`, and more).
  - `contexts/AuthContext.tsx`: session state, login/signup/OAuth/logout.
  - `hooks/backend/`: data hooks wrapping the DB proxy (`games`, `events`,
    `players`, `stats`, `attendance`, `strategy`).
  - `lib/`: `supabase.ts` (client pointed at the `/db` proxy), `authClient.ts`,
    and `shadcn/` UI primitives.
- `server/index.ts`: Express host. Mounts the gateway, serves `/uploads`, and
  holds the privileged Chat endpoints (Gemini and service-role queries).
- `gateway/`: framework-agnostic auth BFF (the security core, see below).
- `worker.ts`: Cloudflare Workers entry. Mounts the gateway and serves assets.
- `api/index.ts`: Vercel serverless entry.
- `supabase-migrations/`: SQL migrations, run manually in the Supabase SQL
  editor. `001_auth_allowlist_rls.sql` sets up the allowlist and RLS and
  documents the required Supabase dashboard steps in its header.
  `002_public_read_team_write.sql` opens reads to any authenticated user
  while keeping writes allowlist-only. `003_auto_grant_write_on_verify.sql`
  adds a trigger that allowlists users when they verify their email; its
  header documents the required "Confirm email" dashboard toggle and
  post-apply verification queries. `003_secrets_vault.sql` (an accidental
  numbering collision, both 003 files are applied) adds the Vault RPC for
  Gemini secrets. `004_jam_calendar_sync.sql` and `005_calendar_sources.sql`
  support the JAM calendar importer; 004's RLS block is the per-table
  template to copy for new tables. `006_strategy_board.sql` adds the Strategy board tables (plays and
  positions). `007_strategy_arrows.sql` adds the `strategy_arrows` table
  for the Strategy board's cutting arrows. New migrations start at 008.
- `supabase-schema.sql`: full base schema.

### Auth gateway (BFF): the security model

`gateway/index.ts` exports `createGateway(config)`, a framework-agnostic
`(Request) => Promise<Response | null>` that every host (Express, Workers,
Vercel) mounts. It owns two path prefixes and returns `null` for everything else
so the host can fall through to its own routing.

- `/auth/*`: login, Google OAuth (PKCE), token refresh, logout, session
  bootstrap, and password reset (`gateway/auth-handlers.ts`).
- `/db/*`: authenticated proxy to Supabase REST and Storage
  (`gateway/proxy.ts`), with transparent access-token refresh.

Key invariants (do not regress these):

- Sessions live in httpOnly cookies, never in JS-readable storage. The frontend
  Supabase client talks to `/db` with dummy credentials; real tokens are
  attached server-side by the proxy.
- Cookies use the `__Host-` prefix on HTTPS and are unprefixed on
  `http://localhost` (`gateway/cookies.ts`).
- CSRF: SameSite=Lax plus Origin and `Sec-Fetch-Site` validation
  (`gateway/csrf.ts`). The Vite dev proxy keeps `changeOrigin: false` for
  `/auth` and `/db` so the gateway sees the real `localhost:5000` Origin. Do not
  change this.
- RLS everywhere: any authenticated user may read; writes require the user's
  email to be in the `allowed_users` allowlist, checked by the
  security-definer `is_allowed()` function against the JWT email claim.
  Verifying an email adds it to the allowlist automatically (trigger from
  migration 003), so the allowlist's role is "verified users minus revoked
  ones": deleting a row revokes that account's write access. The allowlist
  table itself is not client-readable.
- The service-role key never reaches the browser and is only used by
  `server/index.ts` privileged endpoints, which call `createRequireAllowedUser`
  to verify the cookie and allowlist first. Never attach the service-role or
  secret key to a client-driven request.

### Passkeys

Passkey (WebAuthn) sign-in is enabled through Supabase Auth's passkeys beta.
The gateway proxies the GoTrue endpoints under `/auth/passkeys/*`
(registration and authentication options/verify, list, delete). The browser
only runs the WebAuthn ceremony via the native JSON APIs
(`PublicKeyCredential.parseCreationOptionsFromJSON`, `toJSON`); a successful
authentication verify becomes httpOnly session cookies exactly like password
login, so the cookie invariant above is preserved.

Passkeys are bound to a single Relying Party ID and only work on one
deployment: `ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev`. That
host is defined once as `PASSKEY_HOST` in `frontend/lib/passkeys.ts` and must
match `webauthn_rp_id` in the Supabase auth config (management API fields:
`passkey_enabled`, `webauthn_rp_id`, `webauthn_rp_display_name`,
`webauthn_rp_origins`). All passkey UI (login button, the passkeys dialog
in both shells) is hidden on other origins via `passkeysAvailable()`. If the
RP ID ever changes, every existing passkey stops working and must be
re-registered.

Both ceremonies are steered toward the device's own authenticator:
`preferPlatformAuthenticator` in `frontend/lib/passkeys.ts` adds
`hints: ["client-device"]` to registration and sign-in options, and forces
`authenticatorSelection.authenticatorAttachment: "platform"` at registration
so new passkeys are created on the device in use rather than via the QR
cross-device flow. QR sign-in remains available behind the browser's "more
options" fallback. Hardware security keys cannot be registered while the
platform attachment is forced.

## Environment variables

Set in `.env` (root) for local dev, and in the host dashboard for deploys.

- `SUPABASE_URL`: project URL.
- `SUPABASE_PUBLISHABLE_KEY`: public/anon key (safe for the gateway config).
- `SUPABASE_SECRET_KEY`: service-role key. Server-only. Never ship to the client.
- `SUPABASE_JWKS_URL`: defaults to
  `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
- `GEMINI_API_KEY` (or equivalent): for the Chat page.
- `PORT`: Express port (default 3001).

## Conventions

- Match the existing shadcn component style in `frontend/lib/shadcn/`.
- Data access from pages goes through `frontend/hooks/backend/*`, which use the
  `/db` proxy. Do not call Supabase directly with credentials from the client.
- Prefer a single source-of-truth constant over repeating a literal across UI,
  validation, and backend (see the password rule below).
- Relative imports in `server/`, `gateway/`, `worker.ts`, and `api/` must use
  explicit `.js` extensions (for example `from "../gateway/index.js"`). Vercel
  runs this code as native ESM, where extensionless specifiers fail at runtime
  with `ERR_MODULE_NOT_FOUND` and every request 500s. tsx, Vite, and wrangler
  all resolve `.js` specifiers to the `.ts` sources, so local dev and the
  Worker build behave the same.
- Never push directly to `main`. Create a branch and open a pull request, even
  for small fixes.

## Password minimum length

The minimum password length is 8 characters, defined once as
`PASSWORD_MIN_LENGTH` in `frontend/pages/Login.tsx`. That constant drives:

- the password `<input minLength={PASSWORD_MIN_LENGTH} />`,
- the inline hint ("Password must be at least 8 characters."), shown until the
  field reaches the minimum,
- the client-side guard in `handleSubmit`, which blocks submission and shows our
  own error before the request reaches Supabase.

Why the client-side guard matters: Supabase enforces its own minimum (default 6)
and returns a message worded around its number. If a short password reaches the
server, the user sees "6 characters" while our hint says "8", a contradiction.
The guard stops the request first so only the 8-character wording is ever shown.

If the minimum changes, update `PASSWORD_MIN_LENGTH` only, and set Supabase's
minimum (Dashboard, Authentication, Providers, Email, Minimum password length)
to match so both layers agree.

## Loading and entrance animations

Pages must load smoothly: no blank flash, no layout jump, and no abrupt pop-in
of cards as fetches resolve. Two shared building blocks enforce this, both built
on the `tailwindcss-animate` plugin (already a dependency):

- `frontend/lib/shadcn/skeleton.tsx`: the shadcn `Skeleton` primitive
  (`animate-pulse` placeholder block).
- `frontend/components/FadeIn.tsx`: wraps content so it fades and slides up on
  mount. Takes an optional `delay` (ms) to stagger list items and an optional
  `as` prop to render a different element (for example `as="tr"` inside tables).

The per-page pattern (applied to QuickScore, Schedule, Roster, Stats, Ranking,
and Chat):

- While a page's primary data is still loading (its hook `data` is `undefined`,
  or the hook `loading` flag before the first result), render skeletons shaped
  like the real content, not a generic spinner. Match the real card dimensions
  so nothing shifts when data arrives.
- Once data is ready, render the real content inside `FadeIn`. Stagger lists with
  `delay={index * 40}`; wrap standalone cards in a plain `FadeIn`.
- Chat is a light touch: message bubbles are wrapped in `FadeIn` (no skeleton).

When adding a new page or a new data-backed section, follow this same pattern.
Keep these changes presentational: do not entangle animation with data-fetching
logic.

Gotcha: FadeIn's fill-mode-both keeps an identity transform matrix applied to
the wrapper even after the entrance animation finishes, and any non-none
transform makes an element the containing block for position: fixed
descendants. Anything inside a page that must be positioned at viewport
coordinates (for example the Strategy board's drag ghost) has to render
through createPortal(document.body), or its fixed coordinates resolve against
the FadeIn wrapper instead of the viewport.

## Desktop sidebar and navigation

Nav tabs have a single source of truth: `NAV_ITEMS` and the `Tab` type in
`frontend/lib/nav.ts`. Both the desktop sidebar (`frontend/components/AppSidebar.tsx`)
and the mobile bottom nav in `frontend/App.tsx` consume this same list. Add new
pages or tabs there, not in either shell directly.

`App.tsx` picks between two shells based on `useMediaQuery('(min-width: 1024px)')`
(`frontend/lib/shadcn/use-media-query.ts`): a desktop sidebar shell
(`SidebarProvider` plus `AppSidebar` plus `SidebarInset`, with page content capped
at `max-w-5xl`) and the unchanged mobile bottom-nav shell below 1024px.

The sidebar primitive `frontend/lib/shadcn/sidebar.tsx` is vendored from shadcn
(Tailwind v3 variant); keep it close to upstream rather than customizing it
in place. Its internal breakpoint is 768px, which is why shell selection
happens in JS at 1024px instead of relying on CSS `hidden` classes.

## Strategy board

The Strategy page (`frontend/pages/Strategy.tsx`) is a play designer: named
plays whose player placements are dragged freely on an ultimate field, with a
bench tray of unplaced players below it.

- Data: `strategy_plays` and `strategy_positions`
  (`supabase-migrations/006_strategy_board.sql`), standard public-read and
  team-write RLS. One position row per (play, player), written with
  `upsert(onConflict: 'play_id,player_id')` on drop; dragging a player off
  the field deletes the row. Hooks live in
  `frontend/hooks/backend/strategy.ts`.
- Coordinates are fractions in [0, 1] of a canonical landscape field: x along
  the 100m length, y across the 37m width. The board renders landscape on
  desktop (1024px and up) and rotated to portrait on mobile;
  `frontend/components/strategy/StrategyBoard.tsx` owns the mapping between
  frames. Keep stored coordinates canonical; never store rendered offsets.
- Dragging uses native pointer events with `setPointerCapture` (no
  drag-and-drop library). Draggable avatars need `touch-none` and their
  images `draggable={false}` (both handled by
  `frontend/components/PlayerAvatar.tsx`, the shared avatar with the icon
  fallback), or native image drag and touch scrolling break the interaction.
- Saves are optimistic: local state updates on drop, and a failed write
  refetches positions to revert. No realtime sync; last write wins.

### Arrows

The board also supports freeform arrows that diagram player movement and
cuts. Arrows are annotations, not tied to any player.

- Data: `strategy_arrows` (`supabase-migrations/007_strategy_arrows.sql`),
  standard public-read and team-write RLS. Each arrow is a quadratic
  Bezier stored as canonical `[0, 1]` field fractions in the same frame as
  positions: start `(x1, y1)`, end `(x2, y2)`, control point `(cx, cy)`. A
  straight arrow stores `cx,cy` at the endpoints' midpoint; bending moves
  the control point. Hooks live in `frontend/hooks/backend/strategy.ts`
  (`useGetStrategyArrows`, `useCreateStrategyArrow`,
  `useUpdateStrategyArrow`, `useDeleteStrategyArrow`).
- Drawing: a "Draw arrow" toggle above the board turns on draw mode (the
  only trigger on touch); on desktop, holding the A key arms the same
  behaviour transiently. Dragging on empty field space draws a straight
  arrow. Player dragging is disabled while draw mode is on. The A-key
  listener ignores auto-repeat and typing contexts so a play name never
  arms drawing.
- Editing: tapping an arrow selects it and shows three handles (start,
  end, and an on-curve midpoint that bends the curve) plus a delete
  button near the end point. Tap empty space or press Escape to deselect.
  The control point is solved from the midpoint handle by
  `C = 2H - 0.5*(P0 + P2)`.
- Rendering: an SVG overlay fills the field with a `viewBox` matching the
  field aspect (`100 37` landscape, `37 100` portrait) so one unit equals
  one metre and strokes and arrowheads scale without distortion. The svg
  is `pointer-events: none`; only the arrow hit paths and handles are
  interactive, so arrows never block player drags. All arrows use one
  colour (`ARROW_COLOR`, amber-500).
- Saves are optimistic like positions: create adds a temporary
  negative-id arrow reconciled to the server id on success (with pending
  edits flushed and cancelled temp arrows cleaned up); edits and deletes
  write on release and refetch to revert on failure. No realtime; last
  write wins.

## Other reference docs

- `README.md`: user-facing overview and local setup.
- `CLOUDFLARE_DEPLOYMENT.md`, `SUPABASE_MULTI_DEPLOYMENT_FIX.md`, and
  `WHITE_SCREEN_FIX.md`: deployment and troubleshooting notes.
- `supabase-migrations/001_auth_allowlist_rls.sql`: auth setup and the required
  Supabase dashboard steps.
