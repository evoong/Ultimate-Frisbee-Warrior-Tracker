import { useEffect, useState } from 'react'
import { useGetGames, useCreateGame, useUpdateGame, useDeleteGame, useGetLineups, useAddToLineup, useRemoveFromLineup } from '../hooks/backend/games'
import { useGetGameEvents, useCreateGoalEvent, useCreateOpponentGoalEvent, useDeleteEvent, useUpdateEvent, useGetEventTypes } from '../hooks/backend/events'
import { useGetPlayers } from '../hooks/backend/players'
import { useGetAllSeasons, useGetSeasons, useCreateSeason, useGetSeasonsMeta } from '../hooks/backend/stats'
import { useGetGameAttendance, useSetAttendance, useSetAllAttendance } from '../hooks/backend/attendance'
import { useGetJamSyncConflicts, useSyncJamNow, useCreateGameFromConflict, useLinkConflictToGame, useDismissConflict, type JamSyncConflict } from '../hooks/backend/jamSync'
import { getDefaultJamSeasonId } from '../lib/seasonUtils'
import { isTurnoverEvent } from '../lib/eventUtils'
import { sortGamesUpcomingFirst } from '../lib/gameOrder'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Badge } from '../lib/shadcn/badge'
import PlayerCombobox from '../components/PlayerCombobox'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import { useAuth } from '../contexts/AuthContext'
import { Calendar, Plus, Minus, Trophy, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Target, TrendingUp, PlusCircle, Trash2, Edit2, Save, X, Users, LayoutList, CalendarDays, StickyNote, ClipboardCheck, AlertTriangle, RefreshCw } from 'lucide-react'

function jamConflictReasonLabel(reason: string): string {
  switch (reason) {
    case 'possible_duplicate': return 'possible duplicate of an existing game'
    case 'multiple_candidates': return 'possible duplicate of multiple existing games'
    case 'no_season_match': return 'no season covers this date'
    case 'multiple_season_match': return 'multiple seasons cover this date'
    case 'unparseable': return "couldn't read this calendar event"
    default: return reason
  }
}

type Game = {
  id: number; opponent: string; game_date: string; game_time: string; game_type: string
  our_score: number; their_score: number; result: string; outcome_override: string | null; notes: string | null; season_id: number | null
}
type GameEvent = { id: number; event_type: string; event_timestamp: string; player_id: number | null; related_player_id: number | null; notes: string | null }
type Player = { id: number; display_name: string; position: string | null; gender_match: string | null; is_sub: boolean | null }
type Season = { id: number; name: string; year: number; organizer: string | null; default_game_time: string | null; start_date: string | null; end_date: string | null }
type SeasonMeta = { organizers: string[]; names: string[]; years: number[]; locations: string[] }
type LineupEntry = { id: number; player_id: number; lineup_name: string; display_name: string; position: string | null; gender_match: string | null }

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

const OUTCOME_OPTIONS = ['Win', 'Loss', 'Tie', 'Default Win', 'Default Loss', 'Forfeit']

export default function Schedule() {
  const { allowed } = useAuth()
  const { data: games, loading, error, trigger: fetchGames } = useGetGames()
  const { data: events, loading: eventsLoading, trigger: fetchEvents } = useGetGameEvents()
  const { data: players, trigger: fetchPlayers } = useGetPlayers()
  const { trigger: createGame } = useCreateGame()
  const { trigger: updateGame } = useUpdateGame()
  const { trigger: deleteGame } = useDeleteGame()
  const { data: seasons, trigger: fetchSeasons } = useGetAllSeasons()
  const { trigger: createSeason } = useCreateSeason()
  const { data: seasonsMeta, trigger: fetchSeasonsMeta } = useGetSeasonsMeta()
  const { data: seasonsWithGames, trigger: fetchSeasonsWithGames } = useGetSeasons()
  const { data: lineups, trigger: fetchLineups } = useGetLineups()
  const { trigger: addToLineup } = useAddToLineup()
  const { trigger: removeFromLineup } = useRemoveFromLineup()
  const { trigger: createGoal } = useCreateGoalEvent()
  const { trigger: createOpponentGoal } = useCreateOpponentGoalEvent()
  const { trigger: deleteEvent } = useDeleteEvent()
  const { trigger: updateEvent } = useUpdateEvent()
  const { data: eventTypes, trigger: fetchEventTypes } = useGetEventTypes()

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const { data: attendanceRows, trigger: fetchAttendance } = useGetGameAttendance()
  const { trigger: setAttendance } = useSetAttendance()
  const { trigger: setAllAttendance } = useSetAllAttendance()

  const { data: jamConflicts, trigger: fetchJamConflicts } = useGetJamSyncConflicts()
  const { trigger: syncJamNow, loading: syncingJam } = useSyncJamNow()
  const { trigger: createGameFromConflict } = useCreateGameFromConflict()
  const { trigger: linkConflictToGame } = useLinkConflictToGame()
  const { trigger: dismissConflict } = useDismissConflict()
  const [jamCreateSeasonChoice, setJamCreateSeasonChoice] = useState<Record<number, string>>({})
  const [selectedGame, setSelectedGame] = useState<Game | null>(null)
  const [activeTab, setActiveTab] = useState<'events' | 'lineups' | 'attendance' | 'notes'>('events')
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list')
  const [calendarDate, setCalendarDate] = useState(() => new Date())

  // New game form
  const [formData, setFormData] = useState({ opponent: '', game_date: '', game_time: '', game_type: 'Regular', season_id: '' })
  const [showNewSeason, setShowNewSeason] = useState(false)
  const [newSeasonData, setNewSeasonData] = useState({
    name: '', year: new Date().getFullYear().toString(), organizer: '', location: '', default_game_time: ''
  })
  const [newSeasonOrganizerMode, setNewSeasonOrganizerMode] = useState<'select' | 'new'>('select')
  const [newSeasonNameMode, setNewSeasonNameMode] = useState<'select' | 'new'>('select')
  const [newSeasonYearMode, setNewSeasonYearMode] = useState<'select' | 'new'>('select')
  const [newSeasonLocationMode, setNewSeasonLocationMode] = useState<'select' | 'new'>('select')
  const [creatingSeasonLoading, setCreatingSeasonLoading] = useState(false)
  const [scheduleSeasonIds, setScheduleSeasonIds] = useState<number[]>([])
  const [showUpcoming, setShowUpcoming] = useState(true)
  const [showPlayed, setShowPlayed] = useState(true)

  // Delete game
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null)

  // Edit event
  const [editingEventId, setEditingEventId] = useState<number | null>(null)
  const [editScorerId, setEditScorerId] = useState<string>('')
  const [editAssisterId, setEditAssisterId] = useState<string>('')

  // Add event
  const [showAddEvent, setShowAddEvent] = useState(false)
  const [newEventType, setNewEventType] = useState<string>('Goal')
  const [newScorerId, setNewScorerId] = useState<string>('')
  const [newAssisterId, setNewAssisterId] = useState<string>('')

  // Game notes editing
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')

  // Outcome override
  const [editingOutcome, setEditingOutcome] = useState(false)
  const [outcomeValue, setOutcomeValue] = useState<string>('')

  // Lineup
  const [lineupName, setLineupName] = useState('Lineup 1')
  const [lineupPlayerSelect, setLineupPlayerSelect] = useState<string>('')

  useEffect(() => {
    // fetchGames happens in the scheduleSeasonIds effect below (fires on mount too)
    fetchPlayers()
    fetchSeasons()
    fetchSeasonsMeta()
    fetchEventTypes()
    fetchSeasonsWithGames()
    fetchJamConflicts()
  }, [])

  const handleSyncJamNow = async () => {
    await syncJamNow()
    fetchJamConflicts()
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined })
  }

  const handleCreateGameFromConflict = async (conflict: JamSyncConflict) => {
    const chosen = jamCreateSeasonChoice[conflict.id]
    await createGameFromConflict({ conflict, seasonId: chosen ? parseInt(chosen) : null })
    fetchJamConflicts()
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined })
  }

  const handleLinkJamConflict = async (conflict: JamSyncConflict) => {
    if (!conflict.existing_game_id) return
    await linkConflictToGame({ conflict, gameId: conflict.existing_game_id })
    fetchJamConflicts()
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined })
  }

  const handleDismissJamConflict = async (conflictId: number) => {
    await dismissConflict({ conflictId })
    fetchJamConflicts()
  }

  useEffect(() => {
    const s = seasonsWithGames as { id: number }[] | undefined
    const allS = seasons as Season[] | undefined
    if (!s || s.length === 0 || !allS || allS.length === 0 || scheduleSeasonIds.length > 0) return
    const defaultId = getDefaultJamSeasonId(allS, s[0]!.id)
    setScheduleSeasonIds([defaultId])
  }, [seasonsWithGames, seasons])

  // Reload games when season filter changes
  useEffect(() => {
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined })
  }, [scheduleSeasonIds])

  const handleSelectGame = (game: Game) => {
    setSelectedGame(game)
    fetchEvents({ gameId: game.id })
    fetchLineups({ gameId: game.id })
    fetchAttendance({ gameId: game.id })
    setActiveTab('events')
    setEditingNotes(false)
    setEditingOutcome(false)
    setNotesValue(game.notes ?? '')
    setOutcomeValue(game.outcome_override ?? '')
    setShowAddEvent(false)
    setNewEventType('Goal')
    setNewScorerId('')
    setNewAssisterId('')
  }

  const handleBack = () => { setSelectedGame(null); setEditingEventId(null) }

  const handleSeasonSelect = (value: string) => {
    if (value === '__new__') { setShowNewSeason(true); setFormData(f => ({ ...f, season_id: '' })) }
    else { setShowNewSeason(false); setFormData(f => ({ ...f, season_id: value })) }
  }

  const handleCreateNewSeason = async () => {
    if (!newSeasonData.name || !newSeasonData.year) return
    setCreatingSeasonLoading(true)
    const created = await createSeason({
      name: newSeasonData.name,
      year: parseInt(newSeasonData.year),
      organizer: newSeasonData.organizer || undefined,
      location: newSeasonData.location || undefined,
      default_game_time: newSeasonData.default_game_time || undefined,
    }) as Season | undefined
    if (created) {
      await fetchSeasons()
      await fetchSeasonsMeta()
      setFormData(f => ({
        ...f,
        season_id: String(created.id),
        game_time: created.default_game_time ?? f.game_time
      }))
      setShowNewSeason(false)
      setNewSeasonData({ name: '', year: new Date().getFullYear().toString(), organizer: '', location: '', default_game_time: '' })
    }
    setCreatingSeasonLoading(false)
  }

  // When season selected for new game, auto-fill default time
  const handleSeasonSelectForGame = (value: string) => {
    handleSeasonSelect(value)
    const s = (seasons as Season[] | undefined)?.find(s => String(s.id) === value)
    if (s?.default_game_time) setFormData(f => ({ ...f, game_time: s.default_game_time! }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await createGame({
      opponent: formData.opponent,
      game_date: formData.game_date,
      game_time: formData.game_time,
      game_type: formData.game_type,
      season_id: formData.season_id ? parseInt(formData.season_id) : null,
    })
    setIsDialogOpen(false)
    setFormData({ opponent: '', game_date: '', game_time: '', game_type: 'Regular', season_id: '' })
    setShowNewSeason(false)
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined })
  }

  const handleDeleteGame = async (gameId: number) => {
    await deleteGame({ gameId })
    setDeleteConfirmId(null)
    setSelectedGame(null)
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined })
  }

  const handleSaveNotes = async () => {
    if (!selectedGame) return
    const updated = await updateGame({ gameId: selectedGame.id, notes: notesValue }) as Game | undefined
    if (updated) setSelectedGame(updated)
    setEditingNotes(false)
  }

  const handleSaveOutcome = async () => {
    if (!selectedGame) return
    const override = outcomeValue === '__auto__' ? null : outcomeValue
    const updated = await updateGame({ gameId: selectedGame.id, outcome_override: override }) as Game | undefined
    if (updated) setSelectedGame(updated)
    setEditingOutcome(false)
  }

  const handleDeleteEvent = async (eventId: number) => {
    if (!selectedGame) return
    await deleteEvent({ eventId })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleEditEvent = (event: GameEvent) => {
    setEditingEventId(event.id)
    setEditScorerId(event.player_id ? String(event.player_id) : '__none__')
    setEditAssisterId(event.related_player_id ? String(event.related_player_id) : '__none__')
  }

  const handleSaveEventEdit = async () => {
    if (!editingEventId || !selectedGame) return
    await updateEvent({
      eventId: editingEventId,
      playerId: editScorerId && editScorerId !== '__none__' ? parseInt(editScorerId) : null,
      relatedPlayerId: editAssisterId && editAssisterId !== '__none__' ? parseInt(editAssisterId) : null,
    })
    setEditingEventId(null)
    fetchEvents({ gameId: selectedGame.id })
  }

  const resolveNewPlayerId = (id: string) => (id && id !== '__none__' && id !== '__opponent__') ? parseInt(id) : null

  const handleAddEvent = async () => {
    if (!selectedGame) return
    // Picking "— Opponent —" as scorer on a goal means the other team scored
    if (newEventType === 'Goal' && newScorerId === '__opponent__') {
      await createOpponentGoal({ gameId: selectedGame.id })
    } else {
      await createGoal({
        gameId: selectedGame.id,
        playerId: resolveNewPlayerId(newScorerId),
        relatedPlayerId: resolveNewPlayerId(newAssisterId),
        eventType: newEventType,
      })
    }
    setNewScorerId('')
    setNewAssisterId('')
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleAddOpponentGoal = async () => {
    if (!selectedGame) return
    await createOpponentGoal({ gameId: selectedGame.id })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleAddToLineup = async () => {
    if (!selectedGame || !lineupPlayerSelect) return
    await addToLineup({ gameId: selectedGame.id, player_id: parseInt(lineupPlayerSelect), lineup_name: lineupName, seasonId: selectedGame.season_id })
    setLineupPlayerSelect('')
    fetchLineups({ gameId: selectedGame.id })
  }

  const handleRemoveFromLineup = async (playerId: number, lineupGroup: string) => {
    if (!selectedGame) return
    await removeFromLineup({ gameId: selectedGame.id, playerId, lineup_name: lineupGroup })
    fetchLineups({ gameId: selectedGame.id })
  }

  const formatDate = (dateStr: string) => new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const formatTime = (timeStr: string) => {
    if (!timeStr) return ''
    const [hours, minutes] = timeStr.split(':')
    const hour = parseInt(hours || '0')
    return `${hour % 12 || 12}:${minutes || '00'} ${hour >= 12 ? 'PM' : 'AM'}`
  }
  const formatTimestamp = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  const getPlayerName = (id: number | null) =>
    id ? (players as Player[] | undefined)?.find(p => p.id === id)?.display_name ?? null : null

  const getSeasonLabel = (seasonId: number | null) => {
    if (!seasonId || !seasons) return null
    const s = (seasons as Season[]).find(s => s.id === seasonId)
    return s ? seasonLabel(s) : null
  }

  const meta = seasonsMeta as SeasonMeta | undefined

  const playerOptions = (players as Player[] | undefined)?.map(p => ({ id: p.id.toString(), label: p.display_name })) ?? []
  const newEventPlayerOptions = [{ id: '__opponent__', label: 'Opponent' }, ...playerOptions]
  const isNewEventGoalLike = ['Goal', 'Caught OB'].includes(newEventType)

  // Calendar helpers
  const calYear = calendarDate.getFullYear()
  const calMonth = calendarDate.getMonth()
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate()
  const firstDay = new Date(calYear, calMonth, 1).getDay()
  const monthGames = (games as Game[] | undefined)?.filter(g => {
    const d = new Date(g.game_date + 'T00:00:00')
    return d.getFullYear() === calYear && d.getMonth() === calMonth
  }) ?? []
  const gamesByDay: Record<number, Game[]> = {}
  for (const g of monthGames) {
    const day = parseInt(g.game_date.split('-')[2]!)
    if (!gamesByDay[day]) gamesByDay[day] = []
    gamesByDay[day]!.push(g)
  }

  // ── Game Detail ──────────────────────────────────────────────────────────────
  if (selectedGame) {
    const gameEvents = (events as GameEvent[] | undefined) ?? []
    const ourGoals = gameEvents.filter(e => e.event_type === 'Goal').length
    const theirGoals = gameEvents.filter(e => e.event_type === 'Opponent Goal').length
    const displayResult = selectedGame.outcome_override ?? selectedGame.result

    const playerMap: Record<number, { name: string; goals: number; assists: number; turnovers: number }> = {}
    const ensurePlayer = (id: number, name: string) => {
      if (!playerMap[id]) playerMap[id] = { name, goals: 0, assists: 0, turnovers: 0 }
    }
    gameEvents.forEach(e => {
      const sn = getPlayerName(e.player_id), an = getPlayerName(e.related_player_id)
      if (e.event_type === 'Goal') {
        if (e.player_id && sn) { ensurePlayer(e.player_id, sn); playerMap[e.player_id]!.goals++ }
        if (e.related_player_id && an) { ensurePlayer(e.related_player_id, an); playerMap[e.related_player_id]!.assists++ }
      } else if (isTurnoverEvent(e.event_type)) {
        if (e.player_id && sn) { ensurePlayer(e.player_id, sn); playerMap[e.player_id]!.turnovers++ }
      }
    })
    const playerStats = Object.values(playerMap).sort((a, b) => b.goals - a.goals || b.assists - a.assists)
    const lineupEntries = (lineups as LineupEntry[] | undefined) ?? []
    const lineupByGroup = lineupEntries.reduce((acc, e) => {
      if (!acc[e.lineup_name]) acc[e.lineup_name] = []
      acc[e.lineup_name]!.push(e)
      return acc
    }, {} as Record<string, LineupEntry[]>)

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <button onClick={handleBack} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ChevronLeft className="w-5 h-5" />
            <span className="text-sm font-medium">Back to Schedule</span>
          </button>
          {allowed && (
            <button
              onClick={() => setDeleteConfirmId(selectedGame.id)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          )}
        </div>

        {/* Game header */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="pt-6 pb-4">
            <div className="text-center mb-4">
              <div className="text-lg text-muted-foreground">vs {selectedGame.opponent}</div>
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground mt-1">
                <Calendar className="w-4 h-4" />
                <span>{formatDate(selectedGame.game_date)}</span>
                <span>•</span>
                <span>{formatTime(selectedGame.game_time)}</span>
              </div>
              {selectedGame.season_id && (
                <div className="mt-1 text-xs text-muted-foreground">{getSeasonLabel(selectedGame.season_id)}</div>
              )}
            </div>
            <div className="flex items-center justify-center gap-8">
              <div className="text-center">
                <div className="text-6xl font-bold text-primary tabular-nums">{ourGoals}</div>
                <div className="text-sm text-muted-foreground mt-1">Us</div>
              </div>
              <div className="text-3xl font-light text-muted-foreground">-</div>
              <div className="text-center">
                <div className="text-6xl font-bold text-muted-foreground tabular-nums">{theirGoals}</div>
                <div className="text-sm text-muted-foreground mt-1">Them</div>
              </div>
            </div>

            {/* Outcome */}
            <div className="text-center mt-4">
              {editingOutcome ? (
                <div className="flex items-center justify-center gap-2">
                  <Select value={outcomeValue || '__auto__'} onValueChange={setOutcomeValue}>
                    <SelectTrigger className="bg-background text-foreground border-border w-40 h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__auto__">Auto (from score)</SelectItem>
                      {OUTCOME_OPTIONS.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <button onClick={handleSaveOutcome} className="text-green-600 hover:text-green-700"><Save className="w-4 h-4" /></button>
                  <button onClick={() => setEditingOutcome(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2">
                  {displayResult && (
                    <span className={`text-sm font-semibold ${displayResult.startsWith('Win') || displayResult === 'Default Win' ? 'text-green-600 dark:text-green-400' : displayResult === 'Tie' ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                      {displayResult}
                      {selectedGame.outcome_override && <span className="text-xs font-normal ml-1 opacity-70">(override)</span>}
                    </span>
                  )}
                  {allowed && (
                    <button onClick={() => { setEditingOutcome(true); setOutcomeValue(selectedGame.outcome_override ?? '') }} className="text-muted-foreground hover:text-foreground">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Box score */}
        {playerStats.length > 0 && (
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader><CardTitle className="text-base">Box Score</CardTitle></CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center gap-3 px-3 text-xs text-muted-foreground font-medium">
                  <div className="flex-1">Player</div>
                  <div className="w-10 text-center text-green-600 dark:text-green-400">G</div>
                  <div className="w-10 text-center text-blue-600 dark:text-blue-400">A</div>
                  <div className="w-10 text-center text-orange-600 dark:text-orange-400">TO</div>
                </div>
                {playerStats.map(p => (
                  <div key={p.name} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-background">
                    <div className="flex-1 font-medium text-foreground text-sm">{p.name}</div>
                    <div className="w-10 text-center font-bold text-green-600 dark:text-green-400">{p.goals}</div>
                    <div className="w-10 text-center font-bold text-blue-600 dark:text-blue-400">{p.assists}</div>
                    <div className="w-10 text-center font-bold text-orange-600 dark:text-orange-400">{p.turnovers}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Tab bar */}
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {[
            { key: 'events' as const, icon: LayoutList, label: 'Events' },
            { key: 'lineups' as const, icon: Users, label: 'Lineups' },
            { key: 'attendance' as const, icon: ClipboardCheck, label: 'Attendance' },
            { key: 'notes' as const, icon: StickyNote, label: 'Notes' },
          ].map(({ key, icon: Icon, label }) => (
            <button key={key} onClick={() => setActiveTab(key)}
              className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-2 px-2 rounded-md font-medium transition-colors ${activeTab === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <Icon className="w-3.5 h-3.5" />{label}
            </button>
          ))}
        </div>

        {/* Add Event */}
        {activeTab === 'events' && allowed && (
          <Card className="bg-card text-card-foreground border-border">
            <button
              className="w-full flex items-center justify-between px-6 py-4"
              onClick={() => setShowAddEvent(v => !v)}
            >
              <span className="text-base font-semibold flex items-center gap-2"><PlusCircle className="w-4 h-4" />Add Event</span>
              {showAddEvent ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </button>
            {showAddEvent && (
              <CardContent className="pt-0 space-y-3">
                <div className="grid grid-cols-[70px_1fr] items-center gap-2">
                  <Label className="text-xs text-muted-foreground text-right">Event</Label>
                  <Select value={newEventType} onValueChange={setNewEventType}>
                    <SelectTrigger className="h-9 text-sm bg-background text-foreground border-border"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(eventTypes as { id: number; name: string }[] | undefined)?.map(et => (
                        <SelectItem key={et.id} value={et.name}>{et.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-[70px_1fr] items-center gap-2">
                  <Label className="text-xs text-muted-foreground text-right">{isNewEventGoalLike ? 'Scorer' : 'Player'}</Label>
                  <PlayerCombobox
                    players={newEventPlayerOptions}
                    value={newScorerId || '__none__'}
                    onValueChange={setNewScorerId}
                    placeholder="None"
                    className="w-full h-9 text-sm bg-background border-border"
                  />
                </div>
                {isNewEventGoalLike && newScorerId !== '__opponent__' && (
                  <div className="grid grid-cols-[70px_1fr] items-center gap-2">
                    <Label className="text-xs text-muted-foreground text-right">Assister</Label>
                    <PlayerCombobox
                      players={playerOptions}
                      value={newAssisterId || '__none__'}
                      onValueChange={setNewAssisterId}
                      placeholder="None"
                      className="w-full h-9 text-sm bg-background border-border"
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={handleAddEvent} className="h-10 bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center gap-1.5">
                    <Plus className="w-4 h-4" />Add {newEventType}
                  </Button>
                  <Button onClick={handleAddOpponentGoal} variant="outline" className="h-10 flex items-center justify-center gap-1.5">
                    <Minus className="w-4 h-4" />They Score
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* Event Log */}
        {activeTab === 'events' && (
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span>Event Log</span>
                <span className="text-sm font-normal text-muted-foreground">{gameEvents.length} events</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {eventsLoading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Loading events...</div>
              ) : gameEvents.length ? (
                <div className="space-y-0">
                  {gameEvents.map((event, i) => {
                    const scorer = getPlayerName(event.player_id)
                    const assister = getPlayerName(event.related_player_id)
                    const isGoal = event.event_type === 'Goal'
                    const isOpponentGoal = event.event_type === 'Opponent Goal'
                    const isTurnover = isTurnoverEvent(event.event_type)
                    const isEditing = editingEventId === event.id

                    return (
                      <div key={event.id} className="py-2.5 border-b border-border last:border-0">
                        {isEditing ? (
                          <div className="space-y-2 bg-background rounded-lg p-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Scorer / Player</Label>
                              <PlayerCombobox players={playerOptions} value={editScorerId || '__none__'} onValueChange={setEditScorerId} placeholder="Select player..." className="w-full bg-card border-border" />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Assister / Related</Label>
                              <PlayerCombobox players={playerOptions} value={editAssisterId || '__none__'} onValueChange={setEditAssisterId} placeholder="Select player..." className="w-full bg-card border-border" />
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" onClick={handleSaveEventEdit} className="flex-1 bg-primary text-primary-foreground h-8 text-xs"><Save className="w-3 h-3 mr-1" />Save</Button>
                              <Button size="sm" variant="outline" onClick={() => setEditingEventId(null)} className="h-8 text-xs"><X className="w-3 h-3" /></Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <div className="w-6 text-xs text-muted-foreground text-center tabular-nums">{i + 1}</div>
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isGoal ? 'bg-green-100 dark:bg-green-950' : isOpponentGoal ? 'bg-red-100 dark:bg-red-950' : 'bg-orange-100 dark:bg-orange-950'}`}>
                              {isGoal && <Target className="w-4 h-4 text-green-600 dark:text-green-400" />}
                              {isOpponentGoal && <Target className="w-4 h-4 text-red-600 dark:text-red-400" />}
                              {isTurnover && <TrendingUp className="w-4 h-4 text-orange-600 dark:text-orange-400" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-foreground">
                                {isGoal && (<>{scorer ?? 'Unknown'} scored{assister && <span className="text-muted-foreground font-normal"> (from {assister})</span>}</>)}
                                {isOpponentGoal && 'Opponent goal'}
                                {isTurnover && <>{scorer ?? 'Unknown'} turned it over</>}
                                {!isGoal && !isOpponentGoal && !isTurnover && event.event_type}
                              </div>
                              <div className="text-xs text-muted-foreground">{formatTimestamp(event.event_timestamp)}</div>
                            </div>
                            {allowed && (
                              <div className="flex items-center gap-1 shrink-0">
                                <button onClick={() => handleEditEvent(event)} className="p-1.5 rounded hover:bg-accent transition-colors">
                                  <Edit2 className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                                </button>
                                <button onClick={() => handleDeleteEvent(event.id)} className="p-1.5 rounded hover:bg-destructive/10 transition-colors">
                                  <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="text-center py-10">
                  <Target className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-40" />
                  <p className="text-muted-foreground text-sm">No events recorded for this game</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Lineups */}
        {activeTab === 'lineups' && (
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4" />Lineups</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Add to lineup */}
              {allowed && (
                <div className="space-y-2 bg-background rounded-lg p-3">
                  <Label className="text-xs text-muted-foreground">Add Player</Label>
                  <Select value={lineupName} onValueChange={setLineupName}>
                    <SelectTrigger className="h-8 text-sm bg-card border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['Lineup 1', 'Lineup 2'].map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Select value={lineupPlayerSelect} onValueChange={setLineupPlayerSelect}>
                        <SelectTrigger className="h-8 text-sm bg-card border-border text-foreground"><SelectValue placeholder="Select player..." /></SelectTrigger>
                        <SelectContent>
                          {(players as Player[] | undefined)?.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.display_name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button size="sm" onClick={handleAddToLineup} disabled={!lineupPlayerSelect} className="h-8 bg-primary text-primary-foreground hover:bg-primary/90">
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Lineup groups */}
              {Object.keys(lineupByGroup).length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <Users className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  No lineups set yet
                </div>
              ) : (
                Object.entries(lineupByGroup).map(([group, entries]) => (
                  <div key={group}>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="secondary" className="text-xs">{group}</Badge>
                      <span className="text-xs text-muted-foreground">{entries.length} players</span>
                    </div>
                    <div className="space-y-1.5">
                      {entries.map(e => (
                        <div key={e.player_id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background">
                          <div className="flex-1">
                            <span className="text-sm font-medium text-foreground">{e.display_name}</span>
                            {e.position && <span className="text-xs text-muted-foreground ml-2">{e.position}</span>}
                          </div>
                          {allowed && (
                            <button onClick={() => handleRemoveFromLineup(e.player_id, e.lineup_name)} className="p-1 rounded hover:bg-destructive/10">
                              <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}

        {/* Attendance */}
        {activeTab === 'attendance' && (() => {
          const allPlayers = players as Player[] | undefined
          const rows = attendanceRows as { player_id: number; in: boolean }[] | undefined
          const lineupPlayerIds = new Set(lineupEntries.map(e => e.player_id))
          const nonSubRows = (rows ?? []).filter(r => {
            const p = allPlayers?.find(pl => pl.id === r.player_id)
            if (!p) return false
            if (!p.is_sub) return true
            return lineupPlayerIds.has(r.player_id)
          }).sort((a, b) => {
            const pa = allPlayers?.find(p => p.id === a.player_id)?.display_name ?? ''
            const pb = allPlayers?.find(p => p.id === b.player_id)?.display_name ?? ''
            return pa.localeCompare(pb)
          })
          const inCount = nonSubRows.filter(r => r.in).length
          return (
            <Card className="bg-card text-card-foreground border-border">
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2"><ClipboardCheck className="w-4 h-4" />Attendance</span>
                  <span className="text-sm font-normal text-muted-foreground">{rows ? `${inCount} / ${nonSubRows.length}` : '…'}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {nonSubRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No roster data for this game.</p>
                ) : (
                  <>
                    {allowed && (
                      <div className="flex justify-end">
                        <button
                          className="text-xs text-muted-foreground hover:text-foreground underline"
                          onClick={async () => {
                            await setAllAttendance({ gameId: selectedGame!.id, attending: false, playerIds: nonSubRows.map(r => r.player_id) })
                            fetchAttendance({ gameId: selectedGame!.id })
                          }}
                        >
                          Unselect all
                        </button>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      {nonSubRows.map(row => {
                        const player = allPlayers?.find(p => p.id === row.player_id)
                        return (
                          <label key={row.player_id} className="flex items-center gap-2 py-1 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={row.in}
                              disabled={!allowed}
                              onChange={async e => {
                                await setAttendance({ gameId: selectedGame!.id, playerId: row.player_id, attending: e.target.checked })
                                fetchAttendance({ gameId: selectedGame!.id })
                              }}
                              className="accent-primary w-4 h-4 rounded cursor-pointer disabled:cursor-default"
                            />
                            <span className={`text-sm ${row.in ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                              {player?.display_name ?? `Player ${row.player_id}`}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          )
        })()}

        {/* Notes */}
        {activeTab === 'notes' && (
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2"><StickyNote className="w-4 h-4" />Game Notes</span>
                {allowed && !editingNotes && (
                  <button onClick={() => { setEditingNotes(true); setNotesValue(selectedGame.notes ?? '') }} className="text-muted-foreground hover:text-foreground">
                    <Edit2 className="w-4 h-4" />
                  </button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {editingNotes ? (
                <div className="space-y-3">
                  <textarea
                    value={notesValue}
                    onChange={e => setNotesValue(e.target.value)}
                    placeholder="Add notes about this game..."
                    rows={6}
                    className="w-full rounded-md border border-border bg-background text-foreground text-sm px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <div className="flex gap-2">
                    <Button onClick={handleSaveNotes} size="sm" className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 h-9">
                      <Save className="w-3.5 h-3.5 mr-1.5" />Save Notes
                    </Button>
                    <Button onClick={() => setEditingNotes(false)} size="sm" variant="outline" className="h-9"><X className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>
              ) : (
                <div>
                  {selectedGame.notes ? (
                    <p className="text-sm text-foreground whitespace-pre-wrap">{selectedGame.notes}</p>
                  ) : allowed ? (
                    <button onClick={() => setEditingNotes(true)} className="w-full text-center py-8 text-muted-foreground text-sm hover:text-foreground transition-colors">
                      <StickyNote className="w-10 h-10 mx-auto mb-2 opacity-40" />
                      No notes yet, tap to add
                    </button>
                  ) : (
                    <div className="w-full text-center py-8 text-muted-foreground text-sm">
                      <StickyNote className="w-10 h-10 mx-auto mb-2 opacity-40" />
                      No notes yet
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Delete confirm */}
        <Dialog open={deleteConfirmId !== null} onOpenChange={open => !open && setDeleteConfirmId(null)}>
          <DialogContent className="bg-card text-card-foreground">
            <DialogHeader><DialogTitle>Delete Game</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">This will permanently delete the game and all its events. This cannot be undone.</p>
            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={() => setDeleteConfirmId(null)} className="flex-1">Cancel</Button>
              <Button onClick={() => deleteConfirmId && handleDeleteGame(deleteConfirmId)} className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete Game</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // ── Schedule List / Calendar ──────────────────────────────────────────────────
  if (error) return <div className="flex items-center justify-center h-64"><div className="text-destructive">Error: {error}</div></div>

  // Primary data for this view. While undefined the games have not loaded yet, so
  // we render skeleton cards shaped like real game cards to avoid a blank flash
  // and layout jump. `loading` is still referenced elsewhere; this is presentational.
  const gamesData = games as Game[] | undefined
  const gamesLoading = gamesData === undefined
  const filteredGames = gamesData ?? []

  // Next upcoming game first, then the rest of the future schedule
  // chronologically; a separate "Played" section below runs most-recent-first
  // so the last result is always the first thing you see in that group.
  const now = new Date()
  const gameStartsAt = (g: Game) => new Date(`${g.game_date}T${g.game_time || '00:00:00'}`)
  const upcomingGames = filteredGames.filter(g => gameStartsAt(g) >= now).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime())
  const pastGames = filteredGames.filter(g => gameStartsAt(g) < now).sort((a, b) => gameStartsAt(b).getTime() - gameStartsAt(a).getTime())
  const sortedGames = sortGamesUpcomingFirst(filteredGames, now)

  const formatRelativeDay = (dateStr: string) => {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const days = Math.round((startOfDay(new Date(dateStr + 'T00:00:00')).getTime() - startOfDay(now).getTime()) / 86_400_000)
    if (days === 0) return 'Today'
    if (days === 1) return 'Tomorrow'
    if (days > 1 && days <= 6) return `In ${days} days`
    return null
  }

  const renderGameCard = (game: Game, index: number, isNext: boolean, isPlayed: boolean) => {
    const displayResult = game.outcome_override ?? game.result
    const relativeDay = isNext ? formatRelativeDay(game.game_date) : null
    // Redundant once a single season is already the active filter; only earns
    // its place in the meta line when the list is mixing seasons together.
    const showSeasonLabel = game.season_id && scheduleSeasonIds.length !== 1
    return (
      <FadeIn key={game.id} delay={index * 40}>
        <Card
          onClick={() => handleSelectGame(game)}
          className={`bg-card text-card-foreground cursor-pointer hover:bg-accent/50 active:scale-[0.99] transition-all ${isNext ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'}`}
        >
          <CardContent className="py-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                {isNext && (
                  <div className="text-xs font-semibold uppercase tracking-wide text-primary mb-0.5">
                    Next Up{relativeDay ? ` · ${relativeDay}` : ''}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <span className="text-base font-bold text-foreground truncate">vs {game.opponent}</span>
                  {game.game_type === 'Playoff' && <Trophy className="w-4 h-4 text-yellow-500 shrink-0" />}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 text-sm text-muted-foreground truncate">
                  <Calendar className="w-3.5 h-3.5 shrink-0" />
                  <span>{formatDate(game.game_date)}</span>
                  <span>•</span>
                  <span>{formatTime(game.game_time)}</span>
                  {showSeasonLabel && (
                    <>
                      <span>•</span>
                      <span className="truncate">{getSeasonLabel(game.season_id!)}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isPlayed && (
                  <div className="text-right">
                    <div className="text-2xl font-bold leading-none">
                      <span className="text-primary">{game.our_score}</span>
                      <span className="text-muted-foreground mx-1">-</span>
                      <span className="text-muted-foreground">{game.their_score}</span>
                    </div>
                    {displayResult && (
                      <div className={`text-xs font-medium mt-1 ${displayResult.startsWith('Win') || displayResult === 'Default Win' ? 'text-green-600 dark:text-green-400' : displayResult === 'Tie' ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                        {displayResult}
                        {game.outcome_override && <span className="text-[10px] opacity-60 ml-0.5">*</span>}
                      </div>
                    )}
                  </div>
                )}
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </FadeIn>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex bg-muted rounded-lg p-0.5">
            <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}>
              <LayoutList className="w-4 h-4" />
            </button>
            <button onClick={() => setViewMode('calendar')} className={`p-1.5 rounded-md transition-colors ${viewMode === 'calendar' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}>
              <CalendarDays className="w-4 h-4" />
            </button>
          </div>
          {allowed && (
          <button
            onClick={handleSyncJamNow}
            disabled={syncingJam}
            title="Sync games from the JAM Sports calendar now (also runs automatically once a day at 6am Eastern)"
            className="flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncingJam ? 'animate-spin' : ''}`} />
          </button>
          )}
          {allowed && (
          <Dialog open={isDialogOpen} onOpenChange={open => { setIsDialogOpen(open); if (!open) setShowNewSeason(false) }}>
            <button onClick={() => setIsDialogOpen(true)} className="flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" />Add Game
            </button>
            <DialogContent className="bg-card text-card-foreground max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Schedule New Game</DialogTitle></DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="opponent">Opponent</Label>
                  <Input id="opponent" value={formData.opponent} onChange={e => setFormData({ ...formData, opponent: e.target.value })} required className="bg-background text-foreground" />
                </div>
                <div className="space-y-2">
                  <Label>Season <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Select value={showNewSeason ? '__new__' : formData.season_id} onValueChange={handleSeasonSelectForGame}>
                    <SelectTrigger className="bg-background text-foreground"><SelectValue placeholder="No season selected" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No season</SelectItem>
                      {(seasons as Season[] | undefined)?.map(s => (
                        <SelectItem key={s.id} value={String(s.id)}>{seasonLabel(s)}</SelectItem>
                      ))}
                      <SelectItem value="__new__">
                        <span className="flex items-center gap-2 text-primary"><PlusCircle className="w-4 h-4" />Create new season…</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>

                  {showNewSeason && (
                    <div className="border border-border rounded-lg p-3 space-y-3 bg-background">
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">New Season</p>

                      {/* Organizer */}
                      <div className="space-y-1">
                        <Label className="text-xs">Organizer</Label>
                        <div className="flex gap-2">
                          {newSeasonOrganizerMode === 'select' && meta?.organizers && meta.organizers.length > 0 ? (
                            <Select value={newSeasonData.organizer} onValueChange={v => v === '__new__' ? setNewSeasonOrganizerMode('new') : setNewSeasonData(d => ({ ...d, organizer: v }))}>
                              <SelectTrigger className="h-8 text-sm bg-card border-border text-foreground flex-1"><SelectValue placeholder="Select or create..." /></SelectTrigger>
                              <SelectContent>
                                {meta.organizers.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                                <SelectItem value="__new__"><span className="text-primary">+ New organizer</span></SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input placeholder="Organizer name" value={newSeasonData.organizer} onChange={e => setNewSeasonData(d => ({ ...d, organizer: e.target.value }))} className="h-8 text-sm bg-card flex-1" />
                          )}
                        </div>
                      </div>

                      {/* Name */}
                      <div className="space-y-1">
                        <Label className="text-xs">League / Season Name</Label>
                        {newSeasonNameMode === 'select' && meta?.names && meta.names.length > 0 ? (
                          <Select value={newSeasonData.name} onValueChange={v => v === '__new__' ? setNewSeasonNameMode('new') : setNewSeasonData(d => ({ ...d, name: v }))}>
                            <SelectTrigger className="h-8 text-sm bg-card border-border text-foreground"><SelectValue placeholder="Select or create..." /></SelectTrigger>
                            <SelectContent>
                              {meta.names.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                              <SelectItem value="__new__"><span className="text-primary">+ New name</span></SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input placeholder="e.g. Spring, Fall..." value={newSeasonData.name} onChange={e => setNewSeasonData(d => ({ ...d, name: e.target.value }))} className="h-8 text-sm bg-card" />
                        )}
                      </div>

                      {/* Year */}
                      <div className="space-y-1">
                        <Label className="text-xs">Year</Label>
                        {newSeasonYearMode === 'select' && meta?.years && meta.years.length > 0 ? (
                          <Select value={String(newSeasonData.year)} onValueChange={v => v === '__new__' ? setNewSeasonYearMode('new') : setNewSeasonData(d => ({ ...d, year: v }))}>
                            <SelectTrigger className="h-8 text-sm bg-card border-border text-foreground"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {meta.years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                              <SelectItem value="__new__"><span className="text-primary">+ Other year</span></SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input type="number" placeholder={String(new Date().getFullYear())} value={newSeasonData.year} onChange={e => setNewSeasonData(d => ({ ...d, year: e.target.value }))} className="h-8 text-sm bg-card" />
                        )}
                      </div>

                      {/* Location */}
                      <div className="space-y-1">
                        <Label className="text-xs">Location (optional)</Label>
                        {newSeasonLocationMode === 'select' && meta?.locations && meta.locations.length > 0 ? (
                          <Select value={newSeasonData.location} onValueChange={v => v === '__new__' ? setNewSeasonLocationMode('new') : setNewSeasonData(d => ({ ...d, location: v }))}>
                            <SelectTrigger className="h-8 text-sm bg-card border-border text-foreground"><SelectValue placeholder="Select or add..." /></SelectTrigger>
                            <SelectContent>
                              {meta.locations.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                              <SelectItem value="__new__"><span className="text-primary">+ New location</span></SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input placeholder="Field / city" value={newSeasonData.location} onChange={e => setNewSeasonData(d => ({ ...d, location: e.target.value }))} className="h-8 text-sm bg-card" />
                        )}
                      </div>

                      {/* Default start time */}
                      <div className="space-y-1">
                        <Label className="text-xs">Default Game Start Time (optional)</Label>
                        <Input type="time" value={newSeasonData.default_game_time} onChange={e => setNewSeasonData(d => ({ ...d, default_game_time: e.target.value }))} className="h-8 text-sm bg-card" />
                      </div>

                      <Button type="button" size="sm" disabled={!newSeasonData.name || !newSeasonData.year || creatingSeasonLoading} onClick={handleCreateNewSeason} className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                        {creatingSeasonLoading ? 'Creating…' : 'Create Season'}
                      </Button>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="game_date">Date</Label>
                    <Input id="game_date" type="date" value={formData.game_date} onChange={e => setFormData({ ...formData, game_date: e.target.value })} required className="bg-background text-foreground" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="game_time">Time</Label>
                    <Input id="game_time" type="time" value={formData.game_time} onChange={e => setFormData({ ...formData, game_time: e.target.value })} required className="bg-background text-foreground" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Game Type</Label>
                  <Select value={formData.game_type} onValueChange={value => setFormData({ ...formData, game_type: value })}>
                    <SelectTrigger className="bg-background text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['Regular', 'Playoff', 'Tournament', 'Friendly'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" className="w-full bg-primary text-primary-foreground hover:bg-primary/90">Create Game</Button>
              </form>
            </DialogContent>
          </Dialog>
          )}
        </div>
      </div>

      {/* Season filter */}
      <SeasonMultiSelect
        seasons={(seasons as Season[] | undefined) ?? []}
        selectedIds={scheduleSeasonIds}
        onChange={setScheduleSeasonIds}
        placeholder="All Seasons"
      />

      {/* Calendar sync: anything the automatic daily sync from a
          calendar_sources feed couldn't confidently auto-create lands here
          for manual review. */}
      {allowed && jamConflicts && jamConflicts.length > 0 && (
        <Card className="bg-card border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Calendar Sync — {jamConflicts.length} {jamConflicts.length === 1 ? 'game needs' : 'games need'} review
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {jamConflicts.map(conflict => {
              const needsSeasonChoice = conflict.reason === 'no_season_match' || conflict.reason === 'multiple_season_match'
              return (
                <div key={conflict.id} className="border border-border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground text-sm truncate">{conflict.organizer} · vs {conflict.opponent}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(conflict.event_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at {conflict.event_time.slice(0, 5)}
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground text-right shrink-0">{jamConflictReasonLabel(conflict.reason)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {needsSeasonChoice && (
                      <Select value={jamCreateSeasonChoice[conflict.id] ?? ''} onValueChange={v => setJamCreateSeasonChoice(prev => ({ ...prev, [conflict.id]: v }))}>
                        <SelectTrigger className="h-8 text-xs w-40 bg-background border-border"><SelectValue placeholder="Choose season" /></SelectTrigger>
                        <SelectContent>
                          {(seasons as Season[] | undefined)?.filter(s => s.organizer === conflict.organizer).map(s => <SelectItem key={s.id} value={String(s.id)}>{seasonLabel(s)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      size="sm" variant="outline" className="h-8 text-xs"
                      disabled={needsSeasonChoice && !jamCreateSeasonChoice[conflict.id]}
                      onClick={() => handleCreateGameFromConflict(conflict)}
                    >
                      Create as new game
                    </Button>
                    {conflict.existing_game_id && (
                      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => handleLinkJamConflict(conflict)}>
                        Link to existing game
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" onClick={() => handleDismissJamConflict(conflict.id)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Calendar View */}
      {viewMode === 'calendar' ? (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <button onClick={() => setCalendarDate(new Date(calYear, calMonth - 1, 1))} className="p-1.5 rounded hover:bg-accent">
                <ChevronLeft className="w-4 h-4 text-muted-foreground" />
              </button>
              <CardTitle className="text-base">
                {calendarDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </CardTitle>
              <button onClick={() => setCalendarDate(new Date(calYear, calMonth + 1, 1))} className="p-1.5 rounded hover:bg-accent">
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="grid grid-cols-7 mb-1">
              {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
                <div key={d} className="text-center text-xs text-muted-foreground font-medium py-1">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-px">
              {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1
                const dayGames = gamesByDay[day] ?? []
                const today = new Date()
                const isToday = today.getFullYear() === calYear && today.getMonth() === calMonth && today.getDate() === day
                return (
                  <div key={day} className={`min-h-[52px] p-1 rounded border ${isToday ? 'border-primary/40 bg-primary/5' : 'border-transparent'}`}>
                    <div className={`text-xs font-medium mb-0.5 ${isToday ? 'text-primary' : 'text-foreground'}`}>{day}</div>
                    {dayGames.map(g => (
                      <button key={g.id} onClick={() => handleSelectGame(g)}
                        className={`w-full text-left text-[10px] px-1 py-0.5 rounded mb-0.5 truncate ${
                          g.result?.startsWith('Win') || g.outcome_override === 'Win' || g.outcome_override === 'Default Win'
                            ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
                            : g.result?.startsWith('Loss') || g.outcome_override === 'Loss' || g.outcome_override === 'Default Loss'
                            ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
                            : 'bg-primary/10 text-primary'
                        }`}>
                        vs {g.opponent}
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ) : (
        /* List View */
        <div className="space-y-2">
          {gamesLoading ? (
            /* Skeleton placeholders shaped like the real game cards below, so the
               list keeps its footprint while data loads instead of popping in. */
            Array.from({ length: 5 }).map((_, i) => (
              <Card key={`skeleton-${i}`} className="bg-card text-card-foreground border-border">
                <CardContent className="py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-40" />
                      <Skeleton className="h-4 w-32" />
                    </div>
                    <Skeleton className="h-6 w-14" />
                  </div>
                </CardContent>
              </Card>
            ))
          ) : sortedGames.length === 0 ? (
            <Card className="bg-card text-card-foreground border-border">
              <CardContent className="py-12 text-center">
                <Calendar className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-50" />
                <p className="text-muted-foreground">No games found</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {upcomingGames.length > 0 && (
                <>
                  <button
                    onClick={() => setShowUpcoming(v => !v)}
                    className="w-full flex items-center justify-between px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <span>Upcoming ({upcomingGames.length})</span>
                    {showUpcoming ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  {showUpcoming && upcomingGames.map((game, index) => renderGameCard(game, index, index === 0, false))}
                </>
              )}
              {pastGames.length > 0 && (
                <>
                  <button
                    onClick={() => setShowPlayed(v => !v)}
                    className="w-full flex items-center justify-between px-1 py-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <span>Played ({pastGames.length})</span>
                    {showPlayed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  {showPlayed && pastGames.map((game, index) => renderGameCard(game, upcomingGames.length + index, false, true))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Delete confirm (from list) */}
      <Dialog open={deleteConfirmId !== null && !selectedGame} onOpenChange={open => !open && setDeleteConfirmId(null)}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader><DialogTitle>Delete Game</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently delete the game and all its events.</p>
          <div className="flex gap-3 mt-2">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)} className="flex-1">Cancel</Button>
            <Button onClick={() => deleteConfirmId && handleDeleteGame(deleteConfirmId)} className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete Game</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
