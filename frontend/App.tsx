import { useEffect, useState } from 'react'
import Schedule from './pages/Schedule'
import Roster from './pages/Roster'
import QuickScore from './pages/QuickScore'
import Ranking from './pages/Ranking'
import Stats from './pages/Stats'
import Chat from './pages/Chat'
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import { useAuth } from './contexts/AuthContext'
import { Calendar, Users, Zap, Award, BarChart3, MessageCircle, Moon, Sun, Loader2, LogOut } from 'lucide-react'

type Tab = 'schedule' | 'roster' | 'quickscore' | 'ranking' | 'stats' | 'chat'

const THEME_KEY = 'ufwt_theme'

function getInitialTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('quickscore')
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme)
  const { user, allowed, loading, logout } = useAuth()

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

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
    return <ResetPassword />
  }

  // Anyone signed in may enter (read-only). The `allowed` flag now means
  // "team member — can write"; write controls are gated on it, and the DB's
  // RLS is the real enforcement (002_public_read_team_write.sql).
  if (!user) {
    return <Login />
  }

  const tabs = [
    { key: 'quickscore' as Tab, icon: Zap, label: 'Quick' },
    { key: 'schedule' as Tab, icon: Calendar, label: 'Schedule' },
    { key: 'roster' as Tab, icon: Users, label: 'Roster' },
    { key: 'ranking' as Tab, icon: Award, label: 'Ranking' },
    { key: 'stats' as Tab, icon: BarChart3, label: 'Stats' },
    { key: 'chat' as Tab, icon: MessageCircle, label: 'AI' },
  ]

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-primary">Warrior Tracker</h1>
          <div className="flex items-center gap-1">
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
              title={user.email}
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Read-only notice for signed-in users who aren't on the team allowlist. */}
      {!allowed && (
        <div className="bg-accent border-b border-border">
          <div className="max-w-2xl mx-auto px-4 py-2 text-xs text-muted-foreground text-center">
            You have read-only access. Ask a team admin to add you for editing.
          </div>
        </div>
      )}

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 py-6 pb-24">
        {activeTab === 'schedule' && <Schedule />}
        {activeTab === 'roster' && <Roster />}
        {activeTab === 'quickscore' && <QuickScore />}
        {activeTab === 'ranking' && <Ranking />}
        {activeTab === 'stats' && <Stats />}
        {activeTab === 'chat' && <Chat />}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border">
        <div className="max-w-2xl mx-auto grid grid-cols-6">
          {tabs.map(({ key, icon: Icon, label }) => (
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
