import { lazy, Suspense, useEffect, useState } from 'react'
import { useLocation, useNavigate, Routes, Route, Link } from 'react-router-dom'
const Schedule = lazy(() => import('./pages/Schedule'))
const Roster = lazy(() => import('./pages/Roster'))
const Stats = lazy(() => import('./pages/Stats'))
const Strategy = lazy(() => import('./pages/Strategy'))
const Chat = lazy(() => import('./pages/Chat'))
const Home = lazy(() => import('./pages/Home'))
const Login = lazy(() => import('./pages/Login'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const CreateOrganization = lazy(() => import('./pages/CreateOrganization'))
const PublicTeams = lazy(() => import('./pages/PublicTeams'))
import { useAuth } from './contexts/AuthContext'
import { Moon, Sun, Loader2, LogOut, KeyRound, Settings } from 'lucide-react'
import { NAV_ITEMS, visibleNavItems, tabForPath, pathForTab, isKnownPath, type Tab } from './lib/nav'
import { useMediaQuery } from './lib/shadcn/use-media-query'
import { SidebarProvider, SidebarInset, SidebarTrigger } from './lib/shadcn/sidebar'
import AppSidebar from './components/AppSidebar'
import PasskeysDialog from './components/PasskeysDialog'
import OrganizationSettingsDialog from './components/OrganizationSettingsDialog'
import { passkeysAvailable } from './lib/passkeys'

const THEME_KEY = 'ufwt_theme'

function getInitialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const PageFallback = () => (
  <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
    <Loader2 className="w-8 h-8 animate-spin text-primary" />
  </div>
)

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  // The active tab is derived from the URL (not its own state) so the
  // browser's back/forward buttons, a reload, or a bookmarked/shared link
  // all land on the right page. Switching tabs pushes a real history entry
  // via navigate() instead of just re-rendering in place.
  const activeTab = tabForPath(location.pathname)
  const setActiveTab = (tab: Tab) => navigate(pathForTab(tab))
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme)
  const [passkeysOpen, setPasskeysOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const { user, teams, currentTeamId, switchTeam, can, isGuest, loading, logout } = useAuth()

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  // Any unrecognized authenticated-tab URL (e.g. a stale/typo'd link)
  // redirects to the default tab rather than silently rendering Schedule at
  // a URL that doesn't say so. Scoped to signed-in users only: while signed
  // out, '/' and '/login' are real public pages (Home/Login below), not
  // unrecognized paths to bounce from.
  //
  // A guest hitting a member-only route (/plays, /ai) by typing it directly
  // gets the same bounce: those routes are omitted from pageContent below,
  // so without this the Routes below would just render nothing.
  useEffect(() => {
    if (!user) return
    if (location.pathname === '/reset-password') return
    if (!isKnownPath(location.pathname)) {
      navigate(pathForTab('schedule'), { replace: true })
      return
    }
    const tab = tabForPath(location.pathname)
    if (isGuest && !visibleNavItems(isGuest).some(item => item.key === tab)) {
      navigate(pathForTab('schedule'), { replace: true })
    }
  }, [location.pathname, user, isGuest])

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  if (loading) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  // Recovery-link landing page (the auth gateway redirects here after
  // verifying the email token and setting session cookies).
  if (window.location.pathname === '/reset-password') {
    return (
      <Suspense fallback={<PageFallback />}>
        <ResetPassword />
      </Suspense>
    )
  }

  // Anyone signed in may enter. Write access requires actual membership in
  // the current team -- under strict RLS a public team is readable by
  // anyone signed in, but writable only by its own members, never by a
  // guest or an outside signed-in user just because it's public.
  // `can.record` means "member of the current team — can write"; write
  // controls are gated on it, and the DB's RLS is the real enforcement.
  // Guests (`isGuest`) hold no role on any team, so they never see a write
  // control regardless of `can`.
  //
  // Signed out: '/login' is the sign-in/sign-up form; every other path
  // (including '/', the marketing homepage, and any unrecognized URL) shows
  // Home, so a shared/bookmarked deep link to the app still lands on a real
  // page instead of a redirect loop. Once signed in, the unknown-path effect
  // above takes over and these two paths stop being special.
  if (!user) {
    return (
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Home theme={theme} toggleTheme={toggleTheme} />} />
        </Routes>
      </Suspense>
    )
  }

  // Every domain table requires an organization_id, so a user with zero
  // memberships has nothing to see yet: send them to create one first.
  // Guests hold zero memberships by design (they browse the public team
  // read-only), so this only fires for a real signed-in user.
  if (!isGuest && teams.length === 0) {
    return (
      <Suspense fallback={<PageFallback />}>
        <CreateOrganization />
      </Suspense>
    )
  }

  // A guest who hasn't picked a team yet has no organization_id to scope
  // Schedule/Roster/Stats to, so the normal shell has nothing to render.
  // Show the public-teams browser instead of the shell entirely; once
  // switchTeam() sets currentTeamId (still granting no capability -- `can`
  // stays NO_CAPABILITIES for a guest regardless of which team is current,
  // since `role` is derived from `teams`, which is empty for a guest) the
  // branches below take over and the normal shell renders.
  if (isGuest && currentTeamId == null) {
    return (
      <Suspense fallback={<PageFallback />}>
        <PublicTeams />
      </Suspense>
    )
  }

  // Each tab additionally accepts one sub-path (a specific game, player,
  // play, or stats sub-tab), so the page component itself reads that piece
  // of state from useParams() rather than only ever owning it as in-memory
  // state — see the "selected game/player/play mirrors the URL" comments in
  // Schedule.tsx/Roster.tsx/Strategy.tsx and Stats.tsx's subtab handling.
  const pageContent = (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/schedule/:gameId" element={<Schedule />} />
        <Route path="/roster" element={<Roster />} />
        <Route path="/roster/:playerId" element={<Roster />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/stats/:subtab" element={<Stats />} />
        {/* Not a nav tab (see lib/nav.ts's EXTRA_KNOWN_PATHS) -- this is how
            a guest who already picked a team gets back to the browser to
            pick a different one. */}
        <Route path="/teams" element={<PublicTeams />} />
        {!isGuest && <Route path="/plays" element={<Strategy />} />}
        {!isGuest && <Route path="/plays/:playId" element={<Strategy />} />}
        {!isGuest && <Route path="/ai" element={<Chat />} />}
      </Routes>
    </Suspense>
  )

  const guestNotice = isGuest && (
    <div className="border-b bg-muted/60 px-4 py-2 text-center text-sm">
      You're browsing as a guest.{' '}
      <Link to="/login" className="font-medium underline">Sign up</Link>{' '}
      to join a team and track your own stats.
    </div>
  )

  const readOnlyNotice = !isGuest && !can.record && (
    <div className="border-b bg-muted/60 px-4 py-2 text-center text-sm">
      You don't have permission to change this team's data.
    </div>
  )

  // Desktop: collapsible sidebar shell.
  if (isDesktop) {
    const activeLabel = NAV_ITEMS.find(item => item.key === activeTab)?.label ?? ''
    return (
      <SidebarProvider>
        <AppSidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          theme={theme}
          toggleTheme={toggleTheme}
          userEmail={user.email ?? 'Guest'}
          logout={logout}
          teams={teams}
          currentTeamId={currentTeamId}
          switchTeam={switchTeam}
          isGuest={isGuest}
          openSettings={() => setSettingsOpen(true)}
          openPasskeys={passkeysAvailable() ? () => setPasskeysOpen(true) : undefined}
        />
        <PasskeysDialog open={passkeysOpen} onOpenChange={setPasskeysOpen} />
        <OrganizationSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-card px-4">
            <SidebarTrigger />
            <h1 className="text-lg font-bold text-primary">{activeLabel}</h1>
          </header>
          {guestNotice}
          {readOnlyNotice}
          <main className="mx-auto w-full max-w-5xl px-6 py-6">
            {pageContent}
          </main>
        </SidebarInset>
      </SidebarProvider>
    )
  }

  // Mobile: sticky header plus fixed bottom navigation.
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-primary">Warrior Tracker</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Organization settings"
            >
              <Settings className="w-5 h-5" />
            </button>
            {passkeysAvailable() && (
              <button
                onClick={() => setPasskeysOpen(true)}
                className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Manage passkeys"
              >
                <KeyRound className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={() => logout()}
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Sign out"
              title={user.email ?? 'Guest'}
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {teams.length > 1 && (
        <div className="bg-card border-b border-border px-4 py-2">
          <select
            value={currentTeamId ?? ''}
            onChange={e => switchTeam(Number(e.target.value))}
            className="w-full text-sm bg-transparent border border-border rounded-md px-2 py-1"
          >
            {teams.map(t => (
              <option key={t.organization_id} value={t.organization_id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {guestNotice}
      {readOnlyNotice}

      <PasskeysDialog open={passkeysOpen} onOpenChange={setPasskeysOpen} />
      <OrganizationSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      <main className="max-w-2xl mx-auto px-4 py-6 pb-24">
        {pageContent}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border">
        <div className="max-w-2xl mx-auto grid" style={{ gridTemplateColumns: `repeat(${visibleNavItems(isGuest).length}, minmax(0, 1fr))` }}>
          {visibleNavItems(isGuest).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex flex-col items-center gap-1 py-3 transition-colors ${
                activeTab === key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
