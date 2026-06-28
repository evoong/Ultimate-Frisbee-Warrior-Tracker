import { useState } from 'react'
import Schedule from './pages/Schedule'
import Roster from './pages/Roster'
import QuickScore from './pages/QuickScore'
import Ranking from './pages/Ranking'
import Stats from './pages/Stats'
import { Calendar, Users, Zap, Award, BarChart3 } from 'lucide-react'

type Tab = 'schedule' | 'roster' | 'quickscore' | 'ranking' | 'stats'

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('quickscore')

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-primary">Ultimate Frisbee Warrior Tracker</h1>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-2xl mx-auto px-4 py-6 pb-24">
        {activeTab === 'schedule' && <Schedule />}
        {activeTab === 'roster' && <Roster />}
        {activeTab === 'quickscore' && <QuickScore />}
        {activeTab === 'ranking' && <Ranking />}
        {activeTab === 'stats' && <Stats />}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border">
        <div className="max-w-2xl mx-auto grid grid-cols-5">
          {([
            { key: 'quickscore', icon: Zap, label: 'Quick' },
            { key: 'schedule', icon: Calendar, label: 'Schedule' },
            { key: 'roster', icon: Users, label: 'Roster' },
            { key: 'ranking', icon: Award, label: 'Ranking' },
            { key: 'stats', icon: BarChart3, label: 'Stats' },
          ] as { key: Tab; icon: React.ComponentType<{ className?: string }>; label: string }[]).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex flex-col items-center gap-1 py-3 transition-colors ${
                activeTab === key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
