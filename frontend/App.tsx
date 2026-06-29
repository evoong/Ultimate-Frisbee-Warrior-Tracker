import { useState } from 'react'
import Schedule from './pages/Schedule'
import Roster from './pages/Roster'
import QuickScore from './pages/QuickScore'
import Stats from './pages/Stats'
import { Calendar, Users, Zap, BarChart3 } from 'lucide-react'

const TABS = [
  { key: 'quickscore', label: 'QUICK',    fullLabel: 'QUICK SCORE', icon: Zap,       page: QuickScore },
  { key: 'schedule',   label: 'GAMES',    fullLabel: 'SCHEDULE',    icon: Calendar,  page: Schedule   },
  { key: 'roster',     label: 'SQUAD',    fullLabel: 'ROSTER',      icon: Users,     page: Roster     },
  { key: 'stats',      label: 'STATS',    fullLabel: 'STATISTICS',  icon: BarChart3, page: Stats      },
] as const

type TabKey = typeof TABS[number]['key']

const LIME = 'hsl(74 100% 50%)'
const LIME_DIM = 'hsl(74 100% 50% / 0.12)'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('quickscore')
  const active = TABS.find(t => t.key === activeTab)!
  const ActivePage = active.page

  return (
    <div style={{ minHeight: '100svh', display: 'flex', flexDirection: 'column', backgroundColor: 'hsl(216 14% 5%)' }}>

      {/* ── Header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'hsl(216 12% 7%)',
        borderBottom: '1px solid hsl(216 10% 13%)',
      }}>
        <div style={{ height: '2px', background: `linear-gradient(90deg, ${LIME}, hsl(142 72% 44%))` }} />
        <div style={{ maxWidth: 672, margin: '0 auto', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 10,
              letterSpacing: '0.18em',
              color: LIME,
              textTransform: 'uppercase' as const,
              fontWeight: 600,
              marginBottom: 2,
            }}>
              DISC-IPLES · WARRIOR TRACKER
            </p>
            <h1 style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 26,
              letterSpacing: '0.06em',
              lineHeight: 1,
              color: 'hsl(214 20% 93%)',
              margin: 0,
            }}>
              {active.fullLabel}
            </h1>
          </div>
          <div style={{
            width: 38, height: 38,
            borderRadius: '50%',
            background: LIME,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <ellipse cx="12" cy="12" rx="10" ry="4.5" stroke="#0A0C0F" strokeWidth="2"/>
              <ellipse cx="12" cy="12" rx="10" ry="10" stroke="#0A0C0F" strokeWidth="2"/>
              <line x1="2" y1="12" x2="22" y2="12" stroke="#0A0C0F" strokeWidth="1.5"/>
            </svg>
          </div>
        </div>
      </header>

      {/* ── Page Content ── */}
      <main style={{
        flex: 1,
        maxWidth: 672,
        margin: '0 auto',
        width: '100%',
        padding: '20px 16px 96px',
      }}>
        <ActivePage />
      </main>

      {/* ── Bottom Nav ── */}
      <nav style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'hsl(216 14% 4%)',
        borderTop: '1px solid hsl(216 10% 12%)',
        zIndex: 20,
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        <div style={{ maxWidth: 672, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.key
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  gap: 4, padding: '14px 4px 12px',
                  background: isActive ? LIME_DIM : 'transparent',
                  border: 'none', cursor: 'pointer',
                  borderTop: `2px solid ${isActive ? LIME : 'transparent'}`,
                  transition: 'background 0.15s ease, border-color 0.15s ease',
                }}
              >
                <Icon
                  size={20}
                  strokeWidth={isActive ? 2.5 : 1.8}
                  style={{ color: isActive ? LIME : 'hsl(216 8% 46%)', transition: 'color 0.15s ease' }}
                />
                <span style={{
                  fontFamily: "'Bebas Neue', sans-serif",
                  fontSize: 12,
                  letterSpacing: '0.1em',
                  color: isActive ? LIME : 'hsl(216 8% 42%)',
                  transition: 'color 0.15s ease',
                  lineHeight: 1,
                }}>
                  {tab.label}
                </span>
              </button>
            )
          })}
        </div>
      </nav>

    </div>
  )
}
