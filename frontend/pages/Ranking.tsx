import { useEffect, useMemo, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useGetPlayerStats, useGetAllSeasons, useGetSeasons } from '../hooks/backend/stats'
import { getLatestJamSeasonWithPlayedGame, getDefaultJamSeasonId } from '../lib/seasonUtils'
import {
  useGetLeague, computeStandings,
  useCreateLeagueTeam, useUpdateLeagueTeam, useDeleteLeagueTeam, useUpdateSeasonPoints,
  type LeagueTeam,
} from '../hooks/backend/league'
import { useAuth } from '../contexts/AuthContext'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import { Award, Target, Settings2, Plus, Trash2, Pencil, Check, X } from 'lucide-react'

type Season = { id: number; name: string; year: number; organizer: string | null; start_date: string | null; end_date: string | null }
type Game = { id: number; opponent: string; game_date: string; season_id: number | null }

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

type PageTab = 'players' | 'standings'

export default function Ranking() {
  const [pageTab, setPageTab] = useState<PageTab>('players')

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Ranking</h1>

      <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-accent">
        {(['players', 'standings'] as PageTab[]).map(t => (
          <button
            key={t}
            onClick={() => setPageTab(t)}
            className={`py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
              pageTab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {pageTab === 'players' ? <PlayerRankings /> : <Standings />}
    </div>
  )
}

function PlayerRankings() {
  const { currentOrgId } = useAuth()
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: seasonsWithGames, trigger: fetchSeasonsWithGames } = useGetSeasons()
  const { data: stats, loading, error, trigger: fetchStats } = useGetPlayerStats()

  const [filterType, setFilterType] = useState<'all' | 'season' | 'games'>('all')
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<number[]>([])
  const [selectedGameIds, setSelectedGameIds] = useState<number[]>([])

  useEffect(() => {
    if (currentOrgId == null) return
    fetchGames({ organizationId: currentOrgId })
    fetchAllSeasons({ organizationId: currentOrgId })
    fetchSeasonsWithGames({ organizationId: currentOrgId })
  }, [currentOrgId])

  useEffect(() => {
    const s = seasonsWithGames as { id: number }[] | undefined
    const allS = allSeasons as Season[] | undefined
    const g = games as Game[] | undefined
    if (!s || s.length === 0 || !allS || allS.length === 0 || !g || selectedSeasonIds.length > 0) return
    const defaultId = getLatestJamSeasonWithPlayedGame(allS, g, s[0]!.id)
    setFilterType('season')
    setSelectedSeasonIds([defaultId])
  }, [seasonsWithGames, allSeasons, games])

  useEffect(() => {
    if (currentOrgId == null) return
    if (filterType === 'all') fetchStats({ organizationId: currentOrgId })
    else if (filterType === 'season') {
      if (selectedSeasonIds.length > 0) fetchStats({ seasonIds: selectedSeasonIds, organizationId: currentOrgId })
      else fetchStats({ organizationId: currentOrgId })
    }
    else if (filterType === 'games' && selectedGameIds.length > 0) fetchStats({ gameIds: selectedGameIds, organizationId: currentOrgId })
  }, [filterType, selectedSeasonIds, selectedGameIds, currentOrgId])

  const handleGameToggle = (gameId: number) => {
    setSelectedGameIds(prev => prev.includes(gameId) ? prev.filter(id => id !== gameId) : [...prev, gameId])
  }

  const handleSelectAll = () => {
    const allIds = (games as Game[] | undefined)?.map(g => g.id) ?? []
    setSelectedGameIds(allIds)
  }

  const handleUnselectAll = () => setSelectedGameIds([])

  const topScorer = stats ? [...stats].sort((a, b) => parseInt(b.goals) - parseInt(a.goals))[0] : null
  const topAssister = stats ? [...stats].sort((a, b) => parseInt(b.assists) - parseInt(a.assists))[0] : null

  const allGames = games as Game[] | undefined
  const allSeasonsArr = (allSeasons as Season[] | undefined) ?? []

  return (
    <div className="space-y-4">
      {/* Filter Section */}
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
                <SelectItem value="season">Season</SelectItem>
                <SelectItem value="games">Specific Games</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filterType === 'season' && (
            <div className="space-y-2">
              <Label>Select Season(s)</Label>
              <SeasonMultiSelect
                seasons={allSeasonsArr}
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
                  <button onClick={handleSelectAll} className="text-xs text-primary hover:underline">Select all</button>
                  <span className="text-xs text-muted-foreground">·</span>
                  <button onClick={handleUnselectAll} className="text-xs text-muted-foreground hover:text-foreground">Unselect all</button>
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1 bg-background rounded-md border border-border p-3">
                {allGames?.map(game => {
                  const s = allSeasonsArr.find(s => s.id === game.season_id)
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

      {/* Top cards */}
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

      {/* Rankings Table */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader>
          <CardTitle className="text-base">Player Rankings</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">#</th>
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">Player</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Goals</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Assists</th>
                    <th className="text-right py-2 font-semibold text-muted-foreground">G+A</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Placeholder rows shaped like the real ranking rows */}
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <tr key={idx} className="border-b border-border/50">
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-4" /></td>
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-32" /></td>
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-6 ml-auto" /></td>
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-6 ml-auto" /></td>
                      <td className="py-2"><Skeleton className="h-4 w-8 ml-auto" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && (!stats || stats.length === 0) && (
            <p className="text-sm text-muted-foreground text-center py-4">
              {filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view rankings' : 'Play some games to see rankings!'}
            </p>
          )}
          {stats && stats.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">#</th>
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">Player</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Goals</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Assists</th>
                    <th className="text-right py-2 font-semibold text-muted-foreground">G+A</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((row, idx) => (
                    <FadeIn
                      as="tr"
                      key={row.player_id}
                      delay={idx * 40}
                      className={`border-b border-border/50 ${idx < 3 ? 'font-medium' : ''}`}
                    >
                      <td className="py-2 pr-3 text-muted-foreground">
                        {idx + 1}
                      </td>
                      <td className="py-2 pr-3 text-foreground">{row.player_name}</td>
                      <td className="py-2 pr-3 text-right text-foreground">{row.goals}</td>
                      <td className="py-2 pr-3 text-right text-foreground">{row.assists}</td>
                      <td className="py-2 text-right font-bold text-primary">{parseInt(row.goals) + parseInt(row.assists)}</td>
                    </FadeIn>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
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
                      <th className="text-left font-medium py-2.5 pl-4 pr-2 w-8">#</th>
                      <th className="text-left font-medium py-2.5 px-2">Team</th>
                      <th className="text-center font-medium py-2.5 px-2">GP</th>
                      <th className="text-center font-medium py-2.5 px-2">W-L-T</th>
                      <th className="text-center font-medium py-2.5 px-2">+/-</th>
                      <th className="text-center font-medium py-2.5 px-2 pr-4">PTS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings.map(r => (
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
