import { useState } from 'react'
import Schedule from './pages/Schedule'
import Roster from './pages/Roster'
import QuickScore from './pages/QuickScore'
import Stats from './pages/Stats'
import { Calendar, Users, Zap, BarChart3 } from 'lucide-react'

export default function App() {
  const [activeTab, setActiveTab] = useState<'schedule' | 'roster' | 'quickscore' | 'stats'>('quickscore')

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
        {activeTab === 'stats' && <Stats />}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border">
        <div className="max-w-2xl mx-auto grid grid-cols-4">
          <button
            onClick={() => setActiveTab('quickscore')}
            className={`flex flex-col items-center gap-1 py-3 transition-colors ${
              activeTab === 'quickscore'
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Zap className="w-6 h-6" />
            <span className="text-xs font-medium">Quick</span>
          </button>
          <button
            onClick={() => setActiveTab('schedule')}
            className={`flex flex-col items-center gap-1 py-3 transition-colors ${
              activeTab === 'schedule'
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Calendar className="w-6 h-6" />
            <span className="text-xs font-medium">Schedule</span>
          </button>
          <button
            onClick={() => setActiveTab('roster')}
            className={`flex flex-col items-center gap-1 py-3 transition-colors ${
              activeTab === 'roster'
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Users className="w-6 h-6" />
            <span className="text-xs font-medium">Roster</span>
          </button>
          <button
            onClick={() => setActiveTab('stats')}
            className={`flex flex-col items-center gap-1 py-3 transition-colors ${
              activeTab === 'stats'
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <BarChart3 className="w-6 h-6" />
            <span className="text-xs font-medium">Stats</span>
          </button>
        </div>
      </nav>
    </div>
  )
}
