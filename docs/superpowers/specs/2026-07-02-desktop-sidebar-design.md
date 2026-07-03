# Desktop sidebar, mobile bottom nav

Design spec for splitting the app shell into two layouts: the existing mobile
bottom navigation, and a shadcn Sidebar shell for desktop.

## Goal

Desktop (large screens) should navigate through a collapsible left sidebar, not
the mobile bottom bar. Mobile stays exactly as it is today. Both layouts share
one nav configuration and one active-tab state so they never drift.

## Current state

- `frontend/App.tsx` is the whole shell: a sticky header (title, theme toggle,
  logout), an optional read-only banner shown when `!allowed`, a `<main>` content
  area, and a fixed bottom `<nav>` with 6 tabs. Everything is constrained to
  `max-w-2xl`.
- Navigation is tab state in `App.tsx` (`activeTab` / `setActiveTab`), not React
  Router. The 6 tabs are: `quickscore` (Quick, Zap), `schedule` (Games/Schedule,
  Calendar), `roster` (Squad/Roster, Users), `ranking` (Ranking, Award), `stats`
  (Stats, BarChart3), `chat` (AI, MessageCircle).
- shadcn primitives live in `frontend/lib/shadcn/` (not the default
  `components/ui`). There is no `components.json`, so the shadcn CLI is not wired
  up; primitives are added manually to that folder.
- `cn` lives in `frontend/lib/shadcn/utils.ts`.
- Tailwind is v3.4.19. Theme tokens are HSL CSS variables in
  `frontend/index.css` (`:root` and `.dark`), plus an alternate `orgTheme.css`.
  There are no `--sidebar-*` tokens yet.
- Installed Radix deps include dialog, tooltip, separator, and slot, so Sheet,
  Tooltip, and Separator can be added without new packages.

## Decisions

- Sidebar mode: `collapsible="icon"` (collapses to an icon rail; Cmd/Ctrl+B
  toggles).
- Desktop content width: full width via `SidebarInset`. Each page keeps its own
  inner width constraints, so nothing looks stretched.
- Theme toggle, logout, and user email move into the sidebar footer on desktop.
- Breakpoint: sidebar appears at `lg` (min-width 1024px). Below that, the mobile
  bottom nav is used.
- Shell selection is done by a JS media-query hook, not CSS `hidden lg:*`,
  because the shadcn Sidebar's own internal breakpoint is 768px (md). Mounting
  the sidebar shell only at >= 1024px keeps it always in true desktop mode and
  avoids it half-appearing (or switching to its mobile Sheet path) on tablets.

## Architecture

### Shared nav config

Extract the `tabs` array out of `App.tsx` into a single exported constant (for
example `frontend/lib/nav.ts`): an ordered list of `{ key, icon, label,
fullLabel }`. Both shells import it. This is the source of truth for navigation;
adding or reordering a tab happens in one place.

### Media-query hook

Add `frontend/lib/shadcn/use-media-query.ts` exporting `useMediaQuery(query)`
(subscribes to `window.matchMedia`). `App.tsx` uses
`useMediaQuery('(min-width: 1024px)')` to choose the shell. Also add the shadcn
`use-mobile.ts` (768px `useIsMobile`) that `sidebar.tsx` imports internally.

### shadcn primitives (added to `frontend/lib/shadcn/`)

- `sheet.tsx`, `tooltip.tsx`, `separator.tsx`: standard shadcn components, built
  on the already-installed Radix deps.
- `sidebar.tsx`: the official shadcn Sidebar, Tailwind-v3 variant (bracket
  syntax such as `w-[--sidebar-width]` and `bg-sidebar-*` color classes resolved
  via `tailwind.config.js`), not the v4 syntax in the current shadcn docs.

### AppSidebar component

`frontend/components/AppSidebar.tsx` renders the desktop sidebar:

- `SidebarHeader`: "Warrior Tracker" branding with an icon.
- `SidebarContent` > `SidebarMenu`: one `SidebarMenuItem` per shared nav tab,
  each a `SidebarMenuButton` with `isActive={activeTab === tab.key}` and
  `onClick={() => setActiveTab(tab.key)}`.
- `SidebarFooter`: user email, theme toggle, logout.
- `SidebarRail` (and/or a `SidebarTrigger`) for collapsing.

Props: `activeTab`, `setActiveTab`, `theme`, `toggleTheme`, `user`, `logout`.
It is a presentational component; all state stays in `App.tsx`.

### App.tsx shell

Wrap the app in `SidebarProvider`. Render the page content once via an existing
`renderPage()`-style switch. Then:

- Desktop (`isDesktop`): `<AppSidebar ... /> ` followed by `<SidebarInset>`
  holding the read-only banner (when `!allowed`) and the page content at full
  width.
- Mobile (`!isDesktop`): the current header + read-only banner + `<main>` +
  fixed bottom `<nav>`, unchanged, still `max-w-2xl`.

The read-only banner (`!allowed`) appears in both shells. `ResetPassword` and
the unauthenticated `Login` paths are unaffected (they short-circuit before the
shell, as today).

### Theme tokens

- Add `--sidebar-*` HSL variables to `frontend/index.css` `:root` and `.dark`
  (background, foreground, primary, primary-foreground, accent,
  accent-foreground, border, ring). Add matching values to `orgTheme.css` if it
  defines its own palette.
- Extend `tailwind.config.js` `theme.extend.colors` with a `sidebar` group
  mapping to those variables, so the v3 sidebar classes resolve.

## Out of scope / preserved

- Mobile layout, bottom nav, and all page internals stay byte-identical.
- No React Router; the tab-state model is kept.
- No new npm dependencies.

## Testing

- Manual: at >= 1024px the sidebar shows, collapses to icons via Cmd/Ctrl+B and
  the rail, active tab highlights correctly, and theme/logout work from the
  footer. Below 1024px the bottom nav is unchanged. Resizing across 1024px swaps
  shells without losing the active tab.
- `cd frontend && npx tsc --noEmit`: no new type errors beyond the known
  pre-existing ones in `pages/*`.
- `npm run build` succeeds.
