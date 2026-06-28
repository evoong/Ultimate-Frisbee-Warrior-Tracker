import { useEffect, useMemo, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useGetPlayerStats, useGetSeasons, useGetCumulativeStats, useGetAllSeasons } from '../hooks/backend/stats'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Label } from '../lib/shadcn/label'
import { BarChart3, TrendingUp, LineChart as LineChartIcon } from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  LineChart,
  Line,
} from 'recharts'

type PlayerStat = {
  player_id: number
  player_name: string
  goals: string
  assists: string
  turnovers: string
  games_played: string
  ga_rank: number
}

type CumulativeRow = {
  game_id: number
  opponent: string
  game_date: string
  player_id: number
  player_name: string
  goals: string
  assists: string
  turnovers: string
}

type Season = { id: number; name: string; year: number }

type ChartTab = 'combined' | 'goals' | 'assists' | 'turnovers'
type CumulativeStat = 'ga' | 'goals' | 'assists' | 'turnovers'

const CHART_TABS: { key: ChartTab; label: string }[] = [
  { key: 'combined', label: 'All Stats' },
  { key: 'goals', label: 'Goals' },
  { key: 'assists', label: 'Assists' },
  { key: 'turnovers', label: 'Turnovers' },
]

const CUMULATIVE_TABS: { key: CumulativeStat; label: string }[] = [
  { key: 'ga', label: 'G+A' },
  { key: 'goals', label: 'Goals' },
  { key: 'assists', label: 'Assists' },
  { key: 'turnovers', label: 'Turnovers' },
]

const LINE_COLORS = [
  '#16a34a', '#2563eb', '#dc2626', '#d97706',
  '#7c3aed', '#0891b2', '#be185d', '#65a30d',
]

export default function Stats() {
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: seasons, trigger: fetchSeasons } = useGetSeasons()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: stats, loading, error, trigger: fetchStats } = useGetPlayerStats()
  const { data: cumulativeRaw, loading: cumulativeLoading, trigger: fetchCumulative } = useGetCumulativeStats()

  const [filterType, setFilterType] = useState<'all' | 'season' | 'games'>('all')
  const [selectedSeasonId, setSelectedSeasonId] = useState<string>('')
  const [selectedGameIds, setSelectedGameIds] = useState<number[]>([])
  const [chartTab, setChartTab] = useState<ChartTab>('combined')

  const [cumulativeSeasonId, setCumulativeSeasonId] = useState<string>('')
  const [cumulativeStat, setCumulativeStat] = useState<CumulativeStat>('ga')

  useEffect(() => {
    fetchGames()
    fetchSeasons()
    fetchAllSeasons()
  }, [])

  // Auto-select the first season for the cumulative chart
  useEffect(() => {
    const s = allSeasons as Season[] | undefined
    if (s && s.length > 0 && !cumulativeSeasonId) {
      const first = s[s.length - 1] // oldest season
      setCumulativeSeasonId(String(first.id))
    }
  }, [allSeasons])

  useEffect(() => {
    if (filterType === 'all') {
      fetchStats({})
    } else if (filterType === 'season' && selectedSeasonId) {
      fetchStats({ seasonId: parseInt(selectedSeasonId) })
    } else if (filterType === 'games' && selectedGameIds.length > 0) {
      fetchStats({ gameIds: selectedGameIds })
    }
  }, [filterType, selectedSeasonId, selectedGameIds])

  useEffect(() => {
    if (cumulativeSeasonId) {
      fetchCumulative({ seasonId: parseInt(cumulativeSeasonId) })
    } else {
      fetchCumulative({})
    }
  }, [cumulativeSeasonId])

  const handleGameToggle = (gameId: number) => {
    setSelectedGameIds(prev =>
      prev.includes(gameId) ? prev.filter(id => id !== gameId) : [...prev, gameId]
    )
  }

  // ── Bar chart data ──────────────────────────────────────────────────────────
  const chartData = stats
    ? [...(stats as PlayerStat[])]
        .sort((a, b) => parseInt(b.goals) + parseInt(b.assists) - (parseInt(a.goals) + parseInt(a.assists)))
        .slice(0, 12)
        .map(p => ({
          name: p.player_name.split(' ')[0],
          fullName: p.player_name,
          Goals: parseInt(p.goals),
          Assists: parseInt(p.assists),
          Turnovers: parseInt(p.turnovers),
        }))
    : []

  // ── Cumulative line chart data ───────────────────────────────────────────────
  const { lineData, topPlayers } = useMemo(() => {
    const rows = cumulativeRaw as CumulativeRow[] | undefined
    if (!rows || rows.length === 0) return { lineData: [], topPlayers: [] }

    // Build ordered game list (deduplicated, sorted by date then id)
    const gameOrder: { game_id: number; opponent: string; game_date: string }[] = []
    const seenGames = new Set<number>()
    for (const r of rows) {
      if (!seenGames.has(r.game_id)) {
        seenGames.add(r.game_id)
        gameOrder.push({ game_id: r.game_id, opponent: r.opponent, game_date: r.game_date })
      }
    }

    // Per-game stats per player
    const perGamePlayer: Record<number, Record<number, { goals: number; assists: number; turnovers: number }>> = {}
    for (const r of rows) {
      if (!perGamePlayer[r.game_id]) perGamePlayer[r.game_id] = {}
      perGamePlayer[r.game_id]![r.player_id] = {
        goals: parseInt(r.goals),
        assists: parseInt(r.assists),
        turnovers: parseInt(r.turnovers),
      }
    }

    // Total per player to pick top 8
    const playerTotals: Record<number, { name: string; total: number }> = {}
    for (const r of rows) {
      if (!playerTotals[r.player_id]) playerTotals[r.player_id] = { name: r.player_name, total: 0 }
      const v = cumulativeStat === 'goals' ? parseInt(r.goals)
        : cumulativeStat === 'assists' ? parseInt(r.assists)
        : cumulativeStat === 'turnovers' ? parseInt(r.turnovers)
        : parseInt(r.goals) + parseInt(r.assists)
      playerTotals[r.player_id]!.total += v
    }

    const topPlayers = Object.entries(playerTotals)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 8)
      .map(([id, { name }]) => ({ id: parseInt(id), name }))

    // Build cumulative running totals
    const cumulative: Record<number, number> = {}
    for (const p of topPlayers) cumulative[p.id] = 0

    const lineData = gameOrder.map((game, idx) => {
      const point: Record<string, unknown> = {
        label: `G${idx + 1}`,
        fullLabel: `vs ${game.opponent}`,
      }
      for (const p of topPlayers) {
        const gs = perGamePlayer[game.game_id]?.[p.id] ?? { goals: 0, assists: 0, turnovers: 0 }
        const v = cumulativeStat === 'goals' ? gs.goals
          : cumulativeStat === 'assists' ? gs.assists
          : cumulativeStat === 'turnovers' ? gs.turnovers
          : gs.goals + gs.assists
        cumulative[p.id] += v
        point[p.name] = cumulative[p.id]
      }
      return point
    })

    return { lineData, topPlayers }
  }, [cumulativeRaw, cumulativeStat])

  const BarTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
    if (!active || !payload?.length) return null
    const full = chartData.find(d => d.name === label)
    return (
      <div className="bg-card border border-border rounded-lg shadow-md p-3 text-sm">
        <p className="font-semibold text-foreground mb-1">{full?.fullName ?? label}</p>
        {payload.map(entry => (
          <p key={entry.name} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {entry.value}
          </p>
        ))}
      </div>
    )
  }

  const LineTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
    if (!active || !payload?.length) return null
    const point = lineData.find(d => d.label === label)
    return (
      <div className="bg-card border border-border rounded-lg shadow-md p-3 text-sm max-w-[200px]">
        <p className="font-semibold text-foreground mb-1 text-xs">{String(point?.fullLabel ?? label)}</p>
        {payload
          .filter(e => e.value > 0)
          .sort((a, b) => b.value - a.value)
          .map(entry => (
            <p key={entry.name} style={{ color: entry.color }} className="font-medium text-xs">
              {entry.name}: {entry.value}
            </p>
          ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Player Stats</h1>

      {/* Filters */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Filter By</Label>
            <Select value={filterType} onValueChange={(val: 'all' | 'season' | 'games') => {
              setFilterType(val)
              setSelectedGameIds([])
              setSelectedSeasonId('')
            }}>
              <SelectTrigger className="bg-background text-foreground border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Games</SelectItem>
                <SelectItem value="season">By Season</SelectItem>
                <SelectItem value="games">Specific Games</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filterType === 'season' && (
            <div className="space-y-2">
              <Label>Select Season</Label>
              <Select value={selectedSeasonId} onValueChange={setSelectedSeasonId}>
                <SelectTrigger className="bg-background text-foreground border-border">
                  <SelectValue placeholder="Choose season..." />
                </SelectTrigger>
                <SelectContent>
                  {seasons?.map((season: { season_id: number; game_count: string }) => (
                    <SelectItem key={season.season_id} value={season.season_id.toString()}>
                      Season {season.season_id} ({season.game_count} games)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {filterType === 'games' && (
            <div className="space-y-2">
              <Label>Select Games</Label>
              <div className="max-h-40 overflow-y-auto space-y-1 bg-background rounded-md border border-border p-3">
                {games?.map((game: { id: number; opponent: string; game_date: string }) => (
                  <label
                    key={game.id}
                    className="flex items-center gap-3 cursor-pointer hover:bg-accent rounded px-2 py-1.5 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedGameIds.includes(game.id)}
                      onChange={() => handleGameToggle(game.id)}
                      className="w-4 h-4 rounded border-border"
                    />
                    <span className="text-sm text-foreground">
                      vs {game.opponent} — {new Date(game.game_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bar chart */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Performance Chart
          </CardTitle>
          <div className="flex gap-1 mt-2 bg-muted rounded-lg p-1">
            {CHART_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setChartTab(tab.key)}
                className={`flex-1 text-xs py-1.5 px-2 rounded-md font-medium transition-colors ${
                  chartTab === tab.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          {loading ? (
            <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading...</div>
          ) : error ? (
            <div className="flex items-center justify-center h-48 text-destructive text-sm">Error: {error}</div>
          ) : chartData.length > 0 ? (
            <div className="w-full" style={{ height: Math.max(200, chartData.length * 36) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }} barCategoryGap="20%">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={56} tick={{ fontSize: 11, fill: 'hsl(var(--foreground))' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<BarTooltip />} cursor={{ fill: 'hsl(var(--accent))' }} />
                  {(chartTab === 'combined' || chartTab === 'goals') && <Bar dataKey="Goals" fill="#16a34a" radius={[0, 3, 3, 0]} maxBarSize={14} />}
                  {(chartTab === 'combined' || chartTab === 'assists') && <Bar dataKey="Assists" fill="#2563eb" radius={[0, 3, 3, 0]} maxBarSize={14} />}
                  {(chartTab === 'combined' || chartTab === 'turnovers') && <Bar dataKey="Turnovers" fill="#ea580c" radius={[0, 3, 3, 0]} maxBarSize={14} />}
                  {chartTab === 'combined' && <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />}
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <TrendingUp className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">
                {filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view stats' : 'No stats available yet'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Cumulative Progression Chart ────────────────────────────────────── */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <LineChartIcon className="w-4 h-4" />
            Season Progression
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">Cumulative stats per game — top 8 players</p>

          {/* Season picker */}
          <div className="mt-3 space-y-1">
            <Label className="text-xs text-muted-foreground">Season</Label>
            <Select value={cumulativeSeasonId} onValueChange={setCumulativeSeasonId}>
              <SelectTrigger className="bg-background text-foreground border-border h-8 text-sm">
                <SelectValue placeholder="All games" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All games</SelectItem>
                {(allSeasons as Season[] | undefined)?.map(s => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name} {s.year}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Stat tab switcher */}
          <div className="flex gap-1 mt-2 bg-muted rounded-lg p-1">
            {CUMULATIVE_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setCumulativeStat(tab.key)}
                className={`flex-1 text-xs py-1.5 px-2 rounded-md font-medium transition-colors ${
                  cumulativeStat === tab.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          {cumulativeLoading ? (
            <div className="flex items-center justify-center h-56 text-muted-foreground text-sm">Loading...</div>
          ) : lineData.length > 0 ? (
            <>
              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={lineData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<LineTooltip />} />
                    {topPlayers.map((p, i) => (
                      <Line
                        key={p.id}
                        type="monotone"
                        dataKey={p.name}
                        stroke={LINE_COLORS[i % LINE_COLORS.length]}
                        strokeWidth={2}
                        dot={{ r: 3, strokeWidth: 0, fill: LINE_COLORS[i % LINE_COLORS.length] }}
                        activeDot={{ r: 5 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Compact player legend with final totals */}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {topPlayers.map((p, i) => {
                  const finalVal = lineData.length > 0 ? (lineData[lineData.length - 1]?.[p.name] as number ?? 0) : 0
                  return (
                    <div key={p.id} className="flex items-center gap-1.5 text-xs">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: LINE_COLORS[i % LINE_COLORS.length] }} />
                      <span className="text-foreground font-medium">{p.name}</span>
                      <span className="text-muted-foreground">({finalVal})</span>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-56 text-muted-foreground">
              <LineChartIcon className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">No progression data yet</p>
              <p className="text-xs mt-1">Select a season with recorded games</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary table */}
      {!loading && chartData.length > 0 && (
        <Card className="bg-card text-card-foreground border-border">
          <CardHeader>
            <CardTitle className="text-base">Summary Table</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              <div className="flex items-center gap-3 px-2 pb-2 text-xs text-muted-foreground font-medium border-b border-border">
                <div className="flex-1">Player</div>
                <div className="w-8 text-center text-green-600 dark:text-green-400">G</div>
                <div className="w-8 text-center text-blue-600 dark:text-blue-400">A</div>
                <div className="w-8 text-center text-orange-600 dark:text-orange-400">TO</div>
                <div className="w-10 text-center text-muted-foreground">GP</div>
              </div>
              {(stats as PlayerStat[]).map(p => (
                <div key={p.player_id} className="flex items-center gap-3 px-2 py-2.5 border-b border-border last:border-0">
                  <div className="flex-1 text-sm font-medium text-foreground truncate">{p.player_name}</div>
                  <div className="w-8 text-center font-bold text-sm text-green-600 dark:text-green-400">{p.goals}</div>
                  <div className="w-8 text-center font-bold text-sm text-blue-600 dark:text-blue-400">{p.assists}</div>
                  <div className="w-8 text-center font-bold text-sm text-orange-600 dark:text-orange-400">{p.turnovers}</div>
                  <div className="w-10 text-center text-xs text-muted-foreground">{p.games_played}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
