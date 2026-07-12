import { useEffect, useState, useRef } from 'react'
import { useGetGames, useCreateGame, useUpdateGame, useDeleteGame, useGetLineups, useAddToLineup, useRemoveFromLineup, useUpdateLineupSortOrder, useUpdateLineupRole, useGetLineupGroups, useCreateLineupGroup, useRenameLineupGroup, useReorderLineupGroups, useDeleteLineupGroup, type LineupGroup } from '../hooks/backend/games'
import { useGetGameEvents, useCreateGoalEvent, useCreateOpponentGoalEvent, useDeleteEvent, useUpdateEvent, useGetEventTypes } from '../hooks/backend/events'
import { useGetSeasonRoster, useGetPlayersNotInSeason, useCreatePlayerForGame, useDeleteSubPlayer, useAddPlayerToGame } from '../hooks/backend/players'
import { useGetAllSeasons, useGetSeasons, useCreateSeason, useGetSeasonsMeta, useGetPlayerStats } from '../hooks/backend/stats'
import { useGetGameAttendance, useSetAttendance, useSetAllAttendance } from '../hooks/backend/attendance'
import { useGetJamSyncConflicts, useSyncJamNow, useCreateGameFromConflict, useLinkConflictToGame, useDismissConflict, type JamSyncConflict } from '../hooks/backend/jamSync'
import { useGetLeagueTeams } from '../hooks/backend/league'
import { getDefaultJamSeasonId } from '../lib/seasonUtils'
import { POSITIONS } from '../lib/positions'
import { isTurnoverEvent } from '../lib/eventUtils'
import { sortGamesUpcomingFirst, isPastGame } from '../lib/gameOrder'
import { todayLocalStr } from '../lib/seasonUtils'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Badge } from '../lib/shadcn/badge'
import { Popover, PopoverContent, PopoverTrigger } from '../lib/shadcn/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../lib/shadcn/command'
import PlayerCombobox from '../components/PlayerCombobox'
import PlayerAvatar from '../components/PlayerAvatar'
import GenderTag, { GenderRatio } from '../components/GenderTag'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import { useAuth } from '../contexts/AuthContext'
import { Calendar, Plus, Minus, Trophy, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Target, TrendingUp, PlusCircle, Trash2, Edit2, Save, X, Users, LayoutList, CalendarDays, StickyNote, ClipboardCheck, AlertTriangle, RefreshCw, ArrowLeftRight, Undo2, Check, ChevronsUpDown, GripVertical } from 'lucide-react'

// A game counts as "imminent" from 30 minutes before its start time to 30
// minutes after, the window where you're about to score it or already are.
const IMMINENT_WINDOW_MS = 30 * 60 * 1000

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
type Player = { id: number; display_name: string; position: string | null; gender_match: string | null; is_sub: boolean | null; photo_url: string | null }
type Season = { id: number; name: string; year: number; organizer: string | null; default_game_time: string | null; start_date: string | null; end_date: string | null }
type SeasonMeta = { organizers: string[]; names: string[]; years: number[]; locations: string[] }
type LineupEntry = { id: number; player_id: number; lineup_name: string; sort_order: number; role: string | null; display_name: string; position: string | null; gender_match: string | null; photo_url: string | null }

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

// A game counts as "upcoming" until its actual start time passes, not just
// its calendar date, so a game later today still shows as upcoming.
function gameStartsAt(g: { game_date: string; game_time: string | null }): Date {
  return new Date(`${g.game_date}T${g.game_time || '00:00:00'}`)
}

function dateBadgeParts(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00')
  return {
    month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: d.getDate(),
  }
}

function formatWeekday(dateStr: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' })
}

const OUTCOME_OPTIONS = ['Win', 'Loss', 'Tie', 'Default Win', 'Default Loss', 'Forfeit']

export default function Schedule() {
  const { allowed } = useAuth()
  const { data: games, loading, error, trigger: fetchGames } = useGetGames()
  const { data: events, loading: eventsLoading, trigger: fetchEvents } = useGetGameEvents()
  const { data: players, trigger: fetchPlayers } = useGetSeasonRoster()
  const { data: otherPlayers, trigger: fetchOtherPlayers } = useGetPlayersNotInSeason()
  const { trigger: createPlayerForGame } = useCreatePlayerForGame()
  const { trigger: deleteSubPlayer } = useDeleteSubPlayer()
  const { trigger: addPlayerToGame } = useAddPlayerToGame()
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
  const { trigger: updateLineupSortOrder } = useUpdateLineupSortOrder()
  const { trigger: updateLineupRole } = useUpdateLineupRole()
  const { data: lineupGroups, trigger: fetchLineupGroups } = useGetLineupGroups()
  const { trigger: createLineupGroup } = useCreateLineupGroup()
  const { trigger: renameLineupGroup } = useRenameLineupGroup()
  const { trigger: reorderLineupGroups } = useReorderLineupGroups()
  const { trigger: deleteLineupGroup } = useDeleteLineupGroup()
  const { data: lineupSeasonStats, trigger: fetchLineupSeasonStats } = useGetPlayerStats()
  const { trigger: createGoal } = useCreateGoalEvent()
  const { trigger: createOpponentGoal } = useCreateOpponentGoalEvent()
  const { trigger: deleteEvent } = useDeleteEvent()
  const { trigger: updateEvent } = useUpdateEvent()
  const { data: eventTypes, trigger: fetchEventTypes } = useGetEventTypes()
  const { data: leagueTeams, trigger: fetchLeagueTeams } = useGetLeagueTeams()

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

  // Add event. Scorer/assister persist across successive adds (rather than
  // clearing after each one) so scoring several points in a row for the same
  // player doesn't require re-picking them every time.
  const [showAddEvent, setShowAddEvent] = useState(false)
  const [newEventType, setNewEventType] = useState<string>('Goal')
  const [newScorerId, setNewScorerId] = useState<string>('')
  const [newAssisterId, setNewAssisterId] = useState<string>('')
  const [showAttendance, setShowAttendance] = useState(false)
  const autoOpenedRef = useRef(false)

  // Game notes editing
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')

  // Outcome override
  const [editingOutcome, setEditingOutcome] = useState(false)
  const [outcomeValue, setOutcomeValue] = useState<string>('')

  // Lineup
  const [lineupName, setLineupName] = useState('Lineup 1')
  const [lineupSelectedIds, setLineupSelectedIds] = useState<Set<number>>(new Set())
  const [lineupPopoverOpen, setLineupPopoverOpen] = useState(false)
  const [addingLineupName, setAddingLineupName] = useState(false)
  const [newLineupNameInput, setNewLineupNameInput] = useState('')
  // Drag-to-reorder a lineup group. dragLineupGroup identifies which group
  // is being dragged (a player id is only unique within a group, since the
  // same player can appear in multiple lineups); dragLineupOrder mirrors
  // that group's entries in their live in-progress order.
  const [dragLineupEntryId, setDragLineupEntryId] = useState<number | null>(null)
  const [dragLineupGroup, setDragLineupGroup] = useState<string | null>(null)
  const [dragLineupOrder, setDragLineupOrder] = useState<LineupEntry[] | null>(null)
  const [dragLineupOffsetY, setDragLineupOffsetY] = useState(0)
  const lineupDragRef = useRef<{ pointerId: number; startY: number; rowHeight: number; originalIndex: number; order: LineupEntry[] } | null>(null)
  // Drag-to-reorder the lineup GROUPS themselves (e.g. move "Handlers" above
  // "Lineup 2"), separate from reordering players within one group above.
  const [dragGroupId, setDragGroupId] = useState<number | null>(null)
  const [dragGroupOrder, setDragGroupOrder] = useState<LineupGroup[] | null>(null)
  const [dragGroupOffsetY, setDragGroupOffsetY] = useState(0)
  const groupDragRef = useRef<{ pointerId: number; startY: number; rowHeight: number; originalIndex: number; order: LineupGroup[] } | null>(null)
  const [deleteGroupConfirm, setDeleteGroupConfirm] = useState<LineupGroup | null>(null)
  // Inline-editing a lineup group's name.
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null)
  const [editingGroupNameValue, setEditingGroupNameValue] = useState('')

  useEffect(() => {
    // fetchGames happens in the scheduleSeasonIds effect below (fires on mount too).
    // Player roster fetches happen in handleSelectGame, scoped to that game's season.
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

  // Keep the "Add Players" target valid against the loaded groups: if the
  // currently selected name was just deleted (or hasn't loaded yet), fall
  // back to the first group rather than pointing at a group that no longer
  // exists.
  useEffect(() => {
    const groups = (lineupGroups as LineupGroup[] | undefined) ?? []
    if (groups.length > 0 && !groups.some(g => g.lineup_name === lineupName)) {
      setLineupName(groups[0]!.lineup_name)
    }
  }, [lineupGroups])

  // If a game is imminent (starting within 30 minutes, or already underway
  // and less than 30 minutes in), jump straight into it ready to score
  // instead of making you find it in the list. Only does this once per page
  // load so navigating back to the list afterward doesn't re-trigger it.
  useEffect(() => {
    if (autoOpenedRef.current || selectedGame) return
    const g = (games as Game[] | undefined) ?? []
    if (g.length === 0) return
    const now = Date.now()
    const imminent = g.find(gm => Math.abs(gameStartsAt(gm).getTime() - now) <= IMMINENT_WINDOW_MS)
    if (imminent) {
      autoOpenedRef.current = true
      handleSelectGame(imminent, { openForScoring: true })
    }
  }, [games])

  // A game with no game_lineup_groups rows yet (never visited under this
  // schema) gets the two defaults seeded so the group list/ordering always
  // has something to show and reorder, rather than starting empty.
  const ensureLineupGroups = async (gameId: number) => {
    const groups = await fetchLineupGroups({ gameId })
    if (groups && groups.length === 0) {
      await Promise.all([
        createLineupGroup({ gameId, lineupName: 'Lineup 1', sortOrder: 0 }),
        createLineupGroup({ gameId, lineupName: 'Lineup 2', sortOrder: 1 }),
      ])
      fetchLineupGroups({ gameId })
    }
  }

  const handleSelectGame = (game: Game, opts?: { openForScoring?: boolean }) => {
    setSelectedGame(game)
    fetchEvents({ gameId: game.id })
    fetchLineups({ gameId: game.id })
    ensureLineupGroups(game.id)
    fetchAttendance({ gameId: game.id })
    if (game.season_id) {
      fetchPlayers({ seasonId: game.season_id })
      fetchOtherPlayers({ seasonId: game.season_id })
      fetchLineupSeasonStats({ seasonIds: [game.season_id] })
    } else {
      fetchOtherPlayers({})
    }
    setActiveTab('events')
    setEditingNotes(false)
    setEditingOutcome(false)
    setNotesValue(game.notes ?? '')
    setOutcomeValue(game.outcome_override ?? '')
    // A game opened because its start time is imminent (see the auto-select
    // effect below) starts ready to score; one opened by browsing the list
    // starts collapsed so glancing at past events doesn't require a scroll.
    setShowAddEvent(!!opts?.openForScoring)
    setNewEventType('Goal')
    setNewScorerId('')
    setNewAssisterId('')
    setLineupSelectedIds(new Set())
    setAddingLineupName(false)
    setNewLineupNameInput('')
  }

  // Season roster refetch needs the game's season id, not the game id.
  const selectedGameSeasonId = selectedGame?.season_id ?? null
  const refreshRoster = async () => {
    if (selectedGameSeasonId) {
      await fetchPlayers({ seasonId: selectedGameSeasonId })
      await fetchOtherPlayers({ seasonId: selectedGameSeasonId })
    } else {
      await fetchOtherPlayers({})
    }
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

  // Known league teams for the selected season feed the opponent field's
  // suggestions, so repeat opponents keep one consistent spelling (the DB
  // trigger resolves the text to a league_teams row on save).
  useEffect(() => {
    const id = parseInt(formData.season_id)
    if (!isNaN(id)) fetchLeagueTeams({ seasonId: id })
  }, [formData.season_id])

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
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleAddOpponentGoal = async () => {
    if (!selectedGame) return
    await createOpponentGoal({ gameId: selectedGame.id })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleUndo = async () => {
    const gameEvents = events as GameEvent[] | undefined
    if (!selectedGame || !gameEvents || gameEvents.length === 0) return
    await deleteEvent({ eventId: gameEvents[0]!.id })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleAddPlayer = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId })
    if (result) {
      await refreshRoster()
      setNewScorerId((result as { id: number }).id.toString())
    }
  }

  const handleAddAssister = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId })
    if (result) {
      await refreshRoster()
      setNewAssisterId((result as { id: number }).id.toString())
    }
  }

  const handleAddExistingScorer = async (playerId: string) => {
    if (!selectedGame) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedGame.id, seasonId: selectedGameSeasonId })
    await refreshRoster()
    setNewScorerId(playerId)
  }

  const handleAddExistingAssister = async (playerId: string) => {
    if (!selectedGame) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedGame.id, seasonId: selectedGameSeasonId })
    await refreshRoster()
    setNewAssisterId(playerId)
  }

  const handleDeleteSub = async (playerId: string) => {
    if (!selectedGame) return
    await deleteSubPlayer({ playerId: parseInt(playerId), gameId: selectedGame.id, seasonId: selectedGameSeasonId })
    await refreshRoster()
    if (newScorerId === playerId) setNewScorerId('')
    if (newAssisterId === playerId) setNewAssisterId('')
    if (editScorerId === playerId) setEditScorerId('')
    if (editAssisterId === playerId) setEditAssisterId('')
  }

  const handleAddPlayerToAttendance = async (name: string) => {
    if (!selectedGame) return
    await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId })
    await refreshRoster()
    fetchAttendance({ gameId: selectedGame.id })
  }

  const handleAddExistingPlayerToAttendance = async (playerId: string) => {
    if (!selectedGame) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedGame.id, seasonId: selectedGameSeasonId })
    await refreshRoster()
    fetchAttendance({ gameId: selectedGame.id })
  }

  const handleAddToLineup = async () => {
    if (!selectedGame || lineupSelectedIds.size === 0) return
    const currentGroupEntries = ((lineups as LineupEntry[] | undefined) ?? []).filter(e => e.lineup_name === lineupName)
    const nextSortOrder = currentGroupEntries.reduce((max, e) => Math.max(max, e.sort_order), -1) + 1
    await Promise.all([...lineupSelectedIds].map((playerId, i) =>
      addToLineup({ gameId: selectedGame.id, player_id: playerId, lineup_name: lineupName, seasonId: selectedGame.season_id, sortOrder: nextSortOrder + i })
    ))
    setLineupSelectedIds(new Set())
    fetchLineups({ gameId: selectedGame.id })
  }

  const handleUpdateLineupRole = async (entryId: number, role: string) => {
    await updateLineupRole({ id: entryId, role: role.trim() || null })
    if (selectedGame) fetchLineups({ gameId: selectedGame.id })
  }

  // Creating a lineup group both persists it (so it appears as its own
  // card immediately, even with zero players) and makes it the active
  // target for "Add Players".
  const handleAddLineupGroup = async (name: string) => {
    if (!selectedGame || !name.trim()) return
    const groups = (lineupGroups as LineupGroup[] | undefined) ?? []
    const nextSortOrder = groups.reduce((max, g) => Math.max(max, g.sort_order), -1) + 1
    await createLineupGroup({ gameId: selectedGame.id, lineupName: name.trim(), sortOrder: nextSortOrder })
    setLineupName(name.trim())
    setLineupSelectedIds(new Set())
    setAddingLineupName(false)
    fetchLineupGroups({ gameId: selectedGame.id })
  }

  const handleDeleteLineupGroup = async (group: LineupGroup) => {
    if (!selectedGame) return
    await deleteLineupGroup({ gameId: selectedGame.id, lineupName: group.lineup_name, groupId: group.id })
    fetchLineupGroups({ gameId: selectedGame.id })
    fetchLineups({ gameId: selectedGame.id })
  }

  const handleRenameLineupGroup = async (group: LineupGroup, newName: string, existingNames: string[]) => {
    const trimmed = newName.trim()
    setEditingGroupId(null)
    if (!selectedGame || !trimmed || trimmed === group.lineup_name || existingNames.includes(trimmed)) return
    await renameLineupGroup({ gameId: selectedGame.id, groupId: group.id, oldName: group.lineup_name, newName: trimmed })
    if (lineupName === group.lineup_name) setLineupName(trimmed)
    fetchLineupGroups({ gameId: selectedGame.id })
    fetchLineups({ gameId: selectedGame.id })
  }

  const toggleLineupSelected = (playerId: number) => {
    setLineupSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(playerId)) next.delete(playerId)
      else next.add(playerId)
      return next
    })
  }

  const handleRemoveFromLineup = async (playerId: number, lineupGroup: string) => {
    if (!selectedGame) return
    await removeFromLineup({ gameId: selectedGame.id, playerId, lineup_name: lineupGroup })
    fetchLineups({ gameId: selectedGame.id })
  }

  // Drag a lineup row to reorder players within their group. Mirrors the
  // Recent Activity event-drag pattern (window pointer listeners, splice the
  // working order on each crossed threshold), but reassigns the group's
  // sort_order values instead of timestamps since game_lineups has an
  // explicit ordering column.
  const handleLineupDragStart = (group: string, list: LineupEntry[], entry: LineupEntry, rowEl: HTMLElement, e: React.PointerEvent) => {
    if (!allowed) return
    e.preventDefault()
    e.stopPropagation()
    const pointerId = e.pointerId
    const originalIndex = list.findIndex(en => en.id === entry.id)
    if (originalIndex === -1) return
    const rowHeight = rowEl.getBoundingClientRect().height
    const drag = { pointerId, startY: e.clientY, rowHeight, originalIndex, order: [...list] }
    lineupDragRef.current = drag
    setDragLineupEntryId(entry.id)
    setDragLineupGroup(group)
    setDragLineupOffsetY(0)
    setDragLineupOrder(drag.order)

    const onMove = (ev: PointerEvent) => {
      const d = lineupDragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      const rawDelta = ev.clientY - d.startY
      const targetIndex = Math.min(d.order.length - 1, Math.max(0, d.originalIndex + Math.round(rawDelta / d.rowHeight)))
      const currentIndex = d.order.findIndex(en => en.id === entry.id)
      if (targetIndex !== currentIndex) {
        const next = [...d.order]
        const [moved] = next.splice(currentIndex, 1)
        next.splice(targetIndex, 0, moved)
        d.order = next
        setDragLineupOrder(next)
      }
      setDragLineupOffsetY(rawDelta - (targetIndex - d.originalIndex) * d.rowHeight)
    }
    const onUp = async (ev: PointerEvent) => {
      const d = lineupDragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      teardown()
      lineupDragRef.current = null
      setDragLineupEntryId(null)
      setDragLineupGroup(null)
      setDragLineupOrder(null)
      setDragLineupOffsetY(0)
      const originalSortOrders = list.map(en => en.sort_order)
      const changes = d.order
        .map((en, i) => ({ id: en.id, sortOrder: originalSortOrders[i]! }))
        .filter(c => list.find(en => en.id === c.id)?.sort_order !== c.sortOrder)
      if (changes.length > 0 && selectedGame) {
        await Promise.all(changes.map(c => updateLineupSortOrder({ id: c.id, sortOrder: c.sortOrder })))
        fetchLineups({ gameId: selectedGame.id })
      }
    }
    const onCancel = (ev: PointerEvent) => {
      if (lineupDragRef.current?.pointerId !== ev.pointerId) return
      teardown()
      lineupDragRef.current = null
      setDragLineupEntryId(null)
      setDragLineupGroup(null)
      setDragLineupOrder(null)
      setDragLineupOffsetY(0)
    }
    const teardown = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  // Drag a lineup group's header to reorder the groups themselves. Same
  // pattern as handleLineupDragStart above, but reassigns
  // game_lineup_groups.sort_order instead of game_lineups.sort_order.
  const handleGroupDragStart = (list: LineupGroup[], group: LineupGroup, rowEl: HTMLElement, e: React.PointerEvent) => {
    if (!allowed) return
    e.preventDefault()
    e.stopPropagation()
    const pointerId = e.pointerId
    const originalIndex = list.findIndex(g => g.id === group.id)
    if (originalIndex === -1) return
    const rowHeight = rowEl.getBoundingClientRect().height
    const drag = { pointerId, startY: e.clientY, rowHeight, originalIndex, order: [...list] }
    groupDragRef.current = drag
    setDragGroupId(group.id)
    setDragGroupOffsetY(0)
    setDragGroupOrder(drag.order)

    const onMove = (ev: PointerEvent) => {
      const d = groupDragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      const rawDelta = ev.clientY - d.startY
      const targetIndex = Math.min(d.order.length - 1, Math.max(0, d.originalIndex + Math.round(rawDelta / d.rowHeight)))
      const currentIndex = d.order.findIndex(g => g.id === group.id)
      if (targetIndex !== currentIndex) {
        const next = [...d.order]
        const [moved] = next.splice(currentIndex, 1)
        next.splice(targetIndex, 0, moved)
        d.order = next
        setDragGroupOrder(next)
      }
      setDragGroupOffsetY(rawDelta - (targetIndex - d.originalIndex) * d.rowHeight)
    }
    const onUp = async (ev: PointerEvent) => {
      const d = groupDragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      teardown()
      groupDragRef.current = null
      setDragGroupId(null)
      setDragGroupOrder(null)
      setDragGroupOffsetY(0)
      const originalSortOrders = list.map(g => g.sort_order)
      const changes = d.order
        .map((g, i) => ({ id: g.id, sortOrder: originalSortOrders[i]! }))
        .filter(c => list.find(g => g.id === c.id)?.sort_order !== c.sortOrder)
      if (changes.length > 0 && selectedGame) {
        await reorderLineupGroups({ updates: changes })
        fetchLineupGroups({ gameId: selectedGame.id })
      }
    }
    const onCancel = (ev: PointerEvent) => {
      if (groupDragRef.current?.pointerId !== ev.pointerId) return
      teardown()
      groupDragRef.current = null
      setDragGroupId(null)
      setDragGroupOrder(null)
      setDragGroupOffsetY(0)
    }
    const teardown = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
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

  const playerOptions = ((players as Player[] | undefined) ?? []).map(p => ({ id: p.id.toString(), label: p.display_name, isSub: !!p.is_sub }))
  const newEventPlayerOptions = [{ id: '__opponent__', label: 'Opponent' }, ...playerOptions]
  const isNewEventGoalLike = ['Goal', 'Caught OB'].includes(newEventType)

  // Scorer/assister quick-select should only offer players marked present for
  // this game. A missing row defaults to "attending" for a full roster
  // player (their row may just not exist yet), but NOT for a sub: a sub's
  // game_attendance row is only ever created when they're explicitly added
  // to a specific game (see useCreatePlayerForGame/useAddPlayerToGame), so
  // no row for a sub means they were never part of this game, not that
  // they're attending by default. The Edit Event dialog still uses the full
  // roster so past events referencing a player who's since been marked
  // absent stay editable.
  const attendingPlayerIds = new Set(
    ((players as Player[] | undefined) ?? [])
      .filter(p => {
        const row = (attendanceRows as { player_id: number; in: boolean }[] | undefined)?.find(r => r.player_id === p.id)
        return row ? row.in : !p.is_sub
      })
      .map(p => p.id)
  )
  const attendingPlayerOptions = [
    { id: '__opponent__', label: 'Opponent' },
    ...playerOptions.filter(p => attendingPlayerIds.has(parseInt(p.id))),
  ]

  const otherPlayerOptions = ((otherPlayers as { id: number; display_name: string }[] | undefined) ?? [])
    .map(p => ({ id: p.id.toString(), label: p.display_name }))

  // The Attendance tab's "Add player" box only offers otherPlayerOptions
  // (players outside this season), since season roster members normally
  // already have a game_attendance row from the game-creation backfill
  // trigger and appear in the checkbox list below instead. But a player
  // who joined the season mid-stream (added via a different game in the
  // same season) only gets a game_attendance row for that one game, not
  // retroactively for this game — without this, they'd be invisible in
  // both lists here (already a season member, so excluded from
  // otherPlayerOptions; no row, so absent from the checkbox list).
  const seasonMembersMissingAttendance = ((players as Player[] | undefined) ?? [])
    .filter(p => !((attendanceRows as { player_id: number }[] | undefined)?.some(r => r.player_id === p.id)))
    .map(p => ({ id: p.id.toString(), label: p.display_name }))
  const attendanceOtherPlayerOptions = [...seasonMembersMissingAttendance, ...otherPlayerOptions]
    .sort((a, b) => a.label.localeCompare(b.label))

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
    // Lineup groups (name + display order) are their own table now, not
    // inferred from game_lineups: a group exists, is orderable, and is
    // deletable independent of whether it currently has any players in it.
    const groups = ((lineupGroups as LineupGroup[] | undefined) ?? [])
    const orderedGroups = dragGroupOrder ?? groups
    const lineupNames = groups.map(g => g.lineup_name)

    // This season's per-player goals/assists (scoped to the selected game's
    // season, fetched in handleSelectGame), used to help pick balanced
    // lineups and to total each lineup's combined production.
    const seasonStatsByPlayerId = new Map<number, { goals: number; assists: number }>()
    ;((lineupSeasonStats as { player_id: number; goals: number; assists: number }[] | undefined) ?? [])
      .forEach(s => seasonStatsByPlayerId.set(s.player_id, { goals: s.goals, assists: s.assists }))
    const currentLineupPlayerIds = new Set(
      lineupEntries.filter(e => e.lineup_name === lineupName).map(e => e.player_id)
    )
    // Only offer players actually attending this game (same convention as
    // the Scorer/Assister picker's attendingPlayerIds): a lineup is a plan
    // for who's on the field, so someone marked absent shouldn't be
    // selectable even though they're still on the season roster.
    const lineupCandidates = ((players as Player[] | undefined) ?? [])
      .filter(p => !currentLineupPlayerIds.has(p.id) && attendingPlayerIds.has(p.id))

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
        <FadeIn>
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-5">
            <div className="text-center">
              <div className="text-lg font-bold text-foreground leading-snug break-words">vs {selectedGame.opponent}</div>
              <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground mt-1">
                <Calendar className="w-3 h-3 flex-shrink-0" />
                <span>
                  {formatDate(selectedGame.game_date)} · {formatTime(selectedGame.game_time)}
                  {selectedGame.season_id && getSeasonLabel(selectedGame.season_id) ? ` · ${getSeasonLabel(selectedGame.season_id)}` : ''}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-center gap-3 mt-4">
              <div className="text-center">
                <div className="text-8xl sm:text-[10rem] font-bold text-primary tabular-nums leading-none">{ourGoals}</div>
                <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground mt-2">Us</div>
              </div>
              <div className="text-5xl sm:text-6xl font-light text-muted-foreground/50">-</div>
              <div className="text-center">
                <div className="text-8xl sm:text-[10rem] font-bold text-muted-foreground tabular-nums leading-none">{theirGoals}</div>
                <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground mt-2">Them</div>
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
        </FadeIn>

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
                <div className="grid grid-cols-[60px_1fr] items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground text-right">Event</span>
                  <Select value={newEventType} onValueChange={setNewEventType}>
                    <SelectTrigger className="h-9 text-sm bg-background text-foreground border-border"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(eventTypes as { id: number; name: string }[] | undefined)?.map(et => (
                        <SelectItem key={et.id} value={et.name}>{et.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-[60px_1fr] items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground text-right">{isNewEventGoalLike ? 'Scorer' : 'Player'}</span>
                  <PlayerCombobox
                    players={attendingPlayerOptions}
                    otherPlayers={otherPlayerOptions}
                    value={newScorerId || '__none__'}
                    onValueChange={setNewScorerId}
                    onAddPlayer={handleAddPlayer}
                    onAddExistingPlayer={handleAddExistingScorer}
                    onDeletePlayer={handleDeleteSub}
                    placeholder="None"
                    className="w-full h-9 text-sm bg-background border-border"
                  />
                </div>

                {isNewEventGoalLike && newScorerId !== '__opponent__' && (
                  <>
                    <div className="flex items-center justify-center">
                      <button
                        onClick={() => { const tmp = newScorerId; setNewScorerId(newAssisterId); setNewAssisterId(tmp) }}
                        title="Swap Scorer ↔ Assister"
                        aria-label="Swap scorer and assister"
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded hover:bg-accent"
                      >
                        <ArrowLeftRight className="w-3 h-3" />
                        <span>swap</span>
                      </button>
                    </div>
                    <div className="grid grid-cols-[60px_1fr] items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground text-right">Assister</span>
                      <PlayerCombobox
                        players={attendingPlayerOptions}
                        otherPlayers={otherPlayerOptions}
                        value={newAssisterId || '__none__'}
                        onValueChange={setNewAssisterId}
                        onAddPlayer={handleAddAssister}
                        onAddExistingPlayer={handleAddExistingAssister}
                        onDeletePlayer={handleDeleteSub}
                        placeholder="None"
                        className="w-full h-9 text-sm bg-background border-border"
                      />
                    </div>
                  </>
                )}

                <div className="border-t border-border" />

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    onClick={handleAddEvent}
                    className="h-14 font-bold bg-green-600 hover:bg-green-700 text-white dark:bg-green-700 dark:hover:bg-green-600 flex flex-col items-center justify-center gap-0.5"
                  >
                    <div className="flex items-center gap-1">
                      <Plus className="w-4 h-4" />
                      <span className="text-sm">{newEventType}</span>
                    </div>
                    {newScorerId && newScorerId !== '__none__' && (
                      <span className="text-xs font-normal opacity-90 truncate max-w-full px-2">
                        {newEventPlayerOptions.find(p => p.id === newScorerId)?.label ?? 'Opponent'}
                      </span>
                    )}
                  </Button>

                  <Button
                    onClick={handleAddOpponentGoal}
                    className="h-14 font-bold bg-red-600 hover:bg-red-700 text-white dark:bg-red-700 dark:hover:bg-red-600 flex flex-col items-center justify-center gap-0.5"
                  >
                    <div className="flex items-center gap-1">
                      <Minus className="w-4 h-4" />
                      <span className="text-sm">They Score</span>
                    </div>
                  </Button>
                </div>

                <Button
                  onClick={handleUndo}
                  disabled={!events || (events as GameEvent[]).length === 0}
                  variant="outline"
                  className="w-full h-8 text-xs font-medium text-muted-foreground hover:text-foreground flex items-center justify-center gap-1.5 disabled:opacity-40"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  Undo last event
                </Button>
              </CardContent>
            )}
          </Card>
        )}

        {/* Recent Activity */}
        {activeTab === 'events' && (
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span>Recent Activity</span>
                <span className="text-sm font-normal text-muted-foreground">{gameEvents.length} events</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {eventsLoading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Loading events...</div>
              ) : gameEvents.length ? (
                <div className="space-y-2">
                  {gameEvents.map((event, i) => {
                    const scorer = getPlayerName(event.player_id)
                    const assister = getPlayerName(event.related_player_id)
                    const isGoal = event.event_type === 'Goal'
                    const isOpponentGoal = event.event_type === 'Opponent Goal'
                    const isTurnover = isTurnoverEvent(event.event_type)
                    const isEditing = editingEventId === event.id

                    if (isEditing) {
                      return (
                        <div key={event.id} className="py-2.5 border-b border-border last:border-0">
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
                        </div>
                      )
                    }
                    return (
                      <FadeIn key={event.id} delay={i * 40} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${isGoal ? 'bg-green-100 dark:bg-green-950' : isOpponentGoal ? 'bg-red-100 dark:bg-red-950' : 'bg-orange-100 dark:bg-orange-950'}`}>
                          {isGoal && <Target className="w-5 h-5 text-green-600 dark:text-green-400" />}
                          {isOpponentGoal && <Target className="w-5 h-5 text-red-600 dark:text-red-400" />}
                          {isTurnover && <TrendingUp className="w-5 h-5 text-orange-600 dark:text-orange-400" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-foreground text-sm">
                            {isGoal && (<>{scorer ?? 'Our Goal'}{assister && <span className="text-xs text-muted-foreground ml-1">(from {assister})</span>}</>)}
                            {isOpponentGoal && 'Opponent Goal'}
                            {isTurnover && <>{scorer ?? 'Unknown'} turned it over</>}
                            {!isGoal && !isOpponentGoal && !isTurnover && event.event_type}
                          </div>
                          <div className="text-xs text-muted-foreground">{formatTimestamp(event.event_timestamp)}</div>
                        </div>
                        {allowed && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => handleEditEvent(event)} className="p-1.5 rounded hover:bg-accent transition-colors" aria-label="Edit event">
                              <Edit2 className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                            </button>
                            <button onClick={() => handleDeleteEvent(event.id)} className="p-1.5 rounded hover:bg-destructive/10 transition-colors" aria-label="Delete event">
                              <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                            </button>
                          </div>
                        )}
                        {(isGoal || isOpponentGoal) && (
                          <div className={`text-lg font-bold tabular-nums ml-1 ${isGoal ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>+1</div>
                        )}
                      </FadeIn>
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
                  <Label className="text-xs text-muted-foreground">Add Players</Label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Select value={lineupName} onValueChange={n => { setLineupName(n); setLineupSelectedIds(new Set()) }}>
                        <SelectTrigger className="h-8 text-sm bg-card border-border text-foreground"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {lineupNames.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => { setAddingLineupName(true); setNewLineupNameInput('') }}
                      className="h-8 bg-card border-border"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  {addingLineupName && (
                    <div className="flex gap-2">
                      <Input
                        autoFocus
                        value={newLineupNameInput}
                        onChange={e => setNewLineupNameInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleAddLineupGroup(newLineupNameInput)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setAddingLineupName(false)
                          }
                        }}
                        placeholder="New lineup name..."
                        className="h-8 text-sm bg-card border-border text-foreground"
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleAddLineupGroup(newLineupNameInput)}
                        disabled={!newLineupNameInput.trim()}
                        className="h-8 bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setAddingLineupName(false)} className="h-8 bg-card border-border">
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Popover open={lineupPopoverOpen} onOpenChange={setLineupPopoverOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            role="combobox"
                            aria-expanded={lineupPopoverOpen}
                            className="w-full h-8 justify-between font-normal text-sm bg-card border-border"
                          >
                            <span className="truncate">
                              {lineupSelectedIds.size > 0 ? `${lineupSelectedIds.size} selected` : 'Select players...'}
                            </span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[280px] p-0">
                          <Command>
                            <CommandInput placeholder="Search players..." />
                            <CommandList>
                              <CommandEmpty>No player found.</CommandEmpty>
                              <CommandGroup>
                                {lineupCandidates.map(p => {
                                  const s = seasonStatsByPlayerId.get(p.id)
                                  const selected = lineupSelectedIds.has(p.id)
                                  return (
                                    <CommandItem
                                      key={p.id}
                                      value={p.display_name}
                                      onSelect={() => toggleLineupSelected(p.id)}
                                      className="flex items-center justify-between"
                                    >
                                      <div className="flex items-center min-w-0 gap-1.5">
                                        <Check className={`mr-0.5 h-4 w-4 shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`} />
                                        <GenderTag value={p.gender_match} />
                                        <span className="truncate">{p.display_name}</span>
                                      </div>
                                      <span className="text-xs text-muted-foreground shrink-0 ml-2">
                                        {s ? s.goals : 0}G {s ? s.assists : 0}A
                                      </span>
                                    </CommandItem>
                                  )
                                })}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <Button size="sm" onClick={handleAddToLineup} disabled={lineupSelectedIds.size === 0} className="h-8 bg-primary text-primary-foreground hover:bg-primary/90">
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Lineup groups */}
              {orderedGroups.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <Users className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  No lineups set yet
                </div>
              ) : (
                orderedGroups.map(g => {
                  const entries = lineupByGroup[g.lineup_name] ?? []
                  const isGroupDragging = dragGroupId === g.id
                  const totals = entries.reduce((acc, e) => {
                    const s = seasonStatsByPlayerId.get(e.player_id)
                    acc.goals += s?.goals ?? 0
                    acc.assists += s?.assists ?? 0
                    return acc
                  }, { goals: 0, assists: 0 })
                  return (
                    <div
                      key={g.id}
                      data-lineup-group-row
                      style={isGroupDragging ? { transform: `translateY(${dragGroupOffsetY}px)`, position: 'relative', zIndex: 20 } : undefined}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {allowed && (
                          <button
                            onPointerDown={ev => handleGroupDragStart(groups, g, ev.currentTarget.closest('[data-lineup-group-row]') as HTMLElement, ev)}
                            className="p-1 -ml-1 shrink-0 cursor-grab active:cursor-grabbing touch-none"
                            aria-label={`Drag to reorder ${g.lineup_name}`}
                          >
                            <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                        )}
                        {editingGroupId === g.id ? (
                          <Input
                            autoFocus
                            value={editingGroupNameValue}
                            onChange={ev => setEditingGroupNameValue(ev.target.value)}
                            onBlur={() => handleRenameLineupGroup(g, editingGroupNameValue, lineupNames)}
                            onKeyDown={ev => {
                              if (ev.key === 'Enter') { ev.preventDefault(); handleRenameLineupGroup(g, editingGroupNameValue, lineupNames) }
                              else if (ev.key === 'Escape') { ev.preventDefault(); setEditingGroupId(null) }
                            }}
                            className="h-6 w-32 text-xs bg-card border-border text-foreground"
                          />
                        ) : (
                          <Badge variant="secondary" className="text-xs">{g.lineup_name}</Badge>
                        )}
                        {allowed && editingGroupId !== g.id && (
                          <button
                            onClick={() => { setEditingGroupId(g.id); setEditingGroupNameValue(g.lineup_name) }}
                            className="p-1 rounded hover:bg-accent"
                            aria-label={`Rename ${g.lineup_name}`}
                          >
                            <Edit2 className="w-3 h-3 text-muted-foreground" />
                          </button>
                        )}
                        <span className="text-xs text-muted-foreground">{entries.length} players</span>
                        <span className="text-xs text-muted-foreground">
                          &middot; {totals.goals}G {totals.assists}A this season
                        </span>
                        <GenderRatio entries={entries} className="ml-auto" />
                        {allowed && (
                          <button onClick={() => setDeleteGroupConfirm(g)} className="p-1 rounded hover:bg-destructive/10" aria-label={`Delete ${g.lineup_name}`}>
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        {(dragLineupGroup === g.lineup_name && dragLineupOrder ? dragLineupOrder : entries).map(e => {
                          const s = seasonStatsByPlayerId.get(e.player_id)
                          const isDragging = dragLineupEntryId === e.id
                          // The role dropdown defaults to the player's roster position
                          // (players.position) until this lineup sets its own override.
                          const effectiveRole = e.role ?? e.position ?? null
                          return (
                            <div
                              key={e.id}
                              data-lineup-row
                              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-background"
                              style={isDragging ? { transform: `translateY(${dragLineupOffsetY}px)`, position: 'relative', zIndex: 10 } : undefined}
                            >
                              {allowed && (
                                <button
                                  onPointerDown={ev => handleLineupDragStart(g.lineup_name, entries, e, ev.currentTarget.closest('[data-lineup-row]') as HTMLElement, ev)}
                                  className="p-1 -ml-1 shrink-0 cursor-grab active:cursor-grabbing touch-none"
                                  aria-label={`Drag to reorder ${e.display_name}`}
                                >
                                  <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
                                </button>
                              )}
                              <div className="flex-1 flex items-center gap-2 min-w-0">
                                <PlayerAvatar photoUrl={e.photo_url} name={e.display_name} genderMatch={e.gender_match} size="sm" />
                                <span className="text-sm font-medium text-foreground truncate">{e.display_name}</span>
                              </div>
                              {allowed ? (
                                <Select
                                  value={e.role ?? e.position ?? '__none__'}
                                  onValueChange={v => handleUpdateLineupRole(e.id, v === '__none__' ? '' : v)}
                                >
                                  <SelectTrigger className="h-6 w-28 text-xs bg-card border-border text-foreground shrink-0"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none__">Not set</SelectItem>
                                    {POSITIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              ) : effectiveRole ? (
                                <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">{effectiveRole}</Badge>
                              ) : null}
                              <span className="text-xs text-muted-foreground shrink-0">
                                {s ? s.goals : 0}G {s ? s.assists : 0}A
                              </span>
                              {allowed && (
                                <button onClick={() => handleRemoveFromLineup(e.player_id, e.lineup_name)} className="p-1 rounded hover:bg-destructive/10">
                                  <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })
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
          const attendingEntries = nonSubRows.filter(r => r.in).map(r => ({ gender_match: allPlayers?.find(p => p.id === r.player_id)?.gender_match ?? null }))
          return (
            <Card className="bg-card text-card-foreground border-border">
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2"><ClipboardCheck className="w-4 h-4" />Attendance</span>
                  <span className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
                    <GenderRatio entries={attendingEntries} />
                    {rows ? `${inCount} / ${nonSubRows.length}` : '…'}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {allowed && (
                  <div className="flex items-center gap-2 pb-1">
                    <span className="text-xs text-muted-foreground shrink-0">Add player</span>
                    <PlayerCombobox
                      players={[]}
                      otherPlayers={attendanceOtherPlayerOptions}
                      value="__none__"
                      onValueChange={() => {}}
                      onAddPlayer={handleAddPlayerToAttendance}
                      onAddExistingPlayer={handleAddExistingPlayerToAttendance}
                      placeholder="Add player..."
                      className="flex-1 h-8 text-sm bg-background border-border"
                    />
                  </div>
                )}
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
                            <span className={`flex items-center gap-2 text-sm text-foreground ${row.in ? '' : 'opacity-50'}`}>
                              <PlayerAvatar photoUrl={player?.photo_url ?? null} name={player?.display_name ?? ''} genderMatch={player?.gender_match ?? null} size="sm" />
                              <span className={row.in ? '' : 'line-through'}>{player?.display_name ?? `Player ${row.player_id}`}</span>
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

        {/* Delete lineup group confirm */}
        <Dialog open={deleteGroupConfirm !== null} onOpenChange={open => !open && setDeleteGroupConfirm(null)}>
          <DialogContent className="bg-card text-card-foreground">
            <DialogHeader><DialogTitle>Delete Lineup</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              This will delete &quot;{deleteGroupConfirm?.lineup_name}&quot; and remove all its players from this lineup. This cannot be undone.
            </p>
            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={() => setDeleteGroupConfirm(null)} className="flex-1">Cancel</Button>
              <Button
                onClick={async () => { if (deleteGroupConfirm) { await handleDeleteLineupGroup(deleteGroupConfirm); setDeleteGroupConfirm(null) } }}
                className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete Lineup
              </Button>
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
  // Upcoming vs. Played is split by calendar day, not the exact start time:
  // otherwise a game moves to "Played" the moment its scheduled time hits,
  // even mid-game, and the next upcoming game (e.g. next week's) quietly
  // becomes whatever you'd score against by mistake.
  const now = new Date()
  const today = todayLocalStr()
  const upcomingGames = filteredGames.filter(g => !isPastGame(g, today)).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime())
  const pastGames = filteredGames.filter(g => isPastGame(g, today)).sort((a, b) => gameStartsAt(b).getTime() - gameStartsAt(a).getTime())
  const sortedGames = sortGamesUpcomingFirst(filteredGames, today)

  const formatRelativeDay = (dateStr: string) => {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
    const days = Math.round((startOfDay(new Date(dateStr + 'T00:00:00')).getTime() - startOfDay(now).getTime()) / 86_400_000)
    if (days === 0) return 'Today'
    if (days === 1) return 'Tomorrow'
    if (days > 1 && days <= 6) return `In ${days} days`
    return null
  }

  const renderGameCard = (game: Game, index: number, isPlayed: boolean) => {
    const displayResult = game.outcome_override ?? game.result
    // Redundant once a single season is already the active filter; only earns
    // its place in the meta line when the list is mixing seasons together.
    const showSeasonLabel = game.season_id && scheduleSeasonIds.length !== 1
    const badge = dateBadgeParts(game.game_date)
    return (
      <FadeIn key={game.id} delay={index * 40}>
        <Card
          onClick={() => handleSelectGame(game)}
          className="bg-card text-card-foreground border-border cursor-pointer hover:bg-accent/50 active:scale-[0.99] transition-all"
        >
          <CardContent className="py-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-base font-bold text-foreground truncate">vs {game.opponent}</span>
                  {game.game_type === 'Playoff' && <Trophy className="w-4 h-4 text-yellow-500 shrink-0" />}
                </div>
                {isPlayed ? (
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
                ) : (
                  <div className="flex items-center gap-1.5 mt-0.5 text-sm text-muted-foreground truncate">
                    <span>{formatWeekday(game.game_date)}</span>
                    <span>•</span>
                    <span>{formatTime(game.game_time)}</span>
                    {showSeasonLabel && (
                      <>
                        <span>•</span>
                        <span className="truncate">{getSeasonLabel(game.season_id!)}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {isPlayed ? (
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
                ) : (
                  <div className="flex flex-col items-center justify-center shrink-0 rounded-lg w-14 h-14 bg-muted">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{badge.month}</span>
                    <span className="text-xl font-bold leading-none mt-0.5">{badge.day}</span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </FadeIn>
    )
  }

  // Spotlight card for the very next upcoming game: bigger, with a month/day
  // badge, so the game you're most likely opening next stands out from the
  // rest of the upcoming list rather than blending in as a uniform row.
  const renderSpotlightCard = (game: Game) => {
    const relativeDay = formatRelativeDay(game.game_date)
    const badge = dateBadgeParts(game.game_date)
    const showSeasonLabel = game.season_id && scheduleSeasonIds.length !== 1
    return (
      <FadeIn key={game.id}>
        <Card
          onClick={() => handleSelectGame(game)}
          className="bg-card border-primary/40 ring-1 ring-primary/20 cursor-pointer hover:border-primary/70 active:scale-[0.99] transition-all"
        >
          <CardContent className="p-4 flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-wide mb-1 flex items-center gap-1.5 text-primary">
                <Target className="w-3.5 h-3.5" />
                Up Next{relativeDay ? ` · ${relativeDay}` : ''}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xl font-bold truncate">vs {game.opponent}</span>
                {game.game_type === 'Playoff' && <Trophy className="w-4 h-4 text-yellow-500 shrink-0" />}
              </div>
              <div className="flex items-center gap-1.5 mt-1 text-sm truncate text-muted-foreground">
                <span>{formatWeekday(game.game_date)}</span>
                <span>•</span>
                <span>{formatTime(game.game_time)}</span>
                {showSeasonLabel && (
                  <><span>•</span><span className="truncate">{getSeasonLabel(game.season_id!)}</span></>
                )}
              </div>
            </div>
            <div className="flex flex-col items-center justify-center shrink-0 rounded-lg w-14 h-14 bg-primary/10">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">{badge.month}</span>
              <span className="text-xl font-bold leading-none mt-0.5">{badge.day}</span>
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
                  <Input id="opponent" list="opponent-suggestions" value={formData.opponent} onChange={e => setFormData({ ...formData, opponent: e.target.value })} required className="bg-background text-foreground" />
                  <datalist id="opponent-suggestions">
                    {(leagueTeams ?? []).filter(t => !t.is_us).map(t => (
                      <option key={t.id} value={t.name} />
                    ))}
                  </datalist>
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
                  {showUpcoming && (
                    <div className="space-y-2">
                      {renderSpotlightCard(upcomingGames[0]!)}
                      {upcomingGames.slice(1).map((game, index) => renderGameCard(game, index, false))}
                    </div>
                  )}
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
                  {showPlayed && (
                    <div className="space-y-2">
                      {pastGames.map((game, index) => renderGameCard(game, index, true))}
                    </div>
                  )}
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
