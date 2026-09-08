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
import { Loader2, LogOut } from 'lucide-react'
import { NAV_ITEMS, visibleNavItems, tabForPath, pathForTab, isKnownPath, renamedPathFor, type Tab } from './lib/nav'
import { useMediaQuery } from './lib/shadcn/use-media-query'
import { SidebarProvider, SidebarInset } from './lib/shadcn/sidebar'
import AppSidebar from './components/AppSidebar'
import PasskeysDialog from './components/PasskeysDialog'
import OrganizationSettingsDialog from './components/OrganizationSettingsDialog'
import FeedbackDialog from './components/FeedbackDialog'
import ThemeToggle from './components/nav/ThemeToggle'
import UserMenu from './components/nav/UserMenu'
import WorkspaceSwitcher from './components/nav/WorkspaceSwitcher'
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
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const { user, teams, currentTeamId, switchTeam, can, role, isGuest, loading, logout } = useAuth()

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
  // A guest hitting a member-only route (/playbook, /coach) by typing it
  // directly gets the same bounce: those routes are omitted from pageContent
  // below, so without this the Routes below would just render nothing.
  useEffect(() => {
    if (!user) return
    if (location.pathname === '/reset-password') return
    // Links minted before Plays/AI were renamed still have to land on the
    // real page. Without this they are simply "unknown" and get dropped on
    // /schedule below, which loses the thing the link was pointing at.
    const renamed = renamedPathFor(location.pathname)
    if (renamed) {
      navigate(renamed, { replace: true })
      return
    }
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

  // A guest is a real (anonymous) Supabase user, so '/login' is unreachable
  // while one is signed in: the unknown-path effect above replaces it with
  // /schedule. Linking to it did nothing but bounce. Ending the anonymous
  // session first is what makes the form reachable, and a guest owns no
  // data, so nothing is lost by doing it.
  const signUpFromGuest = async () => {
    await logout()
    navigate('/login')
  }

  const guestNotice = isGuest && (
    <div className="border-b bg-muted/60 px-4 py-2 text-center text-sm">
      You're browsing as a guest.{' '}
      <button type="button" onClick={signUpFromGuest} className="font-medium underline">
        Sign up
      </button>{' '}
      to join a team and track your own stats.
      {/* The only entry point to /teams once a guest has picked one. The
          route exists for exactly this, but nothing linked to it, so the
          choice was effectively permanent until the session ended. Omitted
          while currentTeamId is null, since that case already renders the
          browser itself. */}
      {currentTeamId != null && (
        <>
          {' '}
          <Link to="/teams" className="font-medium underline">Browse other teams</Link>.
        </>
      )}
    </div>
  )

  const readOnlyNotice = !isGuest && !can.record && (
    <div className="border-b bg-muted/60 px-4 py-2 text-center text-sm">
      You don't have permission to change this team's data.
    </div>
  )

  // A guest who hasn't picked a team yet has no organization_id to scope
  // Schedule/Roster/Stats to, so the normal shell has nothing to render.
  // Show the public-teams browser instead of the shell entirely; once
  // switchTeam() sets currentTeamId (still granting no capability -- `can`
  // stays NO_CAPABILITIES for a guest regardless of which team is current,
  // since `role` is derived from `teams`, which is empty for a guest) the
  // branches below take over and the normal shell renders.
  //
  // Sign out lives in the shell (sidebar on desktop, header on mobile), so
  // this branch has to carry its own copy: without it a guest who lands
  // here -- which is every guest, and permanently so when no team is public
  // -- has no control anywhere on screen that ends the session.
  if (isGuest && currentTeamId == null) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <header className="bg-card border-b border-border sticky top-0 z-10">
          <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
            <h1 className="text-lg font-bold text-primary">Warrior Tracker</h1>
            <div className="flex items-center gap-1">
              <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
              <button
                onClick={() => logout()}
                className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>
        {guestNotice}
        <Suspense fallback={<PageFallback />}>
          <PublicTeams />
        </Suspense>
      </div>
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
        {!isGuest && <Route path="/playbook" element={<Strategy />} />}
        {!isGuest && <Route path="/playbook/:playId" element={<Strategy />} />}
        {!isGuest && <Route path="/coach" element={<Chat />} />}
      </Routes>
    </Suspense>
  )

  // Desktop: collapsible sidebar shell.
  if (isDesktop) {
    const activeLabel = NAV_ITEMS.find(item => item.key === activeTab)?.label ?? ''
    return (
      <SidebarProvider>
        <AppSidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          userEmail={user.email}
          role={role}
          logout={logout}
          teams={teams}
          currentTeamId={currentTeamId}
          switchTeam={switchTeam}
          isGuest={isGuest}
          openSettings={() => setSettingsOpen(true)}
          openPasskeys={passkeysAvailable() ? () => setPasskeysOpen(true) : undefined}
          openFeedback={() => setFeedbackOpen(true)}
        />
        <PasskeysDialog open={passkeysOpen} onOpenChange={setPasskeysOpen} />
        <OrganizationSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        <SidebarInset>
          {/* The theme toggle sits here, with the utility icons, rather than
              as a labelled row in the sidebar -- see components/nav/ThemeToggle.
              The panel collapse control is the opposite case and lives in the
              sidebar's own header (components/nav/PanelToggle): it acts on the
              panel, not on the page. */}
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-card px-4">
            <h1 className="text-[15px] font-semibold tracking-[-0.014em] text-foreground">{activeLabel}</h1>
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} className="ml-auto" />
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
      {/* Mobile carries the same two controls as the desktop shell, in the
          same places: the workspace on the left, one theme toggle and one
          account menu on the right. The five loose icons and the separate
          team <select> bar below them were the same pile of leftover links
          the sidebar footer had, just laid out horizontally. */}
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-3 py-2 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher
              teams={teams}
              currentTeamId={currentTeamId}
              switchTeam={switchTeam}
              variant="bar"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
            <UserMenu
              email={user.email}
              role={role}
              isGuest={isGuest}
              logout={logout}
              openSettings={() => setSettingsOpen(true)}
              openPasskeys={passkeysAvailable() ? () => setPasskeysOpen(true) : undefined}
              openFeedback={() => setFeedbackOpen(true)}
              variant="bar"
            />
          </div>
        </div>
      </header>

      {guestNotice}
      {readOnlyNotice}

      <PasskeysDialog open={passkeysOpen} onOpenChange={setPasskeysOpen} />
      <OrganizationSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />

      <main className="max-w-2xl mx-auto px-4 py-6 pb-24">
        {pageContent}
      </main>

      {/* The active cell carries a 2px accent bar on its top edge -- the same
          marker the sidebar puts on the left edge of the active item, rotated
          to the edge the bottom nav actually has, and the same filled glyph.
          Colour alone was doing all the work here, and 'slightly darker grey'
          is not a position. */}
      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border">
        <div className="max-w-2xl mx-auto grid" style={{ gridTemplateColumns: `repeat(${visibleNavItems(isGuest).length}, minmax(0, 1fr))` }}>
          {visibleNavItems(isGuest).map(({ key, icon: Icon, label }) => {
            const isActive = activeTab === key
            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex flex-col items-center gap-1 py-3 transition-colors before:absolute before:inset-x-4 before:top-0 before:h-[2px] before:rounded-b-full before:bg-[hsl(var(--nav-accent))] before:transition-opacity before:content-[''] motion-reduce:before:transition-none ${
                  isActive
                    ? 'font-semibold text-foreground before:opacity-100 [&>svg]:text-[hsl(var(--nav-accent-ink))]'
                    : 'text-muted-foreground hover:text-foreground before:opacity-0'
                }`}
              >
                <Icon className="w-5 h-5" weight={isActive ? 'fill' : 'regular'} />
                <span className="text-[10px] font-medium">{label}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
