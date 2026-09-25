import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { adminGet } from '../../lib/adminClient'
import { Button } from '../../lib/shadcn/button'
import { Input } from '../../lib/shadcn/input'
import { Label } from '../../lib/shadcn/label'
import { Skeleton } from '../../lib/shadcn/skeleton'

type Grain = 'day' | 'week' | 'month'

type Bucket = { bucket: string; count: number }

// Mirrors the admin_dashboard RPC payload exactly (spec §RPCs,
// supabase/migrations/20260926000000_admin_dashboard.sql).
export type DashboardPayload = {
  range: { from: string; to: string; grain: Grain }
  usage: {
    totals: { orgs: number; members: number; players: number; games: number; game_events: number }
    series: { new_orgs: Bucket[]; new_games: Bucket[]; new_events: Bucket[] }
  }
  billing: {
    tier_mix: { free: number; plus: number; premium: number; employee_granted: number }
    active_trials: number
    ai_messages_in_range: number
    ai_cap_by_tier: { free: number; plus: number; premium: number }
  }
  engagement: {
    sign_ins: Bucket[]
    active_orgs_in_range: number
    dormant_orgs: number
  }
  ops: {
    top_orgs_by_events: { id: number; name: string; game_events: number }[]
    pending_invites: number
    unclaimed_player_links: number
    audit_events_in_range: number
  }
}

type Tab = 'usage' | 'billing' | 'engagement' | 'ops'

const TABS: { key: Tab; label: string }[] = [
  { key: 'usage', label: 'Usage' },
  { key: 'billing', label: 'Billing & AI' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'ops', label: 'Ops' },
]

const GRAINS: Grain[] = ['day', 'week', 'month']
const STORAGE_KEY = 'ufwt_admin_dash_range'
const RANGE_CAP_DAYS = 370
const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function toUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function addDaysIso(iso: string, days: number): string {
  return new Date(toUtcMs(iso) + days * DAY_MS).toISOString().slice(0, 10)
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function defaultRange(): { from: string; to: string; grain: Grain } {
  const to = todayIso()
  return { from: addDaysIso(to, -29), to, grain: 'day' }
}

// Read once on mount; anything malformed falls back to the defaults.
function loadStoredRange(): { from: string; to: string; grain: Grain } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultRange()
    const parsed = JSON.parse(raw)
    if (
      typeof parsed?.from === 'string' && ISO_DATE.test(parsed.from)
      && typeof parsed?.to === 'string' && ISO_DATE.test(parsed.to)
      && GRAINS.includes(parsed?.grain)
    ) {
      return { from: parsed.from, to: parsed.to, grain: parsed.grain }
    }
  } catch { /* private mode / bad JSON — defaults are fine */ }
  return defaultRange()
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="nav-mono mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
    </div>
  )
}

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 }

function SeriesChart({ title, data }: { title: string; data: Bucket[] }) {
  return (
    <div className="rounded border p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {data.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No data in range.</p>
      ) : (
        <div className="mt-3" style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="0" />
              <XAxis dataKey="bucket" axisLine={false} tickLine={false} tickMargin={8} tick={AXIS_TICK} />
              <YAxis allowDecimals={false} width={36} axisLine={false} tickLine={false} tick={AXIS_TICK} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="count"
                stroke="hsl(var(--foreground))"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [initial] = useState(loadStoredRange)
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [grain, setGrain] = useState<Grain>(initial.grain)
  const [tab, setTab] = useState<Tab>('usage')
  const [data, setData] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Persisted per device, same pattern as Stats' view prefs.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ from, to, grain }))
    } catch { /* private mode */ }
  }, [from, to, grain])

  const rangeError = !ISO_DATE.test(from) || !ISO_DATE.test(to)
    ? 'Enter both dates.'
    : from > to
      ? 'From must be on or before to.'
      : Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS) > RANGE_CAP_DAYS
        ? `Range must be ${RANGE_CAP_DAYS} days or fewer.`
        : null

  // One fetch per range/grain change — never per tab. Tab state is local on
  // purpose: a dashboard is glanceable, not deep-linkable.
  useEffect(() => {
    if (rangeError) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ from, to, grain })
    adminGet<DashboardPayload>(`/dashboard?${params}`)
      .then(payload => { if (!cancelled) setData(payload) })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load dashboard.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [from, to, grain, rangeError, reloadKey])

  if (loading) {
    return (
      <section className="space-y-6">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Skeleton className="h-64 w-full" />
      </section>
    )
  }

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="admin-dash-from" className="sr-only">From</Label>
          <Input
            id="admin-dash-from"
            type="date"
            value={from}
            onChange={event => setFrom(event.target.value)}
            className="w-40"
          />
        </div>
        <div>
          <Label htmlFor="admin-dash-to" className="sr-only">To</Label>
          <Input
            id="admin-dash-to"
            type="date"
            value={to}
            onChange={event => setTo(event.target.value)}
            className="w-40"
          />
        </div>
        <div role="group" aria-label="Grain" className="flex overflow-hidden rounded border">
          {GRAINS.map(g => (
            <button
              key={g}
              type="button"
              aria-pressed={g === grain}
              onClick={() => setGrain(g)}
              className={`px-3 py-2 text-sm capitalize ${g === grain ? 'bg-muted font-semibold' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {rangeError && (
        <p className="text-sm text-destructive" role="alert">{rangeError}</p>
      )}

      {error ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">{error}</p>
          <Button variant="outline" size="sm" onClick={() => setReloadKey(key => key + 1)}>Retry</Button>
        </div>
      ) : !data || rangeError ? null : (
        <>
          <div role="tablist" className="flex gap-4 border-b pb-2 text-sm">
            {TABS.map(t => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={tab === t.key ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground'}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'usage' && data && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <StatCard label="Organizations" value={data.usage.totals.orgs} />
                <StatCard label="Members" value={data.usage.totals.members} />
                <StatCard label="Players" value={data.usage.totals.players} />
                <StatCard label="Games" value={data.usage.totals.games} />
                <StatCard label="Game events" value={data.usage.totals.game_events} />
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <SeriesChart title="New organizations" data={data.usage.series.new_orgs} />
                <SeriesChart title="New games" data={data.usage.series.new_games} />
                <SeriesChart title="New game events" data={data.usage.series.new_events} />
              </div>
            </div>
          )}

          {tab === 'billing' && data && (
            <div className="space-y-6">
              <Panel title="Tier mix">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="Free" value={data.billing.tier_mix.free} />
                  <StatCard label="Plus" value={data.billing.tier_mix.plus} />
                  <StatCard label="Premium" value={data.billing.tier_mix.premium} />
                  <StatCard label="Employee granted" value={data.billing.tier_mix.employee_granted} />
                </div>
              </Panel>
              <div className="grid gap-3 sm:grid-cols-2">
                <StatCard label="Active trials" value={data.billing.active_trials} />
                {/* Controller ruling: chat_logs counts user+assistant rows
                    (~2x per exchange) vs billing counts, so this is labelled
                    "chat messages", never "billed AI messages". */}
                <StatCard label="Chat messages in range" value={data.billing.ai_messages_in_range} />
              </div>
              <Panel title="AI caps per month">
                <div className="max-w-xs overflow-hidden rounded border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-left">
                        <th className="p-3">Tier</th>
                        <th className="p-3 text-right">Messages</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Object.keys(data.billing.ai_cap_by_tier) as (keyof typeof data.billing.ai_cap_by_tier)[])
                        .map(tier => (
                          <tr key={tier} className="border-b last:border-b-0">
                            <td className="p-3 capitalize">{tier}</td>
                            <td className="nav-mono p-3 text-right">{data.billing.ai_cap_by_tier[tier]}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )}

          {tab === 'engagement' && data && (
            <div className="space-y-6">
              <SeriesChart title="Sign-ins" data={data.engagement.sign_ins} />
              <p className="text-xs text-muted-foreground">
                Counts users whose most recent sign-in falls in each bucket.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <StatCard label="Active orgs" value={data.engagement.active_orgs_in_range} />
                <StatCard label="Dormant orgs" value={data.engagement.dormant_orgs} />
              </div>
            </div>
          )}

          {tab === 'ops' && data && (
            <div className="space-y-6">
              <Panel title="Top organizations by game events">
                {data.ops.top_orgs_by_events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No game events in range.</p>
                ) : (
                  <ul className="divide-y rounded border">
                    {data.ops.top_orgs_by_events.map(org => (
                      <li key={org.id}>
                        <button
                          type="button"
                          onClick={() => navigate(`/admin/org/${org.id}`)}
                          className="flex w-full items-center justify-between p-3 text-left text-sm hover:bg-muted/50"
                        >
                          <span>{org.name}</span>
                          <span className="nav-mono">{org.game_events.toLocaleString()}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatCard label="Pending invites" value={data.ops.pending_invites} />
                <StatCard label="Unclaimed player links" value={data.ops.unclaimed_player_links} />
                <StatCard label="Audit events" value={data.ops.audit_events_in_range} />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
