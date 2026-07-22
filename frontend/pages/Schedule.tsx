import { useEffect, useState, useRef } from 'react'
import { useGetGames, useCreateGame, useUpdateGame, useDeleteGame, useGetLineups, useAddToLineup, useRemoveFromLineup, useMoveLineupEntry, useUpdateLineupSortOrder, useUpdateLineupRole, useGetLineupGroups, useCreateLineupGroup, useRenameLineupGroup, useReorderLineupGroups, useDeleteLineupGroup, useGetPreviousGameLineups, useGetLineupTemplates, useGetLineupTemplateDetail, useSaveLineupTemplate, useDeleteLineupTemplate, type LineupGroup, type LineupTemplate } from '../hooks/backend/games'
import { useGetGameEvents, useCreateGoalEvent, useCreateOpponentGoalEvent, useDeleteEvent, useUpdateEvent, useUpdateEventTimestamp, useGetEventTypes } from '../hooks/backend/events'
import { useGetSeasonRoster, useGetPlayersNotInSeason, useCreatePlayerForGame, useDeleteSubPlayer, useAddPlayerToGame } from '../hooks/backend/players'
import { useGetAllSeasons, useGetSeasons, useCreateSeason, useUpdateSeason, useGetSeasonsMeta, useGetPlayerStats } from '../hooks/backend/stats'
import { useGetGameAttendance } from '../hooks/backend/attendance'
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
import { Calendar, Plus, Minus, Trophy, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Target, TrendingUp, PlusCircle, Trash2, Edit2, Save, X, Users, LayoutList, CalendarDays, StickyNote, AlertTriangle, RefreshCw, ArrowLeftRight, Undo2, Check, ChevronsUpDown, GripVertical, Table2 } from 'lucide-react'

// A game counts as "imminent" from 30 minutes before its start time to 30
// minutes after, the window where you're about to score it or already are.
const IMMINENT_WINDOW_MS = 30 * 60 * 1000

// A game's detail view opens on a different default tab depending on how
// close it is to game time: still-warming-up games open on Lineups (so
// you're setting the lines, not scoring an empty board), the live-scoring
// window (10 min before kickoff through 1h10m after, roughly a game's
// length plus a warm-up/cooldown buffer) opens on Events, and anything
// later than that opens on Box Score since scoring is long over.
const PRE_GAME_EVENTS_WINDOW_MS = 10 * 60 * 1000
const POST_GAME_EVENTS_WINDOW_MS = 70 * 60 * 1000

function defaultTabForGame(g: { game_date: string; game_time: string | null }): 'events' | 'boxscore' | 'lineups' {
  const start = gameStartsAt(g).getTime()
  const now = Date.now()
  if (now < start - PRE_GAME_EVENTS_WINDOW_MS) return 'lineups'
  if (now <= start + POST_GAME_EVENTS_WINDOW_MS) return 'events'
  return 'boxscore'
}

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
type Season = { id: number; name: string; year: number; organizer: string | null; location: string | null; league_name: string | null; default_game_time: string | null; start_date: string | null; end_date: string | null }
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
  const { allowed, currentOrgId } = useAuth()
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
  const { trigger: updateSeason } = useUpdateSeason()
  const { data: seasonsMeta, trigger: fetchSeasonsMeta } = useGetSeasonsMeta()
  const { data: seasonsWithGames, trigger: fetchSeasonsWithGames } = useGetSeasons()
  const { data: lineups, trigger: fetchLineups } = useGetLineups()
  const { trigger: addToLineup } = useAddToLineup()
  const { trigger: removeFromLineup } = useRemoveFromLineup()
  const { trigger: moveLineupEntry } = useMoveLineupEntry()
  const { trigger: updateLineupSortOrder } = useUpdateLineupSortOrder()
  const { trigger: updateLineupRole } = useUpdateLineupRole()
  const { data: lineupGroups, trigger: fetchLineupGroups } = useGetLineupGroups()
  const { trigger: createLineupGroup } = useCreateLineupGroup()
  const { trigger: renameLineupGroup } = useRenameLineupGroup()
  const { trigger: reorderLineupGroups } = useReorderLineupGroups()
  const { trigger: deleteLineupGroup } = useDeleteLineupGroup()
  const { trigger: fetchPreviousGameLineups } = useGetPreviousGameLineups()
  const { data: lineupTemplates, trigger: fetchLineupTemplates } = useGetLineupTemplates()
  const { trigger: fetchLineupTemplateDetail } = useGetLineupTemplateDetail()
  const { trigger: saveLineupTemplate } = useSaveLineupTemplate()
  const { trigger: deleteLineupTemplate } = useDeleteLineupTemplate()
  const { data: lineupSeasonStats, trigger: fetchLineupSeasonStats } = useGetPlayerStats()
  const { trigger: createGoal } = useCreateGoalEvent()
  const { trigger: createOpponentGoal } = useCreateOpponentGoalEvent()
  const { trigger: deleteEvent } = useDeleteEvent()
  const { trigger: updateEvent } = useUpdateEvent()
  const { trigger: updateEventTimestamp } = useUpdateEventTimestamp()
  const { data: eventTypes, trigger: fetchEventTypes } = useGetEventTypes()
  const { data: leagueTeams, trigger: fetchLeagueTeams } = useGetLeagueTeams()

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const { data: attendanceRows, trigger: fetchAttendance } = useGetGameAttendance()

  const { data: jamConflicts, trigger: fetchJamConflicts } = useGetJamSyncConflicts()
  const { trigger: syncJamNow, loading: syncingJam } = useSyncJamNow()
  const { trigger: createGameFromConflict } = useCreateGameFromConflict()
  const { trigger: linkConflictToGame } = useLinkConflictToGame()
  const { trigger: dismissConflict } = useDismissConflict()
  const [jamCreateSeasonChoice, setJamCreateSeasonChoice] = useState<Record<number, string>>({})
  const [selectedGame, setSelectedGame] = useState<Game | null>(null)
  const [activeTab, setActiveTab] = useState<'events' | 'boxscore' | 'lineups' | 'notes'>('events')
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

  // Edit game details (opponent, season, date/time, type) — a separate
  // dialog from the outcome-override and notes inline editors below, since
  // those are quick single-field edits while this covers everything set at
  // creation time.
  const [showEditGame, setShowEditGame] = useState(false)
  const [editGameData, setEditGameData] = useState({ opponent: '', game_date: '', game_time: '', game_type: 'Regular', season_id: '' })
  const [savingGame, setSavingGame] = useState(false)

  // Edit season details. A season to edit is picked from a Select rather
  // than needing its own entry point per season, mirroring Roster's "Manage
  // Roster" pattern of one dialog that operates on whichever season is
  // chosen inside it.
  const [showEditSeason, setShowEditSeason] = useState(false)
  const [editSeasonId, setEditSeasonId] = useState<number | null>(null)
  const [editSeasonData, setEditSeasonData] = useState({
    name: '', year: '', organizer: '', location: '', league_name: '', default_game_time: '', start_date: '', end_date: '',
  })
  const [savingSeason, setSavingSeason] = useState(false)

  // Edit event
  const [editingEventId, setEditingEventId] = useState<number | null>(null)
  const [editScorerId, setEditScorerId] = useState<string>('')
  const [editAssisterId, setEditAssisterId] = useState<string>('')

  // Drag-to-reorder Recent Activity. dragOrder mirrors the list with the
  // dragged row moved to its live position as the pointer crosses each
  // neighbor's row; null when no drag is in progress, so the render just
  // falls back to the DB-fetched order. dragOffsetY is the sub-row-height
  // remainder of pointer movement not yet consumed by a swap, applied as a
  // translateY on the dragged row only, so it visually follows the pointer
  // smoothly between swaps instead of jumping a full row height at a time.
  const [dragEventId, setDragEventId] = useState<number | null>(null)
  const [dragOrder, setDragOrder] = useState<GameEvent[] | null>(null)
  const [dragOffsetY, setDragOffsetY] = useState(0)
  const eventDragRef = useRef<{ pointerId: number; startY: number; rowHeight: number; originalIndex: number; order: GameEvent[] } | null>(null)

  // Add event. Scorer/assister persist across successive adds (rather than
  // clearing after each one) so scoring several points in a row for the same
  // player doesn't require re-picking them every time.
  const [showAddEvent, setShowAddEvent] = useState(true)
  const [newEventType, setNewEventType] = useState<string>('Goal')
  const [newScorerId, setNewScorerId] = useState<string>('')
  const [newAssisterId, setNewAssisterId] = useState<string>('')
  const autoOpenedRef = useRef(false)

  // Game notes editing
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')

  // Outcome override
  const [editingOutcome, setEditingOutcome] = useState(false)
  const [outcomeValue, setOutcomeValue] = useState<string>('')

  // Lineup
  const [lineupName, setLineupName] = useState('Lineup 1')
  const [lineupPopoverOpen, setLineupPopoverOpen] = useState(false)
  const [copyingLineup, setCopyingLineup] = useState(false)
  const [savingTemplateOpen, setSavingTemplateOpen] = useState(false)
  const [templateNameInput, setTemplateNameInput] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [applyingTemplate, setApplyingTemplate] = useState(false)
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
  // Horizontal offset so the dragged row keeps following the pointer left/right
  // once it's dragged outside its own lineup card (e.g. toward a neighboring
  // column), instead of only tracking vertically.
  const [dragLineupOffsetX, setDragLineupOffsetX] = useState(0)
  // Which OTHER group's card the dragged row is currently hovering over, so
  // it can be highlighted as a drop target; null while still within its own
  // group (which just reorders, handled above) or hovering nothing dropzone-like.
  const [dragLineupHoverGroup, setDragLineupHoverGroup] = useState<string | null>(null)
  // True once the drag has left both lineup cards entirely (no data-lineup-group
  // ancestor under the pointer at all): releasing here removes the player from
  // the lineup (and, if that was their only one, clears their attendance).
  const [dragLineupWillRemove, setDragLineupWillRemove] = useState(false)
  const lineupDragRef = useRef<{ pointerId: number; startX: number; startY: number; rowHeight: number; originalIndex: number; order: LineupEntry[]; hoverGroup: string | null; willRemove: boolean } | null>(null)
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
    if (currentOrgId == null) return
    fetchSeasons({ organizationId: currentOrgId })
    fetchSeasonsMeta({ organizationId: currentOrgId })
    fetchEventTypes()
    fetchSeasonsWithGames({ organizationId: currentOrgId })
    fetchJamConflicts({ organizationId: currentOrgId })
  }, [currentOrgId])

  const handleSyncJamNow = async () => {
    await syncJamNow()
    fetchJamConflicts({ organizationId: currentOrgId })
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined, organizationId: currentOrgId })
  }

  const handleCreateGameFromConflict = async (conflict: JamSyncConflict) => {
    const chosen = jamCreateSeasonChoice[conflict.id]
    await createGameFromConflict({ conflict, seasonId: chosen ? parseInt(chosen) : null })
    fetchJamConflicts({ organizationId: currentOrgId })
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined, organizationId: currentOrgId })
  }

  const handleLinkJamConflict = async (conflict: JamSyncConflict) => {
    if (!conflict.existing_game_id) return
    await linkConflictToGame({ conflict, gameId: conflict.existing_game_id })
    fetchJamConflicts({ organizationId: currentOrgId })
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined, organizationId: currentOrgId })
  }

  const handleDismissJamConflict = async (conflictId: number) => {
    await dismissConflict({ conflictId })
    fetchJamConflicts({ organizationId: currentOrgId })
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
    if (currentOrgId == null) return
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined, organizationId: currentOrgId })
  }, [scheduleSeasonIds, currentOrgId])

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
      handleSelectGame(imminent)
    }
  }, [games])

  // Filling a game's lineups from the previous game (or a fresh
  // gender-balanced split if there is no previous one) is explicit now, via
  // the "Copy Last Game's Lineup" button shown while the game has no one
  // placed yet — it used to run automatically on open, which surprised
  // people who wanted to build a lineup from scratch instead of starting
  // from a copy. If the season's immediately-previous game has lineups,
  // this copies its group names, keeps returning non-sub players in the
  // same group they were in, and slots any newcomer into whichever copied
  // group is currently smallest. Otherwise (no previous game, or it was
  // never lineup'd) it falls back to two groups, "Lineup 1"/"Lineup 2",
  // with the season's non-sub roster split evenly and gender-balanced
  // between them. Subs are never auto-placed either way — they're always
  // added to a specific game by hand. Placing a player also marks them
  // attending (see useAddToLineup), since attendance is derived from
  // lineup membership rather than tracked separately.
  //
  // Guarded on zero *placed players* (game_lineups), not zero *groups*
  // (game_lineup_groups): a game can have empty group shells with nobody in
  // them yet (e.g. a group created by hand and never filled), and those
  // still count as fair game for this button — checking only "do groups
  // exist" would treat the game as already set up and refuse to fill it.
  const handleCopyPreviousLineup = async () => {
    const game = selectedGame
    if (!game) return
    const existingEntries = (lineups as LineupEntry[] | undefined) ?? []
    if (existingEntries.length > 0) return
    const roster = (players as Player[] | undefined) ?? []
    setCopyingLineup(true)
    try {
      if (!game.season_id) {
        // No season context to draw a roster from: seed two empty groups,
        // same as before this button existed.
        await Promise.all([
          createLineupGroup({ gameId: game.id, lineupName: 'Lineup 1', sortOrder: 0, organizationId: currentOrgId }),
          createLineupGroup({ gameId: game.id, lineupName: 'Lineup 2', sortOrder: 1, organizationId: currentOrgId }),
        ])
        fetchLineupGroups({ gameId: game.id })
        return
      }

      const nonSubRoster = roster.filter(p => !p.is_sub)
      const previous = await fetchPreviousGameLineups({ organizationId: currentOrgId, seasonId: game.season_id, gameId: game.id })

      let groupNames: string[]
      const assignment = new Map<number, string>() // player_id -> lineup_name

      if (previous && previous.groups.length > 0) {
        groupNames = previous.groups.map(g => g.lineup_name)
        const counts = new Map(groupNames.map(n => [n, 0]))
        const prevByPlayer = new Map(previous.entries.map(e => [e.player_id, e.lineup_name]))
        // Returning players keep their previous group.
        for (const p of nonSubRoster) {
          const prevGroup = prevByPlayer.get(p.id)
          if (prevGroup && groupNames.includes(prevGroup)) {
            assignment.set(p.id, prevGroup)
            counts.set(prevGroup, (counts.get(prevGroup) ?? 0) + 1)
          }
        }
        // Newcomers fill whichever copied group is currently smallest.
        for (const p of nonSubRoster) {
          if (assignment.has(p.id)) continue
          let smallest = groupNames[0]!
          for (const name of groupNames) if ((counts.get(name) ?? 0) < (counts.get(smallest) ?? 0)) smallest = name
          assignment.set(p.id, smallest)
          counts.set(smallest, (counts.get(smallest) ?? 0) + 1)
        }
      } else {
        groupNames = ['Lineup 1', 'Lineup 2']
        const byGender = new Map<string, Player[]>()
        for (const p of nonSubRoster) {
          const key = p.gender_match ?? 'unknown'
          if (!byGender.has(key)) byGender.set(key, [])
          byGender.get(key)!.push(p)
        }
        // Alternating within each gender bucket keeps both the head count and
        // the gender mix roughly even across the two lineups.
        for (const bucket of byGender.values()) {
          bucket.forEach((p, i) => assignment.set(p.id, groupNames[i % 2]!))
        }
      }

      await Promise.all(groupNames.map((name, i) =>
        createLineupGroup({ gameId: game.id, lineupName: name, sortOrder: i, organizationId: currentOrgId })
      ))

      const sortCounters = new Map<string, number>()
      await Promise.all([...assignment.entries()].map(([playerId, targetGroup]) => {
        const sortOrder = sortCounters.get(targetGroup) ?? 0
        sortCounters.set(targetGroup, sortOrder + 1)
        return addToLineup({ gameId: game.id, player_id: playerId, lineup_name: targetGroup, seasonId: game.season_id, sortOrder, organizationId: currentOrgId })
      }))

      fetchLineupGroups({ gameId: game.id })
      fetchLineups({ gameId: game.id })
      fetchAttendance({ gameId: game.id })
    } finally {
      setCopyingLineup(false)
    }
  }

  // Saves the current game's lineup (group names + player assignments) as a
  // named template scoped to the season, independent of game order — unlike
  // "Copy Last Game's Lineup" this can be loaded into any future game, not
  // just the one right after it. Saving under a name that already exists
  // for the season overwrites that template rather than erroring.
  const handleSaveLineupTemplate = async () => {
    const game = selectedGame
    const name = templateNameInput.trim()
    if (!game?.season_id || !name) return
    setSavingTemplate(true)
    try {
      const groups = ((lineupGroups as LineupGroup[] | undefined) ?? []).map(g => ({ lineup_name: g.lineup_name, sort_order: g.sort_order }))
      const players = ((lineups as LineupEntry[] | undefined) ?? []).map(e => ({ lineup_name: e.lineup_name, player_id: e.player_id, sort_order: e.sort_order, role: e.role }))
      await saveLineupTemplate({ organizationId: currentOrgId, seasonId: game.season_id, name, groups, players })
      setTemplateNameInput('')
      setSavingTemplateOpen(false)
      fetchLineupTemplates({ organizationId: currentOrgId, seasonId: game.season_id })
    } finally {
      setSavingTemplate(false)
    }
  }

  // Loading a template is gated the same way as "Copy Last Game's Lineup":
  // only offered while the game has no one placed yet, so it can't create
  // duplicate placements alongside an existing lineup.
  const handleApplyLineupTemplate = async () => {
    const game = selectedGame
    if (!game || !selectedTemplateId) return
    const existingEntries = (lineups as LineupEntry[] | undefined) ?? []
    if (existingEntries.length > 0) return
    setApplyingTemplate(true)
    try {
      const detail = await fetchLineupTemplateDetail({ templateId: parseInt(selectedTemplateId) })
      if (!detail) return
      await Promise.all(detail.groups.map((g, i) =>
        createLineupGroup({ gameId: game.id, lineupName: g.lineup_name, sortOrder: i, organizationId: currentOrgId })
      ))
      await Promise.all(detail.players.map(p =>
        addToLineup({ gameId: game.id, player_id: p.player_id, lineup_name: p.lineup_name, seasonId: game.season_id, sortOrder: p.sort_order, role: p.role, organizationId: currentOrgId })
      ))
      setSelectedTemplateId('')
      fetchLineupGroups({ gameId: game.id })
      fetchLineups({ gameId: game.id })
      fetchAttendance({ gameId: game.id })
    } finally {
      setApplyingTemplate(false)
    }
  }

  const handleDeleteLineupTemplate = async (templateId: number) => {
    await deleteLineupTemplate({ templateId })
    if (selectedTemplateId === templateId.toString()) setSelectedTemplateId('')
    if (selectedGame?.season_id) fetchLineupTemplates({ organizationId: currentOrgId, seasonId: selectedGame.season_id })
  }

  const handleSelectGame = async (game: Game) => {
    setSelectedGame(game)
    fetchEvents({ gameId: game.id })
    fetchAttendance({ gameId: game.id })
    if (game.season_id) {
      fetchPlayers({ seasonId: game.season_id })
      fetchOtherPlayers({ seasonId: game.season_id, organizationId: currentOrgId })
      fetchLineupSeasonStats({ seasonIds: [game.season_id], organizationId: currentOrgId })
      fetchLineupTemplates({ organizationId: currentOrgId, seasonId: game.season_id })
    } else {
      fetchOtherPlayers({ organizationId: currentOrgId })
    }
    fetchLineupGroups({ gameId: game.id })
    fetchLineups({ gameId: game.id })
    setActiveTab(defaultTabForGame(game))
    setEditingNotes(false)
    setEditingOutcome(false)
    setNotesValue(game.notes ?? '')
    setOutcomeValue(game.outcome_override ?? '')
    // Add Event starts expanded regardless of how the game was opened, so
    // it's ready to score without an extra click.
    setShowAddEvent(true)
    setNewEventType('Goal')
    setNewScorerId('')
    setNewAssisterId('')
    setAddingLineupName(false)
    setNewLineupNameInput('')
    setSavingTemplateOpen(false)
    setTemplateNameInput('')
    setSelectedTemplateId('')
  }

  // Season roster refetch needs the game's season id, not the game id.
  const selectedGameSeasonId = selectedGame?.season_id ?? null
  const refreshRoster = async () => {
    if (selectedGameSeasonId) {
      await fetchPlayers({ seasonId: selectedGameSeasonId })
      await fetchOtherPlayers({ seasonId: selectedGameSeasonId, organizationId: currentOrgId })
    } else {
      await fetchOtherPlayers({ organizationId: currentOrgId })
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
      organizationId: currentOrgId,
    }) as Season | undefined
    if (created) {
      await fetchSeasons({ organizationId: currentOrgId })
      await fetchSeasonsMeta({ organizationId: currentOrgId })
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
      organizationId: currentOrgId,
    })
    setIsDialogOpen(false)
    setFormData({ opponent: '', game_date: '', game_time: '', game_type: 'Regular', season_id: '' })
    setShowNewSeason(false)
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined, organizationId: currentOrgId })
  }

  const handleDeleteGame = async (gameId: number) => {
    await deleteGame({ gameId })
    setDeleteConfirmId(null)
    setSelectedGame(null)
    fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined, organizationId: currentOrgId })
  }

  const handleOpenEditGame = () => {
    if (!selectedGame) return
    setEditGameData({
      opponent: selectedGame.opponent,
      game_date: selectedGame.game_date,
      game_time: (selectedGame.game_time ?? '').slice(0, 5),
      game_type: selectedGame.game_type || 'Regular',
      season_id: selectedGame.season_id ? String(selectedGame.season_id) : '',
    })
    setShowEditGame(true)
  }

  const handleSaveEditGame = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedGame) return
    setSavingGame(true)
    try {
      const updated = await updateGame({
        gameId: selectedGame.id,
        opponent: editGameData.opponent,
        game_date: editGameData.game_date,
        game_time: editGameData.game_time,
        game_type: editGameData.game_type,
        season_id: editGameData.season_id ? parseInt(editGameData.season_id) : null,
      }) as Game | undefined
      if (updated) {
        setSelectedGame(updated)
        setActiveTab(defaultTabForGame(updated))
      }
      setShowEditGame(false)
      fetchGames({ seasonIds: scheduleSeasonIds.length > 0 ? scheduleSeasonIds : undefined, organizationId: currentOrgId })
    } finally {
      setSavingGame(false)
    }
  }

  const handleOpenEditSeason = (seasonId?: number) => {
    const allS = (seasons as Season[] | undefined) ?? []
    const id = seasonId ?? (scheduleSeasonIds.length === 1 ? scheduleSeasonIds[0] : allS[0]?.id)
    const s = allS.find(s => s.id === id)
    if (!s) return
    setEditSeasonId(s.id)
    setEditSeasonData({
      name: s.name, year: String(s.year), organizer: s.organizer ?? '', location: s.location ?? '',
      league_name: s.league_name ?? '', default_game_time: (s.default_game_time ?? '').slice(0, 5),
      start_date: s.start_date ?? '', end_date: s.end_date ?? '',
    })
    setShowEditSeason(true)
  }

  const handleEditSeasonSelect = (value: string) => {
    handleOpenEditSeason(parseInt(value))
  }

  const handleSaveEditSeason = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editSeasonId == null) return
    setSavingSeason(true)
    try {
      await updateSeason({
        seasonId: editSeasonId,
        name: editSeasonData.name,
        year: parseInt(editSeasonData.year),
        organizer: editSeasonData.organizer || null,
        location: editSeasonData.location || null,
        league_name: editSeasonData.league_name || null,
        default_game_time: editSeasonData.default_game_time || null,
        start_date: editSeasonData.start_date || null,
        end_date: editSeasonData.end_date || null,
      })
      setShowEditSeason(false)
      fetchSeasons({ organizationId: currentOrgId })
      fetchSeasonsMeta({ organizationId: currentOrgId })
    } finally {
      setSavingSeason(false)
    }
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

  // Drag a Recent Activity row to reorder it. There's no ordinal column on
  // game_events; order is purely event_timestamp (descending), so
  // reordering reassigns the same set of timestamps the list already had
  // to events in their new positions rather than renumbering a position.
  const handleEventDragStart = (list: GameEvent[], event: GameEvent, rowEl: HTMLElement, e: React.PointerEvent) => {
    if (!allowed) return
    e.preventDefault()
    e.stopPropagation()
    const pointerId = e.pointerId
    const originalIndex = list.findIndex(ev => ev.id === event.id)
    if (originalIndex === -1) return
    const rowHeight = rowEl.getBoundingClientRect().height
    const drag = { pointerId, startY: e.clientY, rowHeight, originalIndex, order: [...list] }
    eventDragRef.current = drag
    setDragEventId(event.id)
    setDragOffsetY(0)
    setDragOrder(drag.order)

    const onMove = (ev: PointerEvent) => {
      const d = eventDragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      const rawDelta = ev.clientY - d.startY
      const targetIndex = Math.min(d.order.length - 1, Math.max(0, d.originalIndex + Math.round(rawDelta / d.rowHeight)))
      const currentIndex = d.order.findIndex(ev2 => ev2.id === event.id)
      if (targetIndex !== currentIndex) {
        const next = [...d.order]
        const [moved] = next.splice(currentIndex, 1)
        next.splice(targetIndex, 0, moved)
        d.order = next
        setDragOrder(next)
      }
      setDragOffsetY(rawDelta - (targetIndex - d.originalIndex) * d.rowHeight)
    }
    const onUp = async (ev: PointerEvent) => {
      const d = eventDragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      teardown()
      eventDragRef.current = null
      setDragEventId(null)
      setDragOrder(null)
      setDragOffsetY(0)
      const originalTimestamps = list.map(ev2 => ev2.event_timestamp)
      const changes = d.order
        .map((ev2, i) => ({ id: ev2.id, timestamp: originalTimestamps[i]! }))
        .filter(c => list.find(ev2 => ev2.id === c.id)?.event_timestamp !== c.timestamp)
      if (changes.length > 0 && selectedGame) {
        await Promise.all(changes.map(c => updateEventTimestamp({ eventId: c.id, timestamp: c.timestamp })))
        fetchEvents({ gameId: selectedGame.id })
      }
    }
    const onCancel = (ev: PointerEvent) => {
      if (eventDragRef.current?.pointerId !== ev.pointerId) return
      teardown()
      eventDragRef.current = null
      setDragEventId(null)
      setDragOrder(null)
      setDragOffsetY(0)
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
      await createOpponentGoal({ gameId: selectedGame.id, organizationId: currentOrgId })
    } else {
      await createGoal({
        gameId: selectedGame.id,
        playerId: resolveNewPlayerId(newScorerId),
        relatedPlayerId: resolveNewPlayerId(newAssisterId),
        eventType: newEventType,
        organizationId: currentOrgId,
      })
    }
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleAddOpponentGoal = async () => {
    if (!selectedGame) return
    await createOpponentGoal({ gameId: selectedGame.id, organizationId: currentOrgId })
    fetchEvents({ gameId: selectedGame.id })
  }

  const handleUndo = async () => {
    const gameEvents = events as GameEvent[] | undefined
    if (!selectedGame || !gameEvents || gameEvents.length === 0) return
    await deleteEvent({ eventId: gameEvents[0]!.id })
    fetchEvents({ gameId: selectedGame.id })
  }

  // A player added mid-game from the Scorer/Assister quick-pick has no
  // "currently selected lineup" context to draw on (that only exists in the
  // Lineups tab), so it falls back to the game's first lineup group —
  // placing them somewhere real rather than a nonexistent group is what
  // marks them attending, since attendance is derived from lineup membership.
  const defaultLineupName = (lineupGroups as LineupGroup[] | undefined)?.[0]?.lineup_name ?? 'Lineup 1'

  const handleAddPlayer = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    if (result) {
      await refreshRoster()
      fetchAttendance({ gameId: selectedGame.id })
      fetchLineups({ gameId: selectedGame.id })
      setNewScorerId((result as { id: number }).id.toString())
    }
  }

  const handleAddAssister = async (name: string) => {
    if (!selectedGame) return
    const result = await createPlayerForGame({ display_name: name, gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    if (result) {
      await refreshRoster()
      fetchAttendance({ gameId: selectedGame.id })
      fetchLineups({ gameId: selectedGame.id })
      setNewAssisterId((result as { id: number }).id.toString())
    }
  }

  const handleAddExistingScorer = async (playerId: string) => {
    if (!selectedGame) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    await refreshRoster()
    fetchAttendance({ gameId: selectedGame.id })
    fetchLineups({ gameId: selectedGame.id })
    setNewScorerId(playerId)
  }

  const handleAddExistingAssister = async (playerId: string) => {
    if (!selectedGame) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedGame.id, seasonId: selectedGameSeasonId, organizationId: currentOrgId, lineupName: defaultLineupName })
    await refreshRoster()
    fetchAttendance({ gameId: selectedGame.id })
    fetchLineups({ gameId: selectedGame.id })
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

  // Clicking a candidate in "Select players..." adds them immediately —
  // no separate multi-select + confirm step. The popover stays open so
  // adding several people in a row is just a sequence of clicks; each
  // added player drops out of the candidate list on its own since
  // lineupCandidates already excludes anyone placed anywhere in the game.
  const handleAddPlayerToLineup = async (playerId: number) => {
    if (!selectedGame) return
    const currentGroupEntries = ((lineups as LineupEntry[] | undefined) ?? []).filter(e => e.lineup_name === lineupName)
    const nextSortOrder = currentGroupEntries.reduce((max, e) => Math.max(max, e.sort_order), -1) + 1
    await addToLineup({ gameId: selectedGame.id, player_id: playerId, lineup_name: lineupName, seasonId: selectedGame.season_id, sortOrder: nextSortOrder, organizationId: currentOrgId })
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
    await createLineupGroup({ gameId: selectedGame.id, lineupName: name.trim(), sortOrder: nextSortOrder, organizationId: currentOrgId })
    setLineupName(name.trim())
    setAddingLineupName(false)
    fetchLineupGroups({ gameId: selectedGame.id })
  }

  const handleDeleteLineupGroup = async (group: LineupGroup) => {
    if (!selectedGame) return
    // Deleting a group drops every player placed in it (see
    // useDeleteLineupGroup). Attendance has no separate write side anymore
    // (see useGetGameAttendance) — it's just re-read from game_lineups.
    await deleteLineupGroup({ gameId: selectedGame.id, lineupName: group.lineup_name, groupId: group.id })
    fetchLineupGroups({ gameId: selectedGame.id })
    fetchLineups({ gameId: selectedGame.id })
    fetchAttendance({ gameId: selectedGame.id })
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


  // Attendance has no separate write side (see useGetGameAttendance) — it's
  // just re-read from game_lineups, so removing someone from their last
  // lineup entry here is all that's needed for them to read as not attending.
  const handleRemoveFromLineup = async (playerId: number, lineupGroup: string) => {
    if (!selectedGame) return
    await removeFromLineup({ gameId: selectedGame.id, playerId, lineup_name: lineupGroup })
    fetchLineups({ gameId: selectedGame.id })
    fetchAttendance({ gameId: selectedGame.id })
  }

  // Drag a lineup row to reorder players within their group, or drop it onto
  // a different group's card to move the player there. Mirrors the Recent
  // Activity event-drag pattern (window pointer listeners, splice the
  // working order on each crossed threshold) for in-group reordering, and
  // reassigns the group's sort_order values instead of timestamps since
  // game_lineups has an explicit ordering column. Cross-group detection uses
  // elementFromPoint against each group card's data-lineup-group attribute
  // rather than a full DnD library, consistent with this page's other
  // lightweight pointer-based drags.
  const handleLineupDragStart = (group: string, list: LineupEntry[], entry: LineupEntry, rowEl: HTMLElement, e: React.PointerEvent) => {
    if (!allowed) return
    e.preventDefault()
    e.stopPropagation()
    const pointerId = e.pointerId
    const originalIndex = list.findIndex(en => en.id === entry.id)
    if (originalIndex === -1) return
    const rowHeight = rowEl.getBoundingClientRect().height
    const drag = { pointerId, startX: e.clientX, startY: e.clientY, rowHeight, originalIndex, order: [...list], hoverGroup: null as string | null, willRemove: false }
    lineupDragRef.current = drag
    setDragLineupEntryId(entry.id)
    setDragLineupGroup(group)
    setDragLineupOffsetX(0)
    setDragLineupOffsetY(0)
    setDragLineupOrder(drag.order)
    setDragLineupHoverGroup(null)
    setDragLineupWillRemove(false)

    const onMove = (ev: PointerEvent) => {
      const d = lineupDragRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      const rawDeltaX = ev.clientX - d.startX
      const hoverEl = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest('[data-lineup-group]') as HTMLElement | null
      const hoverGroup = hoverEl?.dataset.lineupGroup ?? null
      if (hoverGroup && hoverGroup !== group) {
        // Hovering a different group's card: freeze in-group order and just
        // let the row float toward the pointer (both axes) as a drop-here indicator.
        d.hoverGroup = hoverGroup
        d.willRemove = false
        setDragLineupHoverGroup(hoverGroup)
        setDragLineupWillRemove(false)
        setDragLineupOffsetX(rawDeltaX)
        setDragLineupOffsetY(ev.clientY - d.startY)
        return
      }
      if (!hoverGroup) {
        // Outside both lineup cards entirely: releasing here removes them
        // from the game instead of reordering or moving groups.
        d.hoverGroup = null
        d.willRemove = true
        setDragLineupHoverGroup(null)
        setDragLineupWillRemove(true)
        setDragLineupOffsetX(rawDeltaX)
        setDragLineupOffsetY(ev.clientY - d.startY)
        return
      }
      d.hoverGroup = null
      d.willRemove = false
      setDragLineupHoverGroup(null)
      setDragLineupWillRemove(false)
      setDragLineupOffsetX(rawDeltaX)
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
      const targetGroup = d.hoverGroup
      const willRemove = d.willRemove
      setDragLineupEntryId(null)
      setDragLineupGroup(null)
      setDragLineupOrder(null)
      setDragLineupOffsetX(0)
      setDragLineupOffsetY(0)
      setDragLineupHoverGroup(null)
      setDragLineupWillRemove(false)
      if (willRemove) {
        await handleRemoveFromLineup(entry.player_id, group)
        return
      }
      if (targetGroup && targetGroup !== group) {
        if (selectedGame) {
          const targetEntries = ((lineups as LineupEntry[] | undefined) ?? []).filter(en => en.lineup_name === targetGroup)
          const nextSortOrder = targetEntries.length > 0 ? Math.max(...targetEntries.map(en => en.sort_order)) + 1 : 0
          await moveLineupEntry({ id: entry.id, lineupName: targetGroup, sortOrder: nextSortOrder })
          fetchLineups({ gameId: selectedGame.id })
        }
        return
      }
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
      setDragLineupOffsetX(0)
      setDragLineupOffsetY(0)
      setDragLineupHoverGroup(null)
      setDragLineupWillRemove(false)
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

  // Scorer/assister quick-select should only offer players placed in a
  // lineup for this game (attendance is a pure read of lineup membership —
  // see useGetGameAttendance). A missing row defaults to "attending" for a
  // full roster player (they may just not have been placed in a lineup
  // yet), but NOT for a sub: a sub is only ever part of a game once
  // explicitly added to it (see useCreatePlayerForGame/useAddPlayerToGame),
  // so no lineup row for a sub means they were never part of this game, not
  // that they're attending by default. The Edit Event dialog still uses the
  // full roster so past events referencing a player who's since been
  // removed from the lineup stay editable.
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
    // Anyone already placed in ANY lineup group for this game is excluded,
    // not just the currently-targeted group: a player only needs one line,
    // so once they're placed anywhere they should drop out of the "add"
    // list entirely rather than staying pickable for every other group.
    const placedAnywherePlayerIds = new Set(lineupEntries.map(e => e.player_id))
    const lineupCandidates = ((players as Player[] | undefined) ?? [])
      .filter(p => !placedAnywherePlayerIds.has(p.id))
      .sort((a, b) =>
        Number(!!a.is_sub) - Number(!!b.is_sub)
        || (a.gender_match ?? '').localeCompare(b.gender_match ?? '')
        || a.display_name.localeCompare(b.display_name)
      )

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <button onClick={handleBack} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ChevronLeft className="w-5 h-5" />
            <span className="text-sm font-medium">Back to Schedule</span>
          </button>
          {allowed && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleOpenEditGame}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <Edit2 className="w-4 h-4" />
                Edit
              </button>
              <button
                onClick={() => setDeleteConfirmId(selectedGame.id)}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            </div>
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

        {/* Tab bar */}
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {[
            { key: 'events' as const, icon: LayoutList, label: 'Events' },
            { key: 'boxscore' as const, icon: Table2, label: 'Box Score' },
            { key: 'lineups' as const, icon: Users, label: 'Lineups' },
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
                  {(dragOrder ?? gameEvents).map((event, i) => {
                    const scorer = getPlayerName(event.player_id)
                    const assister = getPlayerName(event.related_player_id)
                    const isGoal = event.event_type === 'Goal'
                    const isOpponentGoal = event.event_type === 'Opponent Goal'
                    const isTurnover = isTurnoverEvent(event.event_type)
                    const isEditing = editingEventId === event.id
                    const isDragging = dragEventId === event.id

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
                    // The dragged row skips FadeIn: its animate-in classes
                    // persist a CSS-animation-driven transform (fill-mode:
                    // both) that would fight the inline translateY below.
                    // Every other row keeps a stable key across a reorder
                    // (keyed by event.id, not index), so FadeIn's mount
                    // animation never re-triggers just from shuffling.
                    const RowTag = isDragging ? 'div' : FadeIn
                    return (
                      <RowTag
                        key={event.id}
                        data-event-row
                        {...(isDragging ? {} : { delay: i * 40 })}
                        className={`flex items-center gap-3 py-2 border-b border-border last:border-0 ${isDragging ? 'relative z-10 bg-card shadow-lg rounded-lg' : ''}`}
                        style={isDragging ? { transform: `translateY(${dragOffsetY}px)` } : undefined}
                      >
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
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              onPointerDown={e => handleEventDragStart(gameEvents, event, e.currentTarget.closest('[data-event-row]') as HTMLElement, e)}
                              className="p-1.5 rounded hover:bg-accent transition-colors cursor-grab touch-none"
                              aria-label="Drag to reorder event"
                            >
                              <GripVertical className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                            </button>
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
                      </RowTag>
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
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4" />Lineups</CardTitle>
                {allowed && orderedGroups.length > 0 && !savingTemplateOpen && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setSavingTemplateOpen(true)} className="h-7 text-xs bg-card border-border">
                    Save as Template
                  </Button>
                )}
              </div>
              {savingTemplateOpen && (
                <div className="flex gap-2 mt-2">
                  <Input
                    autoFocus
                    placeholder="Template name..."
                    value={templateNameInput}
                    onChange={e => setTemplateNameInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveLineupTemplate(); if (e.key === 'Escape') setSavingTemplateOpen(false) }}
                    className="h-8 text-sm bg-card border-border"
                  />
                  <Button type="button" size="sm" onClick={handleSaveLineupTemplate} disabled={!templateNameInput.trim() || savingTemplate} className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 shrink-0">
                    {savingTemplate ? 'Saving...' : 'Save'}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => { setSavingTemplateOpen(false); setTemplateNameInput('') }} className="h-8 bg-card border-border shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Add to lineup */}
              {allowed && (
                <div className="space-y-2 bg-background rounded-lg p-3">
                  <Label className="text-xs text-muted-foreground">Add Players</Label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Select value={lineupName} onValueChange={setLineupName}>
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
                  <Popover open={lineupPopoverOpen} onOpenChange={setLineupPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        role="combobox"
                        aria-expanded={lineupPopoverOpen}
                        className="w-full h-8 justify-between font-normal text-sm bg-card border-border"
                      >
                        <span className="truncate">Select players...</span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    {/* Matches the trigger's own width via Radix's exposed
                        CSS var, instead of a fixed px width, so the search
                        input lines up with the "Select players..." button
                        rather than overhanging it. */}
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                      <Command>
                        <CommandInput placeholder="Search players..." />
                        <CommandList>
                          <CommandEmpty>No player found.</CommandEmpty>
                          <CommandGroup>
                            <div className="grid grid-cols-2 gap-x-1">
                              {lineupCandidates.map(p => {
                                const s = seasonStatsByPlayerId.get(p.id)
                                return (
                                  <CommandItem
                                    key={p.id}
                                    value={p.display_name}
                                    onSelect={() => handleAddPlayerToLineup(p.id)}
                                    className="flex items-center justify-between"
                                  >
                                    <div className="flex items-center min-w-0 gap-1.5">
                                      <GenderTag value={p.gender_match} />
                                      <span className="truncate">{p.display_name}</span>
                                      {p.is_sub && (
                                        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1 rounded bg-amber-500/15 text-amber-500">Sub</span>
                                      )}
                                    </div>
                                    <span className="text-xs text-muted-foreground shrink-0 ml-2">
                                      {s ? s.goals : 0}G {s ? s.assists : 0}A
                                    </span>
                                  </CommandItem>
                                )
                              })}
                            </div>
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              )}

              {/* Shown until someone's actually been placed in a lineup for
                  this game — copying is an explicit choice, not automatic,
                  so starting from scratch is just as easy as copying. */}
              {lineupEntries.length === 0 && (
                <div className="text-center py-6 text-muted-foreground text-sm space-y-3">
                  <div>
                    <Users className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    No one's been placed in a lineup for this game yet.
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleCopyPreviousLineup}
                    disabled={copyingLineup}
                    className="bg-card border-border"
                  >
                    {copyingLineup ? 'Copying...' : "Copy Last Game's Lineup"}
                  </Button>
                  {((lineupTemplates as LineupTemplate[] | undefined) ?? []).length > 0 && (
                    <div className="flex items-center justify-center gap-2 max-w-xs mx-auto">
                      <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                        <SelectTrigger className="h-8 text-sm bg-card border-border"><SelectValue placeholder="Load saved lineup..." /></SelectTrigger>
                        <SelectContent>
                          {(lineupTemplates as LineupTemplate[]).map(t => (
                            <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleApplyLineupTemplate}
                        disabled={!selectedTemplateId || applyingTemplate}
                        className="h-8 bg-card border-border shrink-0"
                      >
                        {applyingTemplate ? 'Loading...' : 'Load'}
                      </Button>
                      {selectedTemplateId && (
                        <button
                          type="button"
                          onClick={() => handleDeleteLineupTemplate(parseInt(selectedTemplateId))}
                          title="Delete this saved lineup"
                          aria-label="Delete this saved lineup"
                          className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Lineup groups */}
              {orderedGroups.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {orderedGroups.map(g => {
                  const entries = lineupByGroup[g.lineup_name] ?? []
                  const isGroupDragging = dragGroupId === g.id
                  const isDropTarget = dragLineupHoverGroup === g.lineup_name
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
                      data-lineup-group={g.lineup_name}
                      className={`rounded-lg border p-3 transition-colors ${isDropTarget ? 'border-primary ring-2 ring-primary bg-primary/5' : 'border-border bg-background'}`}
                      style={isGroupDragging ? { transform: `translateY(${dragGroupOffsetY}px)`, position: 'relative', zIndex: 20 } : undefined}
                    >
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
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
                              className={`flex items-start gap-2 px-3 py-2 rounded-lg ${isDragging && dragLineupWillRemove ? 'bg-destructive/10 border border-destructive' : 'bg-background'}`}
                              style={isDragging ? { transform: `translate(${dragLineupOffsetX}px, ${dragLineupOffsetY}px)`, position: 'relative', zIndex: 10, pointerEvents: 'none', opacity: dragLineupWillRemove ? 0.85 : 1 } : undefined}
                            >
                              {allowed && (
                                <button
                                  onPointerDown={ev => handleLineupDragStart(g.lineup_name, entries, e, ev.currentTarget.closest('[data-lineup-row]') as HTMLElement, ev)}
                                  className="p-1 -ml-1 mt-0.5 shrink-0 cursor-grab active:cursor-grabbing touch-none"
                                  aria-label={`Drag to reorder ${e.display_name}`}
                                >
                                  <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
                                </button>
                              )}
                              <PlayerAvatar photoUrl={e.photo_url} name={e.display_name} genderMatch={e.gender_match} size="sm" />
                              {/* Name gets its own row above role/stats instead of
                                  sharing one cramped line: most entries have no photo
                                  to help identify at a glance, and this grid's
                                  half-width columns don't leave room for name, role,
                                  and stats side by side without heavy truncation. */}
                              <div className="flex-1 min-w-0 space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-sm font-medium text-foreground truncate">{e.display_name}</span>
                                  {allowed && (
                                    <button onClick={() => handleRemoveFromLineup(e.player_id, e.lineup_name)} className="p-1 -mr-1 shrink-0 rounded hover:bg-destructive/10">
                                      <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
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
                                  <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                                    {s ? s.goals : 0}G {s ? s.assists : 0}A
                                  </span>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

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

        {/* Box score */}
        {activeTab === 'boxscore' && (
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader><CardTitle className="text-base">Box Score</CardTitle></CardHeader>
            <CardContent>
              {playerStats.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No events recorded for this game.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground font-medium">
                      <th className="text-left font-medium px-3 pb-2">Player</th>
                      <th className="w-10 text-center font-medium text-green-600 dark:text-green-400 pb-2">G</th>
                      <th className="w-10 text-center font-medium text-blue-600 dark:text-blue-400 pb-2">A</th>
                      <th className="w-10 text-center font-medium text-orange-600 dark:text-orange-400 pb-2">TO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playerStats.map(p => (
                      <tr key={p.name} className="border-t border-border">
                        <td className="px-3 py-2 font-medium text-foreground">{p.name}</td>
                        <td className="w-10 text-center font-bold text-green-600 dark:text-green-400">{p.goals}</td>
                        <td className="w-10 text-center font-bold text-blue-600 dark:text-blue-400">{p.assists}</td>
                        <td className="w-10 text-center font-bold text-orange-600 dark:text-orange-400">{p.turnovers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}

        {/* Edit game details */}
        <Dialog open={showEditGame} onOpenChange={setShowEditGame}>
          <DialogContent className="bg-card text-card-foreground max-h-[90vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Edit Game</DialogTitle></DialogHeader>
            <form onSubmit={handleSaveEditGame} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-opponent">Opponent</Label>
                <Input id="edit-opponent" value={editGameData.opponent} onChange={e => setEditGameData({ ...editGameData, opponent: e.target.value })} required className="bg-background text-foreground" />
              </div>
              <div className="space-y-2">
                <Label>Season</Label>
                <Select value={editGameData.season_id || '__none__'} onValueChange={v => setEditGameData({ ...editGameData, season_id: v === '__none__' ? '' : v })}>
                  <SelectTrigger className="bg-background text-foreground"><SelectValue placeholder="No season" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No season</SelectItem>
                    {(seasons as Season[] | undefined)?.map(s => (
                      <SelectItem key={s.id} value={String(s.id)}>{seasonLabel(s)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="edit-game_date">Date</Label>
                  <Input id="edit-game_date" type="date" value={editGameData.game_date} onChange={e => setEditGameData({ ...editGameData, game_date: e.target.value })} required className="bg-background text-foreground" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-game_time">Time</Label>
                  <Input id="edit-game_time" type="time" value={editGameData.game_time} onChange={e => setEditGameData({ ...editGameData, game_time: e.target.value })} required className="bg-background text-foreground" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Game Type</Label>
                <Select value={editGameData.game_type} onValueChange={value => setEditGameData({ ...editGameData, game_type: value })}>
                  <SelectTrigger className="bg-background text-foreground"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['Regular', 'Playoff', 'Tournament', 'Friendly'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={savingGame} className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                {savingGame ? 'Saving…' : 'Save Changes'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>

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
      <div className="flex gap-2">
        <div className="flex-1">
          <SeasonMultiSelect
            seasons={(seasons as Season[] | undefined) ?? []}
            selectedIds={scheduleSeasonIds}
            onChange={setScheduleSeasonIds}
            placeholder="All Seasons"
          />
        </div>
        {allowed && (seasons as Season[] | undefined)?.length ? (
          <button
            onClick={() => handleOpenEditSeason()}
            title="Edit season details"
            className="flex items-center justify-center w-9 h-9 shrink-0 rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Edit2 className="w-4 h-4" />
          </button>
        ) : null}
      </div>

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

      {/* Edit season details. One dialog operating on whichever season is
          picked in its own Select, rather than a per-season entry point. */}
      <Dialog open={showEditSeason} onOpenChange={setShowEditSeason}>
        <DialogContent className="bg-card text-card-foreground max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Season</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>Season</Label>
            <Select value={editSeasonId != null ? String(editSeasonId) : ''} onValueChange={handleEditSeasonSelect}>
              <SelectTrigger className="bg-background text-foreground"><SelectValue placeholder="Select season" /></SelectTrigger>
              <SelectContent>
                {(seasons as Season[] | undefined)?.map(s => (
                  <SelectItem key={s.id} value={String(s.id)}>{seasonLabel(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {editSeasonId != null && (
            <form onSubmit={handleSaveEditSeason} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="edit-season-organizer">Organizer</Label>
                  <Input id="edit-season-organizer" value={editSeasonData.organizer} onChange={e => setEditSeasonData({ ...editSeasonData, organizer: e.target.value })} className="bg-background text-foreground" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-season-name">League / Season Name</Label>
                  <Input id="edit-season-name" value={editSeasonData.name} onChange={e => setEditSeasonData({ ...editSeasonData, name: e.target.value })} required className="bg-background text-foreground" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="edit-season-year">Year</Label>
                  <Input id="edit-season-year" type="number" value={editSeasonData.year} onChange={e => setEditSeasonData({ ...editSeasonData, year: e.target.value })} required className="bg-background text-foreground" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-season-location">Location</Label>
                  <Input id="edit-season-location" value={editSeasonData.location} onChange={e => setEditSeasonData({ ...editSeasonData, location: e.target.value })} className="bg-background text-foreground" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="edit-season-start">Start Date</Label>
                  <Input id="edit-season-start" type="date" value={editSeasonData.start_date} onChange={e => setEditSeasonData({ ...editSeasonData, start_date: e.target.value })} className="bg-background text-foreground" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-season-end">End Date</Label>
                  <Input id="edit-season-end" type="date" value={editSeasonData.end_date} onChange={e => setEditSeasonData({ ...editSeasonData, end_date: e.target.value })} className="bg-background text-foreground" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-season-default-time">Default Game Start Time</Label>
                <Input id="edit-season-default-time" type="time" value={editSeasonData.default_game_time} onChange={e => setEditSeasonData({ ...editSeasonData, default_game_time: e.target.value })} className="bg-background text-foreground" />
              </div>
              <Button type="submit" disabled={savingSeason} className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                {savingSeason ? 'Saving…' : 'Save Changes'}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
