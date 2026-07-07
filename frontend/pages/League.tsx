import { useEffect, useMemo, useState } from 'react'
import { useGetAllSeasons } from '../hooks/backend/stats'
import { getDefaultJamSeasonId } from '../lib/seasonUtils'
import {
  useGetLeague, computeStandings,
  useCreateLeagueTeam, useUpdateLeagueTeam, useDeleteLeagueTeam,
  useCreateLeagueGame, useDeleteLeagueGame, useRecordLeagueScore,
  useGenerateBracket, useUpdateSeasonPoints,
  type LeagueTeam, type EnrichedLeagueGame,
} from '../hooks/backend/league'
import { useAuth } from '../contexts/AuthContext'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import { Trophy, Plus, Settings2, Trash2, Pencil, Check, X, CalendarPlus } from 'lucide-react'

type Season = { id: number; name: string; year: number; organizer: string | null; start_date: string | null; end_date: string | null }

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

function dateBadgeParts(dateStr: string | null): { month: string; day: string } | null {
  if (!dateStr) return null
  const d = new Date(`${dateStr}T00:00`)
  if (isNaN(d.getTime())) return null
  return {
    month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: String(d.getDate()),
  }
}

type SubTab = 'standings' | 'schedule' | 'bracket'
const ROUND_ORDER = ['Quarterfinal', 'Semifinal', 'Final']

export default function League() {
  const { allowed } = useAuth()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: league, loading: leagueLoading, error, trigger: fetchLeague } = useGetLeague()

  const { trigger: createTeam } = useCreateLeagueTeam()
  const { trigger: updateTeam } = useUpdateLeagueTeam()
  const { trigger: deleteTeam } = useDeleteLeagueTeam()
  const { trigger: createLeagueGame } = useCreateLeagueGame()
  const { trigger: deleteLeagueGame } = useDeleteLeagueGame()
  const { trigger: recordScore } = useRecordLeagueScore()
  const { trigger: generateBracket } = useGenerateBracket()
  const { trigger: updateSeasonPoints } = useUpdateSeasonPoints()

  const [selectedSeasonId, setSelectedSeasonId] = useState<number | undefined>(undefined)
  const [subTab, setSubTab] = useState<SubTab>('standings')

  // Inline score entry (schedule + bracket)
  const [scoringGameId, setScoringGameId] = useState<number | null>(null)
  const [homeScoreInput, setHomeScoreInput] = useState('')
  const [awayScoreInput, setAwayScoreInput] = useState('')

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

  // Add matchup dialog
  const [addGameOpen, setAddGameOpen] = useState(false)
  const [newGame, setNewGame] = useState({ home: '', away: '', date: '', time: '' })

  // Bracket generation dialog
  const [bracketOpen, setBracketOpen] = useState(false)
  const [bracketSize, setBracketSize] = useState('4')

  useEffect(() => { fetchAllSeasons() }, [])

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

  // Keep the requested bracket size achievable with the teams available.
  const maxBracketSize = useMemo(() => {
    const n = standings.length
    return n >= 8 ? 8 : n >= 4 ? 4 : n >= 2 ? 2 : 0
  }, [standings])

  const openBracketDialog = () => {
    if (parseInt(bracketSize, 10) > maxBracketSize) setBracketSize(String(maxBracketSize))
    setBracketOpen(true)
  }
  const teamsById = useMemo(() => new Map((league?.teams ?? []).map(t => [t.id, t])), [league])
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

  const regularGames = useMemo(() =>
    (league?.games ?? []).filter(g => g.stage === 'regular'), [league])
  const playoffGames = useMemo(() =>
    (league?.games ?? []).filter(g => g.stage === 'playoff'), [league])
  const upcomingGames = useMemo(() =>
    regularGames.filter(g => !g.is_final).sort((a, b) => (a.game_date ?? '9999').localeCompare(b.game_date ?? '9999')),
    [regularGames])
  const finalGames = useMemo(() =>
    regularGames.filter(g => g.is_final).sort((a, b) => (b.game_date ?? '').localeCompare(a.game_date ?? '')),
    [regularGames])

  const teamName = (id: number | null) => (id != null ? teamsById.get(id)?.name : null) ?? 'TBD'

  const startScoring = (g: EnrichedLeagueGame) => {
    setScoringGameId(g.id)
    setHomeScoreInput(g.home_score != null ? String(g.home_score) : '')
    setAwayScoreInput(g.away_score != null ? String(g.away_score) : '')
  }

  const handleSaveScore = async () => {
    if (scoringGameId == null) return
    const home = homeScoreInput.trim() === '' ? null : parseInt(homeScoreInput, 10)
    const away = awayScoreInput.trim() === '' ? null : parseInt(awayScoreInput, 10)
    if ((home != null && isNaN(home)) || (away != null && isNaN(away))) return
    await recordScore({ id: scoringGameId, home_score: home, away_score: away })
    setScoringGameId(null)
    refresh()
  }

  const handleDeleteMatchup = async (id: number) => {
    await deleteLeagueGame({ id })
    setScoringGameId(null)
    refresh()
  }

  const handleAddTeam = async () => {
    if (!newTeamName.trim() || selectedSeasonId == null) return
    await createTeam({ seasonId: selectedSeasonId, name: newTeamName })
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

  const handleAddGame = async () => {
    if (selectedSeasonId == null || !newGame.home || !newGame.away || newGame.home === newGame.away) return
    await createLeagueGame({
      seasonId: selectedSeasonId,
      home_team_id: parseInt(newGame.home, 10),
      away_team_id: parseInt(newGame.away, 10),
      game_date: newGame.date || null,
      game_time: newGame.time || null,
    })
    setAddGameOpen(false)
    setNewGame({ home: '', away: '', date: '', time: '' })
    refresh()
  }

  const handleGenerateBracket = async () => {
    if (selectedSeasonId == null) return
    const size = parseInt(bracketSize, 10)
    const seeds = standings.slice(0, size).map(r => r.team.id)
    if (seeds.length < size) return
    await generateBracket({ seasonId: selectedSeasonId, seededTeamIds: seeds })
    setBracketOpen(false)
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

  const scoreEntry = (g: EnrichedLeagueGame) => (
    <div className="flex items-center gap-2 mt-2" onClick={e => e.stopPropagation()}>
      <Input
        type="number" inputMode="numeric" min={0}
        value={homeScoreInput} onChange={e => setHomeScoreInput(e.target.value)}
        placeholder={teamName(g.eff_home_team_id)}
        className="w-20 bg-background text-foreground border-border"
        aria-label={`${teamName(g.eff_home_team_id)} score`}
      />
      <span className="text-muted-foreground text-sm">to</span>
      <Input
        type="number" inputMode="numeric" min={0}
        value={awayScoreInput} onChange={e => setAwayScoreInput(e.target.value)}
        placeholder={teamName(g.eff_away_team_id)}
        className="w-20 bg-background text-foreground border-border"
        aria-label={`${teamName(g.eff_away_team_id)} score`}
      />
      <Button size="sm" onClick={handleSaveScore}><Check className="w-4 h-4" /></Button>
      <Button size="sm" variant="ghost" onClick={() => setScoringGameId(null)}><X className="w-4 h-4" /></Button>
      <button
        onClick={() => handleDeleteMatchup(g.id)}
        className="p-2 text-muted-foreground hover:text-destructive transition-colors ml-auto"
        aria-label="Delete matchup"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  )

  const matchupCard = (g: EnrichedLeagueGame, index: number) => {
    const badge = dateBadgeParts(g.game_date)
    const decided = g.is_final && g.eff_home_score != null && g.eff_away_score != null
    const homeWon = decided && g.eff_home_score! > g.eff_away_score!
    const awayWon = decided && g.eff_away_score! > g.eff_home_score!
    const canQuickScore = allowed && g.our_game_id == null
    return (
      <FadeIn key={g.id} delay={index * 40}>
        <Card className={`bg-card text-card-foreground border-border ${g.involves_us ? 'border-l-2 border-l-primary' : ''}`}>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-accent flex flex-col items-center justify-center shrink-0">
                {badge ? (
                  <>
                    <span className="text-[9px] font-semibold text-muted-foreground leading-none">{badge.month}</span>
                    <span className="text-lg font-bold text-foreground leading-tight">{badge.day}</span>
                  </>
                ) : (
                  <span className="text-[10px] text-muted-foreground">TBD</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm truncate ${homeWon ? 'font-bold' : 'font-medium'}`}>{teamName(g.eff_home_team_id)}</div>
                <div className={`text-sm truncate ${awayWon ? 'font-bold' : 'font-medium'}`}>{teamName(g.eff_away_team_id)}</div>
              </div>
              {decided ? (
                <div className="text-right shrink-0">
                  <div className={`text-sm tabular-nums ${homeWon ? 'font-bold' : ''}`}>{g.eff_home_score}</div>
                  <div className={`text-sm tabular-nums ${awayWon ? 'font-bold' : ''}`}>{g.eff_away_score}</div>
                </div>
              ) : canQuickScore && scoringGameId !== g.id ? (
                <Button size="sm" variant="outline" onClick={() => startScoring(g)}>Enter score</Button>
              ) : g.our_game_id != null ? (
                <span className="text-[10px] text-muted-foreground shrink-0">Tracked in Schedule</span>
              ) : null}
              {decided && canQuickScore && scoringGameId !== g.id && (
                <button
                  onClick={() => startScoring(g)}
                  className="p-1.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  aria-label="Edit score"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {scoringGameId === g.id && canQuickScore && scoreEntry(g)}
          </CardContent>
        </Card>
      </FadeIn>
    )
  }

  const bracketCard = (g: EnrichedLeagueGame) => {
    const decided = g.is_final && g.eff_home_score != null && g.eff_away_score != null
    const homeWon = decided && g.eff_home_score! > g.eff_away_score!
    const awayWon = decided && g.eff_away_score! > g.eff_home_score!
    const canQuickScore = allowed && g.our_game_id == null && g.eff_home_team_id != null && g.eff_away_team_id != null
    const row = (name: string, score: number | null, won: boolean, isUs: boolean) => (
      <div className={`flex items-center justify-between px-3 py-2 ${won ? 'bg-primary/10' : ''}`}>
        <span className={`text-sm truncate ${won ? 'font-bold' : ''} ${isUs ? 'text-primary font-semibold' : ''}`}>{name}</span>
        <span className={`text-sm tabular-nums ml-2 ${won ? 'font-bold' : 'text-muted-foreground'}`}>{score ?? ''}</span>
      </div>
    )
    return (
      <div key={g.id} className="w-56 shrink-0">
        <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
          {row(teamName(g.eff_home_team_id), decided ? g.eff_home_score : null, homeWon, g.eff_home_team_id != null && g.eff_home_team_id === usTeam?.id)}
          {row(teamName(g.eff_away_team_id), decided ? g.eff_away_score : null, awayWon, g.eff_away_team_id != null && g.eff_away_team_id === usTeam?.id)}
        </div>
        {canQuickScore && !decided && scoringGameId !== g.id && (
          <Button size="sm" variant="ghost" className="mt-1 w-full text-xs" onClick={() => startScoring(g)}>Enter score</Button>
        )}
        {scoringGameId === g.id && canQuickScore && scoreEntry(g)}
      </div>
    )
  }

  const seasons = (allSeasons as Season[] | undefined) ?? []
  const loading = leagueLoading || league == null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">League</h1>
        {allowed && (
          <button
            onClick={() => setManageOpen(true)}
            className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            aria-label="Manage league"
          >
            <Settings2 className="w-5 h-5" />
          </button>
        )}
      </div>

      <Select
        value={selectedSeasonId != null ? String(selectedSeasonId) : ''}
        onValueChange={v => { setSelectedSeasonId(parseInt(v, 10)); setScoringGameId(null) }}
      >
        <SelectTrigger className="bg-background text-foreground border-border">
          <SelectValue placeholder="Select season" />
        </SelectTrigger>
        <SelectContent>
          {seasons.map(s => (
            <SelectItem key={s.id} value={String(s.id)}>{seasonLabel(s)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-accent">
        {(['standings', 'schedule', 'bracket'] as SubTab[]).map(t => (
          <button
            key={t}
            onClick={() => { setSubTab(t); setScoringGameId(null) }}
            className={`py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
              subTab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <Card className="bg-card border-border">
          <CardContent className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </CardContent>
        </Card>
      ) : (
        <>
          {subTab === 'standings' && (
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

          {subTab === 'schedule' && (
            <div className="space-y-4">
              {allowed && (
                <Button variant="outline" size="sm" onClick={() => setAddGameOpen(true)}>
                  <CalendarPlus className="w-4 h-4 mr-2" /> Add matchup
                </Button>
              )}
              {upcomingGames.length === 0 && finalGames.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No matchups yet. Add the league schedule to see it here, scores included.
                </p>
              )}
              {upcomingGames.length > 0 && (
                <div className="space-y-2">
                  <h2 className="text-sm font-semibold text-muted-foreground">Upcoming</h2>
                  {upcomingGames.map((g, i) => matchupCard(g, i))}
                </div>
              )}
              {finalGames.length > 0 && (
                <div className="space-y-2">
                  <h2 className="text-sm font-semibold text-muted-foreground">Final</h2>
                  {finalGames.map((g, i) => matchupCard(g, i))}
                </div>
              )}
            </div>
          )}

          {subTab === 'bracket' && (
            <div className="space-y-4">
              {playoffGames.length === 0 ? (
                <Card className="bg-card border-border">
                  <CardContent className="p-6 text-center space-y-3">
                    <Trophy className="w-8 h-8 mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      No bracket yet. Generate one seeded from the current standings.
                    </p>
                    {allowed && maxBracketSize >= 2 && (
                      <Button size="sm" onClick={openBracketDialog}>
                        <Plus className="w-4 h-4 mr-2" /> Generate bracket
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <>
                  <div className="flex gap-4 overflow-x-auto pb-2">
                    {ROUND_ORDER.filter(r => playoffGames.some(g => g.round === r)).map(round => (
                      <div key={round} className="space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">{round}</h2>
                        <div className="space-y-3 flex flex-col justify-around h-full">
                          {playoffGames
                            .filter(g => g.round === round)
                            .sort((a, b) => (a.bracket_pos ?? 0) - (b.bracket_pos ?? 0))
                            .map(bracketCard)}
                        </div>
                      </div>
                    ))}
                    {playoffGames.some(g => g.round == null) && (
                      <div className="space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground">Playoffs</h2>
                        <div className="space-y-3">
                          {playoffGames.filter(g => g.round == null).map(bracketCard)}
                        </div>
                      </div>
                    )}
                  </div>
                  {allowed && maxBracketSize >= 2 && (
                    <Button variant="outline" size="sm" onClick={openBracketDialog}>
                      Regenerate bracket
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </>
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
          <DialogHeader><DialogTitle>Manage league</DialogTitle></DialogHeader>
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

      {/* Add matchup */}
      <Dialog open={addGameOpen} onOpenChange={setAddGameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add matchup</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Home team</Label>
              <Select value={newGame.home} onValueChange={v => setNewGame(g => ({ ...g, home: v }))}>
                <SelectTrigger className="bg-background text-foreground border-border"><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent>
                  {(league?.teams ?? []).map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Away team</Label>
              <Select value={newGame.away} onValueChange={v => setNewGame(g => ({ ...g, away: v }))}>
                <SelectTrigger className="bg-background text-foreground border-border"><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent>
                  {(league?.teams ?? []).filter(t => String(t.id) !== newGame.home).map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>Date</Label>
                <Input type="date" value={newGame.date} onChange={e => setNewGame(g => ({ ...g, date: e.target.value }))} className="bg-background text-foreground border-border" />
              </div>
              <div className="space-y-1">
                <Label>Time</Label>
                <Input type="time" value={newGame.time} onChange={e => setNewGame(g => ({ ...g, time: e.target.value }))} className="bg-background text-foreground border-border" />
              </div>
            </div>
            <Button onClick={handleAddGame} disabled={!newGame.home || !newGame.away} className="w-full">Add matchup</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Generate bracket */}
      <Dialog open={bracketOpen} onOpenChange={setBracketOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Generate bracket</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Seeds come from the current standings. Generating replaces any bracket games without a live-tracked game.
            </p>
            <div className="space-y-1">
              <Label>Teams</Label>
              <Select value={bracketSize} onValueChange={setBracketSize}>
                <SelectTrigger className="bg-background text-foreground border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[2, 4, 8].filter(n => standings.length >= n).map(n => (
                    <SelectItem key={n} value={String(n)}>Top {n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              {standings.slice(0, parseInt(bracketSize, 10)).map(r => (
                <div key={r.team.id} className="flex items-center gap-2 text-sm">
                  <span className="w-6 text-muted-foreground tabular-nums">{r.rank}.</span>
                  <span className={r.team.is_us ? 'font-bold text-primary' : ''}>{r.team.name}</span>
                </div>
              ))}
            </div>
            <Button onClick={handleGenerateBracket} className="w-full">
              Generate {bracketSize}-team bracket
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
