import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useGetGames } from '../hooks/backend/games'
import { useGetPlayers } from '../hooks/backend/players'
import { useGetPlayerStats, useGetSeasons, useGetCumulativeStats, useGetAllSeasons } from '../hooks/backend/stats'
import {
  useGetLeague, computeStandings,
  useCreateLeagueTeam, useUpdateLeagueTeam, useDeleteLeagueTeam, useUpdateSeasonPoints,
  type LeagueTeam,
} from '../hooks/backend/league'
import { getLatestJamSeasonWithPlayedGame, getDefaultJamSeasonId } from '../lib/seasonUtils'
import { isPastGame } from '../lib/gameOrder'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Label } from '../lib/shadcn/label'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Popover, PopoverContent, PopoverTrigger } from '../lib/shadcn/popover'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import PlayerMultiSelect from '../components/PlayerMultiSelect'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import {
  BarChart3, TrendingUp, LineChart as LineChartIcon, Settings2, ChevronUp, ChevronDown,
  ChevronsUpDown, Plus, Trash2, Award, Target, Pencil, Check, X,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line,
} from 'recharts'

type PlayerStat = {
  player_id: number; player_name: string; goals: string; assists: string
  turnovers: string; games_played: string; ga_rank: number
}
type CumulativeRow = {
  game_id: number; opponent: string; game_date: string
  player_id: number; player_name: string; goals: string; assists: string; turnovers: string
}
type Season = { id: number; name: string; year: number; organizer: string | null; start_date: string | null; end_date: string | null }
type StatsSeasonRow = { id: number; name: string; year: number; organizer: string | null; game_count: string }
type Game = { id: number; opponent: string; game_date: string; game_time: string | null; season_id: number | null }

// Summary Table column system: every non-name column (built-in or
// user-added) is a combination of the raw per-player stats (goals/assists/
// turnovers), optionally divided by games_played for a per-game rate. This
// is what makes "G+A", "G-TO/gm", etc. possible from a small picker instead
// of a full formula language. `terms` is omitted for the one column (GP)
// that's a raw field rather than a combination.
type StatKey = 'goals' | 'assists' | 'turnovers'
type ColumnTerm = { stat: StatKey; sign: 1 | -1 }
type ColumnConfig = {
  id: string
  label: string
  color: string
  builtin?: boolean
  terms?: ColumnTerm[]
  perGame?: boolean
}
const STAT_LABELS: Record<StatKey, string> = { goals: 'G', assists: 'A', turnovers: 'TO' }
const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: 'goals', label: 'G', color: 'text-green-600 dark:text-green-400', builtin: true, terms: [{ stat: 'goals', sign: 1 }] },
  { id: 'assists', label: 'A', color: 'text-blue-600 dark:text-blue-400', builtin: true, terms: [{ stat: 'assists', sign: 1 }] },
  { id: 'turnovers', label: 'TO', color: 'text-orange-600 dark:text-orange-400', builtin: true, terms: [{ stat: 'turnovers', sign: 1 }] },
  { id: 'games_played', label: 'GP', color: 'text-muted-foreground', builtin: true },
  { id: 'avgG', label: 'G/gm', color: 'text-green-600 dark:text-green-400', builtin: true, terms: [{ stat: 'goals', sign: 1 }], perGame: true },
  { id: 'avgA', label: 'A/gm', color: 'text-blue-600 dark:text-blue-400', builtin: true, terms: [{ stat: 'assists', sign: 1 }], perGame: true },
]
const CUSTOM_COLUMNS_KEY = 'ufwt_stats_custom_columns'
const HIDDEN_COLUMNS_KEY = 'ufwt_stats_hidden_columns'
const COLUMN_WIDTHS_KEY = 'ufwt_stats_column_widths'
const DEFAULT_PLAYER_COLUMN_WIDTH = 140
const DEFAULT_STAT_COLUMN_WIDTH = 40
const MIN_PLAYER_COLUMN_WIDTH = 60
const MIN_STAT_COLUMN_WIDTH = 28

function getColumnValue(col: ColumnConfig, p: PlayerStat): number | null {
  if (col.id === 'games_played') return parseInt(p.games_played)
  const gp = parseInt(p.games_played)
  if (col.perGame && gp === 0) return null
  const raw = (col.terms ?? []).reduce((sum, t) => sum + t.sign * parseInt(p[t.stat]), 0)
  return col.perGame ? raw / gp : raw
}

// Shared by both the header-click quick-sort and the popover's explicit
// primary/secondary pickers, so "Player" (alphabetical) and every stat/
// formula column (numeric, via getColumnValue) compare the same way
// regardless of which UI triggered the sort.
function compareByColumn(colId: string, dir: 'asc' | 'desc', columns: ColumnConfig[], a: PlayerStat, b: PlayerStat): number {
  let cmp: number
  if (colId === 'player_name') {
    cmp = a.player_name.localeCompare(b.player_name)
  } else {
    const col = columns.find(c => c.id === colId)
    if (!col) return 0
    const va = getColumnValue(col, a) ?? -Infinity
    const vb = getColumnValue(col, b) ?? -Infinity
    cmp = va - vb
  }
  return dir === 'asc' ? cmp : -cmp
}

function formatColumnValue(col: ColumnConfig, value: number | null): string {
  if (value == null) return '-'
  return col.perGame ? value.toFixed(1) : String(value)
}

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
  '#0ea5e9', '#f97316', '#8b5cf6', '#10b981',
]

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

type PageTab = 'overview' | 'table' | 'standings'

type StandingsSortKey = 'rank' | 'team' | 'games_played' | 'wins' | 'point_diff' | 'points'

// Shared sortable-header button for the League Standings table: shows a
// sort-direction chevron only on the active column, an inert double-chevron
// otherwise (same visual language as the Player Rankings Summary Table).
function StandingsSortHeader({ label, sortKey, activeKey, dir, onClick, align }: {
  label: string
  sortKey: StandingsSortKey
  activeKey: StandingsSortKey
  dir: 'asc' | 'desc'
  onClick: (key: StandingsSortKey) => void
  align: 'left' | 'center'
}) {
  const active = activeKey === sortKey
  return (
    <button
      type="button"
      onClick={() => onClick(sortKey)}
      className={`flex items-center gap-0.5 hover:text-foreground transition-colors ${align === 'center' ? 'mx-auto' : ''}`}
    >
      {label}
      {active ? (dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
    </button>
  )
}
const PAGE_TABS: { key: PageTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'table', label: 'Player Rankings' },
  { key: 'standings', label: 'League Standings' },
]

export default function Stats() {
  const [pageTab, setPageTab] = useState<PageTab>('overview')

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Stats</h1>

      <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-accent">
        {PAGE_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setPageTab(t.key)}
            className={`py-1.5 rounded-md text-sm font-medium transition-colors ${
              pageTab === t.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {pageTab === 'standings' ? <Standings /> : <PlayerStatsView tab={pageTab} />}
    </div>
  )
}

// Overview and Table share one Filters card and one useGetPlayerStats
// fetch (previously split across the Stats and Ranking pages, which
// duplicated the same filter UI and query); only the content below the
// filters differs by tab.
function PlayerStatsView({ tab }: { tab: 'overview' | 'table' }) {
  const { currentOrgId } = useAuth()
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: seasons, trigger: fetchSeasons } = useGetSeasons()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: stats, loading, error, trigger: fetchStats } = useGetPlayerStats()
  const { data: cumulativeRaw, loading: cumulativeLoading, trigger: fetchCumulative } = useGetCumulativeStats()
  const { data: progressionRoster, trigger: fetchProgressionRoster } = useGetPlayers()

  const [filterType, setFilterType] = useState<'all' | 'season' | 'games'>('all')
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<number[]>([])
  const [selectedGameIds, setSelectedGameIds] = useState<number[]>([])
  const [chartTab, setChartTab] = useState<ChartTab>('combined')

  // Summary Table column visibility/formulas/sort are a per-device viewing
  // preference (same convention as Strategy's transition-speed setting),
  // not app state — stored in localStorage, not the DB.
  const [customColumns, setCustomColumns] = useState<ColumnConfig[]>(() => {
    try { return JSON.parse(localStorage.getItem(CUSTOM_COLUMNS_KEY) ?? '[]') } catch { return [] }
  })
  const [hiddenColumnIds, setHiddenColumnIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_KEY) ?? '[]')) } catch { return new Set() }
  })
  // Primary sort also drives the header-click quick-sort; secondary is a
  // tiebreaker only, picked explicitly in the Columns popover (clicking a
  // header always targets primary, never secondary).
  const [sortColumnId, setSortColumnId] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [sortColumnId2, setSortColumnId2] = useState<string | null>(null)
  const [sortDir2, setSortDir2] = useState<'asc' | 'desc'>('desc')
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}') } catch { return {} }
  })
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false)
  const [newColStatA, setNewColStatA] = useState<StatKey>('goals')
  const [newColOp, setNewColOp] = useState<'+' | '-'>('+')
  const [newColStatB, setNewColStatB] = useState<StatKey | '__none__'>('__none__')
  const [newColPerGame, setNewColPerGame] = useState(false)

  useEffect(() => { localStorage.setItem(CUSTOM_COLUMNS_KEY, JSON.stringify(customColumns)) }, [customColumns])
  useEffect(() => { localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hiddenColumnIds])) }, [hiddenColumnIds])
  useEffect(() => { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths)) }, [columnWidths])

  const allColumns = useMemo(() => [...DEFAULT_COLUMNS, ...customColumns], [customColumns])
  const visibleColumns = allColumns.filter(c => !hiddenColumnIds.has(c.id))

  // Formula columns can have longer labels than the 2-3 char built-ins
  // (e.g. "G+A/gm"); size their default width to fit the label instead of
  // the flat stat-column default, so a long label doesn't overlap its
  // right-aligned neighbor before the user has resized anything.
  const getColumnWidth = (id: string) => {
    if (columnWidths[id] != null) return columnWidths[id]
    if (id === 'player_name') return DEFAULT_PLAYER_COLUMN_WIDTH
    const label = allColumns.find(c => c.id === id)?.label ?? ''
    return Math.max(DEFAULT_STAT_COLUMN_WIDTH, label.length * 9 + 24)
  }

  const toggleColumnVisibility = (id: string) => {
    setHiddenColumnIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const handleAddCustomColumn = () => {
    const terms: ColumnTerm[] = [{ stat: newColStatA, sign: 1 }]
    if (newColStatB !== '__none__') terms.push({ stat: newColStatB, sign: newColOp === '+' ? 1 : -1 })
    const label = terms.map((t, i) => (i > 0 ? (t.sign > 0 ? '+' : '-') : '') + STAT_LABELS[t.stat]).join('') + (newColPerGame ? '/gm' : '')
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setCustomColumns(cols => [...cols, { id, label, color: 'text-foreground', terms, perGame: newColPerGame }])
    setNewColStatB('__none__')
    setNewColPerGame(false)
  }

  const handleRemoveCustomColumn = (id: string) => {
    setCustomColumns(cols => cols.filter(c => c.id !== id))
    if (sortColumnId === id) setSortColumnId(null)
    if (sortColumnId2 === id) setSortColumnId2(null)
  }

  const handleSortClick = (colId: string) => {
    if (sortColumnId === colId) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortColumnId(colId); setSortDir('desc') }
  }

  // Column resize: a drag handle on each header cell's right edge. Mirrors
  // the window-pointer-listener drag pattern used for lineup/event
  // reordering elsewhere (see Schedule.tsx) — start/end fixed relative to
  // the pointer's original position, not accumulated per-move, so there's
  // no drift.
  const resizingRef = useRef<{ id: string; startX: number; startWidth: number } | null>(null)
  const handleResizeMove = useCallback((e: PointerEvent) => {
    const r = resizingRef.current
    if (!r) return
    const min = r.id === 'player_name' ? MIN_PLAYER_COLUMN_WIDTH : MIN_STAT_COLUMN_WIDTH
    const next = Math.max(min, r.startWidth + (e.clientX - r.startX))
    setColumnWidths(w => ({ ...w, [r.id]: next }))
  }, [])
  const handleResizeEnd = useCallback(() => {
    resizingRef.current = null
    window.removeEventListener('pointermove', handleResizeMove)
    window.removeEventListener('pointerup', handleResizeEnd)
  }, [handleResizeMove])
  const handleResizeStart = (id: string, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizingRef.current = { id, startX: e.clientX, startWidth: getColumnWidth(id) }
    window.addEventListener('pointermove', handleResizeMove)
    window.addEventListener('pointerup', handleResizeEnd)
  }

  const [cumulativeSeasonId, setCumulativeSeasonId] = useState<string>('')
  const [cumulativeStat, setCumulativeStat] = useState<CumulativeStat>('ga')
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([])

  useEffect(() => {
    if (currentOrgId == null) return
    fetchGames({ organizationId: currentOrgId })
    fetchSeasons({ organizationId: currentOrgId })
    fetchAllSeasons({ organizationId: currentOrgId })
  }, [currentOrgId])

  // Default both filters to the latest Jam season that's actually been played
  useEffect(() => {
    const s = seasons as StatsSeasonRow[] | undefined
    const allS = allSeasons as Season[] | undefined
    const g = games as Game[] | undefined
    if (!s || s.length === 0 || !allS || allS.length === 0 || !g) return
    const defaultId = getLatestJamSeasonWithPlayedGame(allS, g, s[0]!.id)
    if (filterType === 'all' && selectedSeasonIds.length === 0) {
      setFilterType('season')
      setSelectedSeasonIds([defaultId])
    }
    if (!cumulativeSeasonId) {
      setCumulativeSeasonId(String(defaultId))
    }
  }, [seasons, allSeasons, games])

  useEffect(() => {
    if (currentOrgId == null) return
    if (filterType === 'all') fetchStats({ organizationId: currentOrgId })
    else if (filterType === 'season') {
      if (selectedSeasonIds.length > 0) fetchStats({ seasonIds: selectedSeasonIds, organizationId: currentOrgId })
      else fetchStats({ organizationId: currentOrgId })
    }
    else if (filterType === 'games' && selectedGameIds.length > 0) fetchStats({ gameIds: selectedGameIds, organizationId: currentOrgId })
  }, [filterType, selectedSeasonIds, selectedGameIds, currentOrgId])

  useEffect(() => {
    if (currentOrgId == null) return
    if (cumulativeSeasonId && cumulativeSeasonId !== '__all__') {
      fetchCumulative({ seasonId: parseInt(cumulativeSeasonId), organizationId: currentOrgId })
      fetchProgressionRoster({ seasonIds: [parseInt(cumulativeSeasonId)], organizationId: currentOrgId })
    } else {
      fetchCumulative({ organizationId: currentOrgId })
      fetchProgressionRoster({ organizationId: currentOrgId })
    }
    setSelectedPlayerIds([])
  }, [cumulativeSeasonId, currentOrgId])

  const handleGameToggle = (gameId: number) => {
    setSelectedGameIds(prev => prev.includes(gameId) ? prev.filter(id => id !== gameId) : [...prev, gameId])
  }

  const handleSelectAllGames = () => {
    const allIds = (games as Game[] | undefined)?.map(g => g.id) ?? []
    setSelectedGameIds(allIds)
  }

  const handleUnselectAllGames = () => setSelectedGameIds([])

  const statsArr = stats as PlayerStat[] | undefined
  const topScorer = statsArr ? [...statsArr].sort((a, b) => parseInt(b.goals) - parseInt(a.goals))[0] : null
  const topAssister = statsArr ? [...statsArr].sort((a, b) => parseInt(b.assists) - parseInt(a.assists))[0] : null

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
          GamesPlayed: parseInt(p.games_played),
        }))
    : []

  // ── Summary table sort ───────────────────────────────────────────────────────
  // No sort selected keeps the hook's own order (ranked by G+A descending).
  // A tied primary comparison falls through to the secondary column, if one
  // is set (e.g. sort by GP, then by G to break ties among equal-GP players).
  const sortedStats = useMemo(() => {
    const arr = [...((stats as PlayerStat[] | undefined) ?? [])]
    if (!sortColumnId) return arr
    arr.sort((a, b) => {
      const primary = compareByColumn(sortColumnId, sortDir, allColumns, a, b)
      if (primary !== 0) return primary
      if (sortColumnId2 && sortColumnId2 !== sortColumnId) return compareByColumn(sortColumnId2, sortDir2, allColumns, a, b)
      return 0
    })
    return arr
  }, [stats, sortColumnId, sortDir, sortColumnId2, sortDir2, allColumns])

  // ── Cumulative line chart data ───────────────────────────────────────────────
  const { lineData, allPlayersForSelection, topPlayers } = useMemo(() => {
    const rows = cumulativeRaw as CumulativeRow[] | undefined
    if (!rows || rows.length === 0) return { lineData: [], allPlayersForSelection: [], topPlayers: [] }

    // Build game order from ALL games in the season (not just games with events),
    // so the chart shows a flat segment for games where a player had zero contributions.
    const allGamesForSeason = ((games as Game[] | undefined) ?? [])
      .filter(g => cumulativeSeasonId === '__all__' || g.season_id === parseInt(cumulativeSeasonId))
      .slice() // date-desc from hook, so reverse for chronological order
      .reverse()
    const gameOrder: { game_id: number; opponent: string; game_date: string }[] = allGamesForSeason.map(g => ({
      game_id: g.id, opponent: g.opponent, game_date: g.game_date,
    }))

    const perGamePlayer: Record<number, Record<number, { goals: number; assists: number; turnovers: number }>> = {}
    for (const r of rows) {
      if (!perGamePlayer[r.game_id]) perGamePlayer[r.game_id] = {}
      if (!perGamePlayer[r.game_id]![r.player_id]) {
        perGamePlayer[r.game_id]![r.player_id] = { goals: 0, assists: 0, turnovers: 0 }
      }
      const existing = perGamePlayer[r.game_id]![r.player_id]!
      existing.goals += parseInt(r.goals)
      existing.assists += parseInt(r.assists)
      existing.turnovers += parseInt(r.turnovers)
    }

    const playerTotals: Record<number, { name: string; total: number }> = {}
    for (const r of rows) {
      if (!playerTotals[r.player_id]) playerTotals[r.player_id] = { name: r.player_name, total: 0 }
      const v = cumulativeStat === 'goals' ? parseInt(r.goals)
        : cumulativeStat === 'assists' ? parseInt(r.assists)
        : cumulativeStat === 'turnovers' ? parseInt(r.turnovers)
        : parseInt(r.goals) + parseInt(r.assists)
      playerTotals[r.player_id]!.total += v
    }

    // Selection list = full season roster, not just players with events.
    // Players with stats sort first (by total desc), zero-stat players follow alphabetically.
    const withEvents = Object.entries(playerTotals)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, { name, total }]) => ({ id: parseInt(id), name, total }))
    const eventIds = new Set(withEvents.map(p => p.id))
    const rosterOnly = ((progressionRoster as { id: number; display_name: string }[] | undefined) ?? [])
      .filter(p => !eventIds.has(p.id))
      .map(p => ({ id: p.id, name: p.display_name, total: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const allPlayersForSelection = [...withEvents, ...rosterOnly]

    // If specific players selected, use those; otherwise default to top 8
    let displayPlayers: { id: number; name: string }[]
    if (selectedPlayerIds.length > 0) {
      displayPlayers = allPlayersForSelection.filter(p => selectedPlayerIds.includes(p.id))
    } else {
      displayPlayers = allPlayersForSelection.slice(0, 8)
    }

    const cumulative: Record<number, number> = {}
    for (const p of displayPlayers) cumulative[p.id] = 0

    const lineData = gameOrder.map((game, idx) => {
      const point: Record<string, unknown> = { label: `G${idx + 1}`, fullLabel: `vs ${game.opponent}` }
      for (const p of displayPlayers) {
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

    return { lineData, allPlayersForSelection, topPlayers: displayPlayers }
  }, [cumulativeRaw, cumulativeStat, selectedPlayerIds, games, cumulativeSeasonId, progressionRoster])

  const BarTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
    if (!active || !payload?.length) return null
    const full = chartData.find(d => d.name === label)
    return (
      <div className="bg-card border border-border rounded-lg shadow-md p-3 text-sm">
        <p className="font-semibold text-foreground mb-1">{full?.fullName ?? label}</p>
        {payload.map(entry => <p key={entry.name} style={{ color: entry.color }} className="font-medium">{entry.name}: {entry.value}</p>)}
      </div>
    )
  }

  const LineTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
    if (!active || !payload?.length) return null
    const point = lineData.find(d => d.label === label)
    return (
      <div className="bg-card border border-border rounded-lg shadow-md p-3 text-sm max-w-[200px]">
        <p className="font-semibold text-foreground mb-1 text-xs">{String(point?.fullLabel ?? label)}</p>
        {payload.filter(e => e.value > 0).sort((a, b) => b.value - a.value).map(entry => (
          <p key={entry.name} style={{ color: entry.color }} className="font-medium text-xs">{entry.name}: {entry.value}</p>
        ))}
      </div>
    )
  }

  // Averages are team totals per game, so divide by the number of games in the
  // current filter that have been played — not the sum of every player's games_played
  const gamesInFilter = ((games as Game[] | undefined) ?? []).filter(g => {
    if (!isPastGame(g)) return false
    if (filterType === 'season' && selectedSeasonIds.length > 0) return g.season_id != null && selectedSeasonIds.includes(g.season_id)
    if (filterType === 'games' && selectedGameIds.length > 0) return selectedGameIds.includes(g.id)
    return true
  }).length
  const avgGoals = statsArr && statsArr.length > 0 && gamesInFilter > 0
    ? (statsArr.reduce((s, p) => s + parseInt(p.goals), 0) / gamesInFilter).toFixed(2)
    : null
  const avgAssists = statsArr && statsArr.length > 0 && gamesInFilter > 0
    ? (statsArr.reduce((s, p) => s + parseInt(p.assists), 0) / gamesInFilter).toFixed(2)
    : null

  return (
    <div className="space-y-4">
      {/* Filters (shared by Overview and Table) */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader><CardTitle className="text-base">Filters</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Filter By</Label>
            <Select value={filterType} onValueChange={(val: 'all' | 'season' | 'games') => {
              setFilterType(val); setSelectedGameIds([]); setSelectedSeasonIds([])
            }}>
              <SelectTrigger className="bg-background text-foreground border-border"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Games</SelectItem>
                <SelectItem value="season">By Season</SelectItem>
                <SelectItem value="games">Specific Games</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filterType === 'season' && (
            <div className="space-y-2">
              <Label>Select Season(s)</Label>
              <SeasonMultiSelect
                seasons={(allSeasons as Season[] | undefined) ?? []}
                selectedIds={selectedSeasonIds}
                onChange={setSelectedSeasonIds}
                placeholder="All Seasons"
              />
            </div>
          )}

          {filterType === 'games' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Select Games</Label>
                <div className="flex gap-2">
                  <button onClick={handleSelectAllGames} className="text-xs text-primary hover:underline">Select all</button>
                  <span className="text-xs text-muted-foreground">·</span>
                  <button onClick={handleUnselectAllGames} className="text-xs text-muted-foreground hover:text-foreground">Unselect all</button>
                </div>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1 bg-background rounded-md border border-border p-3">
                {(games as Game[] | undefined)?.map(game => {
                  const s = (allSeasons as Season[] | undefined)?.find(s => s.id === game.season_id)
                  return (
                    <label key={game.id} className="flex items-center gap-3 cursor-pointer hover:bg-accent rounded px-2 py-1.5 transition-colors">
                      <input type="checkbox" checked={selectedGameIds.includes(game.id)} onChange={() => handleGameToggle(game.id)} className="w-4 h-4 rounded border-border" />
                      <span className="text-sm text-foreground">
                        vs {game.opponent}, {new Date(game.game_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {s && <span className="text-xs text-muted-foreground ml-1">· {seasonLabel(s)}</span>}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {tab === 'overview' && (
        <>
          {/* Top scorer / top assister + avg per game banner */}
          {topScorer && topAssister && (
            <FadeIn className="grid grid-cols-2 gap-3">
              <Card className="bg-card border-border">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 text-yellow-500 mb-1">
                    <Award className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wide">Top Scorer</span>
                  </div>
                  <p className="font-bold text-foreground">{topScorer.player_name}</p>
                  <p className="text-2xl font-bold text-primary">{topScorer.goals}</p>
                  <p className="text-xs text-muted-foreground">goals</p>
                </CardContent>
              </Card>
              <Card className="bg-card border-border">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 text-blue-500 mb-1">
                    <Target className="w-4 h-4" />
                    <span className="text-xs font-semibold uppercase tracking-wide">Top Assister</span>
                  </div>
                  <p className="font-bold text-foreground">{topAssister.player_name}</p>
                  <p className="text-2xl font-bold text-primary">{topAssister.assists}</p>
                  <p className="text-xs text-muted-foreground">assists</p>
                </CardContent>
              </Card>
            </FadeIn>
          )}

          {avgGoals && avgAssists && (
            <div className="grid grid-cols-2 gap-3">
              <FadeIn delay={0}>
                <Card className="bg-green-500/5 border-green-500/20">
                  <CardContent className="pt-3 pb-3 text-center">
                    <div className="text-xl font-bold text-green-600 dark:text-green-400">{avgGoals}</div>
                    <div className="text-xs text-muted-foreground">Avg goals/game</div>
                  </CardContent>
                </Card>
              </FadeIn>
              <FadeIn delay={40}>
                <Card className="bg-blue-500/5 border-blue-500/20">
                  <CardContent className="pt-3 pb-3 text-center">
                    <div className="text-xl font-bold text-blue-600 dark:text-blue-400">{avgAssists}</div>
                    <div className="text-xs text-muted-foreground">Avg assists/game</div>
                  </CardContent>
                </Card>
              </FadeIn>
            </div>
          )}

          {/* Bar chart */}
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />Performance Chart
              </CardTitle>
              <div className="flex gap-1 mt-2 bg-muted rounded-lg p-1">
                {CHART_TABS.map(t => (
                  <button key={t.key} onClick={() => setChartTab(t.key)}
                    className={`flex-1 text-xs py-1.5 px-2 rounded-md font-medium transition-colors ${chartTab === t.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              {loading ? (
                // Skeleton shaped like the horizontal bar chart: a name label plus a
                // bar of varying width for each of several rows.
                <div className="space-y-4 py-2">
                  {[0.9, 0.75, 0.6, 0.5, 0.4, 0.3].map((w, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-3 w-12 shrink-0" />
                      <Skeleton className="h-3.5" style={{ width: `${w * 100}%` }} />
                    </div>
                  ))}
                </div>
              ) : error ? (
                <div className="flex items-center justify-center h-48 text-destructive text-sm">Error: {error}</div>
              ) : chartData.length > 0 ? (
                <FadeIn className="w-full" style={{ height: Math.max(200, chartData.length * 36) }}>
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
                </FadeIn>
              ) : (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                  <TrendingUp className="w-12 h-12 mb-3 opacity-40" />
                  <p className="text-sm">{filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view stats' : 'No stats available yet'}</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Cumulative Progression Chart */}
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <LineChartIcon className="w-4 h-4" />Season Progression
              </CardTitle>

              <div className="mt-3 space-y-1">
                <Label className="text-xs text-muted-foreground">Season</Label>
                <Select value={cumulativeSeasonId} onValueChange={setCumulativeSeasonId}>
                  <SelectTrigger className="bg-background text-foreground border-border h-8 text-sm"><SelectValue placeholder="All games" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All games</SelectItem>
                    {(allSeasons as Season[] | undefined)?.map(s => (
                      <SelectItem key={s.id} value={String(s.id)}>{seasonLabel(s)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Player filter */}
              {allPlayersForSelection.length > 0 && (
                <div className="mt-2 space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    Players {selectedPlayerIds.length === 0 ? '(top 8)' : ''}
                  </Label>
                  <PlayerMultiSelect
                    players={allPlayersForSelection}
                    selectedIds={selectedPlayerIds}
                    onChange={setSelectedPlayerIds}
                    placeholder="Top 8 players"
                  />
                </div>
              )}

              {/* Stat tab */}
              <div className="flex gap-1 mt-2 bg-muted rounded-lg p-1">
                {CUMULATIVE_TABS.map(t => (
                  <button key={t.key} onClick={() => setCumulativeStat(t.key)}
                    className={`flex-1 text-xs py-1.5 px-2 rounded-md font-medium transition-colors ${cumulativeStat === t.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              {cumulativeLoading ? (
                // Skeleton shaped like the line chart: a large plot block plus a row
                // of legend chips underneath.
                <div className="space-y-3">
                  <Skeleton className="w-full" style={{ height: 220 }} />
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {[0, 1, 2, 3, 4].map(i => (
                      <div key={i} className="flex items-center gap-1.5">
                        <Skeleton className="w-2.5 h-2.5 rounded-full shrink-0" />
                        <Skeleton className="h-3 w-16" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : lineData.length > 0 ? (
                <FadeIn>
                  <div style={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={lineData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
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
                </FadeIn>
              ) : (
                <div className="flex flex-col items-center justify-center h-56 text-muted-foreground">
                  <LineChartIcon className="w-12 h-12 mb-3 opacity-40" />
                  <p className="text-sm">No progression data yet</p>
                  <p className="text-xs mt-1">Select a season with recorded games</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {tab === 'table' && (
        <>
          {/* Summary table: skeleton rows while loading, shaped like the real rows */}
          {loading && (
            <Card className="bg-card text-card-foreground border-border">
              <CardHeader><CardTitle className="text-base">Summary Table</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <div className="space-y-0 min-w-[420px]">
                    <div className="flex items-center gap-3 px-2 pb-2 border-b border-border">
                      <Skeleton className="h-3 flex-1" />
                      <Skeleton className="h-3 w-8" />
                      <Skeleton className="h-3 w-8" />
                      <Skeleton className="h-3 w-8" />
                      <Skeleton className="h-3 w-10" />
                      <Skeleton className="h-3 w-10" />
                      <Skeleton className="h-3 w-10" />
                    </div>
                    {[0, 1, 2, 3, 4, 5].map(i => (
                      <div key={i} className="flex items-center gap-3 px-2 py-2.5 border-b border-border last:border-0">
                        <Skeleton className="h-4 flex-1" />
                        <Skeleton className="h-4 w-8" />
                        <Skeleton className="h-4 w-8" />
                        <Skeleton className="h-4 w-8" />
                        <Skeleton className="h-3 w-10" />
                        <Skeleton className="h-3 w-10" />
                        <Skeleton className="h-3 w-10" />
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {!loading && chartData.length > 0 && (
            <Card className="bg-card text-card-foreground border-border">
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Summary Table</CardTitle>
                <Popover open={columnsPopoverOpen} onOpenChange={setColumnsPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" size="sm" variant="outline" className="h-7 text-xs bg-card border-border gap-1.5">
                      <Settings2 className="w-3.5 h-3.5" />Columns
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-72 space-y-3">
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Show columns</p>
                      {allColumns.map(col => (
                        <label key={col.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={!hiddenColumnIds.has(col.id)}
                              onChange={() => toggleColumnVisibility(col.id)}
                              className="accent-primary w-3.5 h-3.5 cursor-pointer"
                            />
                            <span className={col.color}>{col.label}</span>
                          </span>
                          {!col.builtin && (
                            <button
                              type="button"
                              onClick={() => handleRemoveCustomColumn(col.id)}
                              title="Delete this column"
                              aria-label="Delete this column"
                              className="text-muted-foreground hover:text-destructive transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </label>
                      ))}
                    </div>
                    <div className="space-y-2 pt-2 border-t border-border">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sort</p>
                      <div className="flex items-center gap-1.5">
                        <Select value={sortColumnId ?? '__none__'} onValueChange={v => setSortColumnId(v === '__none__' ? null : v)}>
                          <SelectTrigger className="h-8 text-xs bg-card border-border flex-1"><SelectValue placeholder="Sort by..." /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Default order</SelectItem>
                            <SelectItem value="player_name">Player</SelectItem>
                            {allColumns.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <button
                          type="button"
                          disabled={!sortColumnId}
                          onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                          className="h-8 w-8 flex items-center justify-center rounded-md border border-border bg-card disabled:opacity-40 hover:bg-muted transition-colors shrink-0"
                        >
                          {sortDir === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Select value={sortColumnId2 ?? '__none__'} onValueChange={v => setSortColumnId2(v === '__none__' ? null : v)} disabled={!sortColumnId}>
                          <SelectTrigger className="h-8 text-xs bg-card border-border flex-1 disabled:opacity-40"><SelectValue placeholder="Then by..." /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            <SelectItem value="player_name">Player</SelectItem>
                            {allColumns.map(c => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <button
                          type="button"
                          disabled={!sortColumnId || !sortColumnId2}
                          onClick={() => setSortDir2(d => (d === 'asc' ? 'desc' : 'asc'))}
                          className="h-8 w-8 flex items-center justify-center rounded-md border border-border bg-card disabled:opacity-40 hover:bg-muted transition-colors shrink-0"
                        >
                          {sortDir2 === 'asc' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2 pt-2 border-t border-border">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add a formula column</p>
                      <div className="flex items-center gap-1.5">
                        <Select value={newColStatA} onValueChange={v => setNewColStatA(v as StatKey)}>
                          <SelectTrigger className="h-8 text-xs bg-card border-border flex-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {(Object.keys(STAT_LABELS) as StatKey[]).map(k => <SelectItem key={k} value={k}>{STAT_LABELS[k]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Select value={newColOp} onValueChange={v => setNewColOp(v as '+' | '-')}>
                          <SelectTrigger className="h-8 text-xs bg-card border-border w-14"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="+">+</SelectItem>
                            <SelectItem value="-">-</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select value={newColStatB} onValueChange={v => setNewColStatB(v as StatKey | '__none__')}>
                          <SelectTrigger className="h-8 text-xs bg-card border-border flex-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {(Object.keys(STAT_LABELS) as StatKey[]).map(k => <SelectItem key={k} value={k}>{STAT_LABELS[k]}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" checked={newColPerGame} onChange={e => setNewColPerGame(e.target.checked)} className="accent-primary w-3.5 h-3.5 cursor-pointer" />
                        Per game (divide by GP)
                      </label>
                      <Button type="button" size="sm" onClick={handleAddCustomColumn} className="w-full h-8 bg-primary text-primary-foreground hover:bg-primary/90 gap-1.5">
                        <Plus className="w-3.5 h-3.5" />Add column
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <div className="space-y-0">
                    <div className="flex items-center gap-3 px-2 pb-2 text-xs text-muted-foreground font-medium border-b border-border">
                      <div className="relative shrink-0 flex items-center" style={{ width: getColumnWidth('player_name') }}>
                        <button
                          type="button"
                          onClick={() => handleSortClick('player_name')}
                          className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-foreground transition-colors"
                        >
                          <span className="truncate">Player</span>
                          {sortColumnId === 'player_name' ? (sortDir === 'asc' ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />) : <ChevronsUpDown className="w-3 h-3 opacity-30 shrink-0" />}
                        </button>
                        <div
                          onPointerDown={e => handleResizeStart('player_name', e)}
                          className="absolute right-0 top-0 bottom-0 w-2 -mr-2 cursor-col-resize hover:bg-primary/30 rounded-sm"
                        />
                      </div>
                      <div className="flex items-center gap-3 ml-auto shrink-0">
                        {visibleColumns.map(col => (
                          <div key={col.id} className="relative shrink-0 flex items-center justify-end" style={{ width: getColumnWidth(col.id) }}>
                            <button
                              type="button"
                              onClick={() => handleSortClick(col.id)}
                              className={`flex items-center justify-end gap-0.5 hover:text-foreground transition-colors ${col.color}`}
                            >
                              {sortColumnId === col.id ? (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : <ChevronsUpDown className="w-3 h-3 opacity-30" />}
                              {col.label}
                            </button>
                            <div
                              onPointerDown={e => handleResizeStart(col.id, e)}
                              className="absolute right-0 top-0 bottom-0 w-2 -mr-2 cursor-col-resize hover:bg-primary/30 rounded-sm"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    {sortedStats.map((p, index) => (
                      <FadeIn key={p.player_id} delay={index * 40} className="flex items-center gap-3 px-2 py-2.5 border-b border-border last:border-0">
                        <div className="text-sm font-medium text-foreground truncate shrink-0" style={{ width: getColumnWidth('player_name') }}>{p.player_name}</div>
                        <div className="flex items-center gap-3 ml-auto shrink-0">
                          {visibleColumns.map(col => (
                            <div key={col.id} className={`text-right font-bold text-sm shrink-0 ${col.color}`} style={{ width: getColumnWidth(col.id) }}>
                              {formatColumnValue(col, getColumnValue(col, p))}
                            </div>
                          ))}
                        </div>
                      </FadeIn>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function Standings() {
  const { allowed, currentOrgId } = useAuth()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: league, loading: leagueLoading, error, trigger: fetchLeague } = useGetLeague()

  const { trigger: createTeam } = useCreateLeagueTeam()
  const { trigger: updateTeam } = useUpdateLeagueTeam()
  const { trigger: deleteTeam } = useDeleteLeagueTeam()
  const { trigger: updateSeasonPoints } = useUpdateSeasonPoints()

  const [selectedSeasonId, setSelectedSeasonId] = useState<number | undefined>(undefined)

  // Team detail dialog
  const [detailTeam, setDetailTeam] = useState<LeagueTeam | null>(null)
  const [notesValue, setNotesValue] = useState('')
  const [editingNotes, setEditingNotes] = useState(false)

  // Manage league dialog (teams + points config)
  const [manageOpen, setManageOpen] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [renamingTeamId, setRenamingTeamId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pointsDraft, setPointsDraft] = useState({ win: '2', tie: '1', loss: '0' })

  useEffect(() => {
    if (currentOrgId == null) return
    fetchAllSeasons({ organizationId: currentOrgId })
  }, [currentOrgId])

  useEffect(() => {
    const seasons = allSeasons as Season[] | undefined
    if (!seasons || seasons.length === 0 || selectedSeasonId != null) return
    setSelectedSeasonId(getDefaultJamSeasonId(seasons, seasons[0]?.id))
  }, [allSeasons])

  useEffect(() => {
    if (selectedSeasonId != null) fetchLeague({ seasonId: selectedSeasonId })
  }, [selectedSeasonId])

  useEffect(() => {
    if (league) {
      setPointsDraft({
        win: String(league.season.win_points),
        tie: String(league.season.tie_points),
        loss: String(league.season.loss_points),
      })
    }
  }, [league])

  const refresh = () => { if (selectedSeasonId != null) fetchLeague({ seasonId: selectedSeasonId }) }

  const standings = useMemo(() => league ? computeStandings(league) : [], [league])
  const usTeam = league?.teams.find(t => t.is_us) ?? null

  // Column sort: clicking a header reorders the rows; "#" always shows the
  // official rank (points, then point diff, then points for) regardless of
  // which column the table is currently sorted by.
  const [standingsSortKey, setStandingsSortKey] = useState<StandingsSortKey>('rank')
  const [standingsSortDir, setStandingsSortDir] = useState<'asc' | 'desc'>('asc')

  const handleStandingsSortClick = (key: StandingsSortKey) => {
    if (standingsSortKey === key) setStandingsSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setStandingsSortKey(key)
      setStandingsSortDir(key === 'team' || key === 'rank' ? 'asc' : 'desc')
    }
  }

  const sortedStandings = useMemo(() => {
    const arr = [...standings]
    arr.sort((a, b) => {
      const cmp = standingsSortKey === 'team' ? a.team.name.localeCompare(b.team.name)
        : standingsSortKey === 'rank' ? a.rank - b.rank
        : standingsSortKey === 'games_played' ? a.games_played - b.games_played
        : standingsSortKey === 'wins' ? a.wins - b.wins
        : standingsSortKey === 'point_diff' ? a.point_diff - b.point_diff
        : a.points - b.points
      return standingsSortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [standings, standingsSortKey, standingsSortDir])

  // Last-5 form guide per team, oldest to newest, from decided regular games.
  const formByTeam = useMemo(() => {
    const map = new Map<number, ('W' | 'L' | 'T')[]>()
    if (!league) return map
    const finals = league.games
      .filter(g => g.stage === 'regular' && g.is_final && g.eff_home_score != null && g.eff_away_score != null)
      .sort((a, b) => (a.game_date ?? '').localeCompare(b.game_date ?? ''))
    for (const g of finals) {
      for (const side of ['home', 'away'] as const) {
        const teamId = side === 'home' ? g.eff_home_team_id : g.eff_away_team_id
        if (teamId == null) continue
        const mine = side === 'home' ? g.eff_home_score! : g.eff_away_score!
        const theirs = side === 'home' ? g.eff_away_score! : g.eff_home_score!
        const outcome: 'W' | 'L' | 'T' = mine > theirs ? 'W' : mine < theirs ? 'L' : 'T'
        const arr = map.get(teamId) ?? []
        arr.push(outcome)
        map.set(teamId, arr)
      }
    }
    map.forEach((arr, id) => map.set(id, arr.slice(-5)))
    return map
  }, [league])

  const teamName = (id: number | null) => {
    if (id == null) return 'TBD'
    return league?.teams.find(t => t.id === id)?.name ?? 'TBD'
  }

  const handleAddTeam = async () => {
    if (!newTeamName.trim() || selectedSeasonId == null || currentOrgId == null) return
    await createTeam({ seasonId: selectedSeasonId, name: newTeamName, organizationId: currentOrgId })
    setNewTeamName('')
    refresh()
  }

  const handleRenameTeam = async () => {
    if (renamingTeamId == null || !renameValue.trim()) return
    await updateTeam({ id: renamingTeamId, name: renameValue.trim() })
    setRenamingTeamId(null)
    refresh()
  }

  const handleDeleteTeam = async (id: number) => {
    await deleteTeam({ id })
    refresh()
  }

  const handleSavePoints = async () => {
    if (selectedSeasonId == null) return
    const win = parseInt(pointsDraft.win, 10)
    const tie = parseInt(pointsDraft.tie, 10)
    const loss = parseInt(pointsDraft.loss, 10)
    if ([win, tie, loss].some(isNaN)) return
    await updateSeasonPoints({ seasonId: selectedSeasonId, win_points: win, tie_points: tie, loss_points: loss })
    refresh()
  }

  const handleSaveNotes = async () => {
    if (!detailTeam) return
    await updateTeam({ id: detailTeam.id, notes: notesValue.trim() || null })
    setDetailTeam({ ...detailTeam, notes: notesValue.trim() || null })
    setEditingNotes(false)
    refresh()
  }

  // Head-to-head and season results for the team detail dialog.
  const detailGames = useMemo(() => {
    if (!detailTeam || !league) return []
    return league.games
      .filter(g => g.eff_home_team_id === detailTeam.id || g.eff_away_team_id === detailTeam.id)
      .sort((a, b) => (a.game_date ?? '9999').localeCompare(b.game_date ?? '9999'))
  }, [detailTeam, league])

  const h2h = useMemo(() => {
    if (!detailTeam || !usTeam || detailTeam.id === usTeam.id) return null
    const record = { w: 0, l: 0, t: 0 }
    for (const g of detailGames) {
      if (!g.is_final || g.eff_home_score == null || g.eff_away_score == null) continue
      const usHome = g.eff_home_team_id === usTeam.id
      const usAway = g.eff_away_team_id === usTeam.id
      if (!usHome && !usAway) continue
      const our = usHome ? g.eff_home_score : g.eff_away_score
      const their = usHome ? g.eff_away_score : g.eff_home_score
      if (our > their) record.w++
      else if (our < their) record.l++
      else record.t++
    }
    return record
  }, [detailTeam, detailGames, usTeam])

  const formDot = (o: 'W' | 'L' | 'T', i: number) => (
    <span
      key={i}
      className={`inline-block w-2 h-2 rounded-full ${
        o === 'W' ? 'bg-green-500' : o === 'L' ? 'bg-red-500' : 'bg-yellow-500'
      }`}
    />
  )

  const seasons = (allSeasons as Season[] | undefined) ?? []
  const loading = leagueLoading || league == null

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select
          value={selectedSeasonId != null ? String(selectedSeasonId) : ''}
          onValueChange={v => setSelectedSeasonId(parseInt(v, 10))}
        >
          <SelectTrigger className="bg-background text-foreground border-border flex-1">
            <SelectValue placeholder="Select season" />
          </SelectTrigger>
          <SelectContent>
            {seasons.map(s => (
              <SelectItem key={s.id} value={String(s.id)}>{seasonLabel(s)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {allowed && (
          <button
            onClick={() => setManageOpen(true)}
            className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground shrink-0"
            aria-label="Manage standings"
          >
            <Settings2 className="w-5 h-5" />
          </button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </CardContent>
        </Card>
      ) : (
        <FadeIn>
          <Card className="bg-card text-card-foreground border-border">
            <CardContent className="p-0 overflow-x-auto">
              {standings.length === 0 ? (
                <p className="text-sm text-muted-foreground p-6 text-center">
                  No league teams yet. Add the teams in your league to start tracking standings.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-xs border-b border-border">
                      <th className="text-left font-medium py-2.5 pl-4 pr-2 w-8">
                        <StandingsSortHeader label="#" sortKey="rank" activeKey={standingsSortKey} dir={standingsSortDir} onClick={handleStandingsSortClick} align="left" />
                      </th>
                      <th className="text-left font-medium py-2.5 px-2">
                        <StandingsSortHeader label="Team" sortKey="team" activeKey={standingsSortKey} dir={standingsSortDir} onClick={handleStandingsSortClick} align="left" />
                      </th>
                      <th className="text-center font-medium py-2.5 px-2">
                        <StandingsSortHeader label="GP" sortKey="games_played" activeKey={standingsSortKey} dir={standingsSortDir} onClick={handleStandingsSortClick} align="center" />
                      </th>
                      <th className="text-center font-medium py-2.5 px-2">
                        <StandingsSortHeader label="W-L-T" sortKey="wins" activeKey={standingsSortKey} dir={standingsSortDir} onClick={handleStandingsSortClick} align="center" />
                      </th>
                      <th className="text-center font-medium py-2.5 px-2">
                        <StandingsSortHeader label="+/-" sortKey="point_diff" activeKey={standingsSortKey} dir={standingsSortDir} onClick={handleStandingsSortClick} align="center" />
                      </th>
                      <th className="text-center font-medium py-2.5 px-2 pr-4">
                        <StandingsSortHeader label="PTS" sortKey="points" activeKey={standingsSortKey} dir={standingsSortDir} onClick={handleStandingsSortClick} align="center" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStandings.map(r => (
                      <tr
                        key={r.team.id}
                        onClick={() => { setDetailTeam(r.team); setNotesValue(r.team.notes ?? ''); setEditingNotes(false) }}
                        className={`border-b border-border last:border-0 cursor-pointer hover:bg-accent/50 transition-colors ${
                          r.team.is_us ? 'bg-primary/10' : ''
                        }`}
                      >
                        <td className={`py-2.5 pl-4 pr-2 tabular-nums ${r.team.is_us ? 'font-bold text-primary' : 'text-muted-foreground'}`}>{r.rank}</td>
                        <td className="py-2.5 px-2">
                          <div className={`truncate max-w-[9rem] ${r.team.is_us ? 'font-bold' : 'font-medium'}`}>{r.team.name}</div>
                          <div className="flex gap-1 mt-1">{(formByTeam.get(r.team.id) ?? []).map(formDot)}</div>
                        </td>
                        <td className="text-center py-2.5 px-2 tabular-nums">{r.games_played}</td>
                        <td className="text-center py-2.5 px-2 tabular-nums whitespace-nowrap">{r.wins}-{r.losses}-{r.ties}</td>
                        <td className={`text-center py-2.5 px-2 tabular-nums ${r.point_diff > 0 ? 'text-green-600 dark:text-green-400' : r.point_diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                          {r.point_diff > 0 ? `+${r.point_diff}` : r.point_diff}
                        </td>
                        <td className="text-center py-2.5 px-2 pr-4 font-bold tabular-nums">{r.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </FadeIn>
      )}

      {/* Team detail: head-to-head, results, scouting notes */}
      <Dialog open={detailTeam != null} onOpenChange={open => { if (!open) setDetailTeam(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {detailTeam?.name}
              {detailTeam?.is_us && <span className="text-xs font-normal text-primary ml-2">Us</span>}
            </DialogTitle>
          </DialogHeader>
          {detailTeam && (
            <div className="space-y-4">
              {h2h && (
                <div className="rounded-lg bg-accent p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Head to head vs us</p>
                  <p className="text-lg font-bold tabular-nums">
                    <span className="text-green-600 dark:text-green-400">{h2h.w}W</span>
                    <span className="mx-2 text-red-600 dark:text-red-400">{h2h.l}L</span>
                    <span className="text-yellow-600 dark:text-yellow-400">{h2h.t}T</span>
                  </p>
                </div>
              )}
              <div className="space-y-1 max-h-48 overflow-y-auto">
                <p className="text-xs font-semibold text-muted-foreground">Season results</p>
                {detailGames.length === 0 && <p className="text-sm text-muted-foreground">No games yet.</p>}
                {detailGames.map(g => {
                  const isHome = g.eff_home_team_id === detailTeam.id
                  const oppName = teamName(isHome ? g.eff_away_team_id : g.eff_home_team_id)
                  const mine = isHome ? g.eff_home_score : g.eff_away_score
                  const theirs = isHome ? g.eff_away_score : g.eff_home_score
                  const decided = g.is_final && mine != null && theirs != null
                  return (
                    <div key={g.id} className="flex items-center justify-between text-sm py-1">
                      <span className="truncate">vs {oppName}</span>
                      {decided ? (
                        <span className={`tabular-nums font-semibold ${mine! > theirs! ? 'text-green-600 dark:text-green-400' : mine! < theirs! ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
                          {mine}-{theirs}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{g.game_date ?? 'TBD'}</span>
                      )}
                    </div>
                  )
                })}
              </div>
              {!detailTeam.is_us && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground">Notes</p>
                    {allowed && !editingNotes && (
                      <button onClick={() => setEditingNotes(true)} className="text-xs text-primary hover:underline">Edit</button>
                    )}
                  </div>
                  {editingNotes ? (
                    <div className="space-y-2">
                      <textarea
                        value={notesValue}
                        onChange={e => setNotesValue(e.target.value)}
                        rows={3}
                        className="w-full rounded-md border border-border bg-background text-foreground text-sm p-2"
                        placeholder="Scouting notes: their zone looks beatable deep..."
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSaveNotes}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setEditingNotes(false); setNotesValue(detailTeam.notes ?? '') }}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                      {detailTeam.notes || 'No notes yet.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Manage league: teams and points config */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Manage standings</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Teams</Label>
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {(league?.teams ?? []).map(t => (
                  <div key={t.id} className="flex items-center gap-2 py-1">
                    {renamingTeamId === t.id ? (
                      <>
                        <Input
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          className="h-8 bg-background text-foreground border-border"
                          autoFocus
                        />
                        <Button size="sm" onClick={handleRenameTeam}><Check className="w-4 h-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenamingTeamId(null)}><X className="w-4 h-4" /></Button>
                      </>
                    ) : (
                      <>
                        <span className={`flex-1 text-sm truncate ${t.is_us ? 'font-bold text-primary' : ''}`}>
                          {t.name}{t.is_us ? ' (us)' : ''}
                        </span>
                        <button
                          onClick={() => { setRenamingTeamId(t.id); setRenameValue(t.name) }}
                          className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                          aria-label={`Rename ${t.name}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        {!t.is_us && (
                          <button
                            onClick={() => handleDeleteTeam(t.id)}
                            className="p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                            aria-label={`Delete ${t.name}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newTeamName}
                  onChange={e => setNewTeamName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTeam() }}
                  placeholder="New team name"
                  className="bg-background text-foreground border-border"
                />
                <Button size="sm" onClick={handleAddTeam} disabled={!newTeamName.trim()}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Standings points</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['win', 'tie', 'loss'] as const).map(k => (
                  <div key={k} className="space-y-1">
                    <span className="text-xs text-muted-foreground capitalize">{k}</span>
                    <Input
                      type="number" inputMode="numeric"
                      value={pointsDraft[k]}
                      onChange={e => setPointsDraft(p => ({ ...p, [k]: e.target.value }))}
                      className="bg-background text-foreground border-border"
                    />
                  </div>
                ))}
              </div>
              <Button size="sm" variant="outline" onClick={handleSavePoints}>Save points</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
