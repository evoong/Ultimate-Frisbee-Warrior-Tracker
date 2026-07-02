import { useEffect, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useGetSeasonRoster } from '../hooks/backend/players'
import { useGetGameEvents } from '../hooks/backend/events'
import { useCreateGoalEvent, useCreateOpponentGoalEvent, useDeleteEvent, useUpdateEvent, useGetEventTypes } from '../hooks/backend/events'
import { useCreatePlayerForGame, useDeleteSubPlayer, useGetPlayersNotInSeason, useAddPlayerToGame } from '../hooks/backend/players'
import { useGetAllSeasons, useGetSeasons } from '../hooks/backend/stats'
import { useGetGameAttendance, useSetAttendance, useSetAllAttendance } from '../hooks/backend/attendance'
import { getDefaultJamSeasonId } from '../lib/seasonUtils'
import { useAuth } from '../contexts/AuthContext'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Label } from '../lib/shadcn/label'
import PlayerCombobox from '../components/PlayerCombobox'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import { Target, Plus, Minus, TrendingUp, Undo2, Edit2, ChevronLeft, Trash2, Calendar, ArrowLeftRight, Users, ChevronDown, ChevronUp } from 'lucide-react'

type Season = { id: number; name: string; year: number; organizer: string | null; start_date: string | null; end_date: string | null }
type Game = { id: number; opponent: string; game_date: string; season_id: number | null }

function seasonLabel(s: Season) {
  const parts = [s.organizer, s.name, s.year].filter(Boolean)
  return parts.join(' ')
}

export default function QuickScore() {
  const { allowed } = useAuth()
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: seasonsWithGames, trigger: fetchSeasonsWithGames } = useGetSeasons()
  const { data: players, trigger: fetchPlayers } = useGetSeasonRoster()
  const { data: events, trigger: fetchEvents } = useGetGameEvents()
  const { trigger: createGoal } = useCreateGoalEvent()
  const { trigger: createOpponentGoal } = useCreateOpponentGoalEvent()
  const { trigger: deleteEvent } = useDeleteEvent()
  const { trigger: updateEvent } = useUpdateEvent()
  const { data: eventTypes, trigger: fetchEventTypes } = useGetEventTypes()
  const { trigger: createPlayerForGame } = useCreatePlayerForGame()
  const { trigger: deleteSubPlayer } = useDeleteSubPlayer()
  const { data: otherPlayers, trigger: fetchOtherPlayers } = useGetPlayersNotInSeason()
  const { trigger: addPlayerToGame } = useAddPlayerToGame()
  const { data: attendingIds, trigger: fetchAttendance } = useGetGameAttendance()
  const { trigger: setAttendance } = useSetAttendance()
  const { trigger: setAllAttendance } = useSetAllAttendance()

  const [selectedGameId, setSelectedGameId] = useState<number | null>(null)
  const [showGameSelect, setShowGameSelect] = useState(false)
  const [defaultScorerId, setDefaultScorerId] = useState<string>('')
  const [defaultAssisterId, setDefaultAssisterId] = useState<string>('')
  const [selectedEventType, setSelectedEventType] = useState<string>('Goal')
  const [editingEventId, setEditingEventId] = useState<number | null>(null)
  const [editScorerId, setEditScorerId] = useState<string>('')
  const [editAssisterId, setEditAssisterId] = useState<string>('')
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<number[]>([])
  const [showAttendance, setShowAttendance] = useState(false)

  useEffect(() => {
    fetchEventTypes()
    fetchAllSeasons()
    fetchSeasonsWithGames()
  }, [])

  useEffect(() => {
    // Fetch all games on mount, don't filter by season
    fetchGames()
  }, [])

  useEffect(() => {
    const seasons = allSeasons as Season[] | undefined
    const g = (games as Game[] | undefined) ?? []
    if (!seasons || seasons.length === 0 || g.length === 0) return
    if (selectedSeasonIds.length > 0) return

    const defaultId = getDefaultJamSeasonId(seasons, (seasonsWithGames as { id: number }[] | undefined)?.[0]?.id)
    if (defaultId == null) return
    setSelectedSeasonIds([defaultId])
    if (selectedGameId === null) {
      const today = new Date().toISOString().slice(0, 10)
      const seasonGames = g.filter(gm => gm.season_id === defaultId)
      const upcoming = seasonGames.slice().reverse().find(gm => gm.game_date >= today)
      const target = upcoming ?? seasonGames[0]
      if (target) setSelectedGameId(target.id)
    }
  }, [allSeasons, games, seasonsWithGames])

  useEffect(() => {
    // Wait for the default season to be chosen before auto-picking a game,
    // otherwise we'd grab the latest game across ALL seasons (e.g. RHUC)
    // before the Jam default above has had a chance to run.
    if (selectedSeasonIds.length === 0) return
    if (games && (games as Game[]).length > 0 && selectedGameId === null) {
      const g = games as Game[]
      const filtered = g.filter(gm => gm.season_id != null && selectedSeasonIds.includes(gm.season_id))
      if (filtered.length === 0) return
      const today = new Date().toISOString().slice(0, 10)
      const upcoming = filtered.slice().reverse().find(gm => gm.game_date >= today)
      setSelectedGameId((upcoming ?? filtered[0]!).id)
    }
  }, [games, selectedSeasonIds])

  useEffect(() => {
    if (selectedGameId) {
      fetchEvents({ gameId: selectedGameId })
      const allGames = (games as Game[] | undefined) ?? []
      const game = allGames.find(g => g.id === selectedGameId)
      if (game?.season_id) {
        fetchPlayers({ seasonId: game.season_id })
        fetchOtherPlayers({ seasonId: game.season_id })
      } else {
        fetchOtherPlayers({})
      }
      setShowGameSelect(false)
      fetchAttendance({ gameId: selectedGameId })
    }
  }, [selectedGameId, games])

  const allGames = (games as Game[] | undefined) ?? []
  const filteredGames = selectedSeasonIds.length > 0
    ? allGames.filter(g => g.season_id != null && selectedSeasonIds.includes(g.season_id))
    : allGames

  const selectedGame = (games as Game[] | undefined)?.find(g => g.id === selectedGameId)
  const ourGoals = events?.filter((e: { event_type: string }) => e.event_type === 'Goal').length || 0
  const theirGoals = events?.filter((e: { event_type: string }) => e.event_type === 'Opponent Goal').length || 0

  const resolvePlayerId = (id: string) =>
    (id && id !== '__none__' && id !== '__opponent__') ? parseInt(id) : null

  const handleQuickGoal = async () => {
    if (!selectedGameId) return
    await createGoal({
      gameId: selectedGameId,
      playerId: resolvePlayerId(defaultScorerId),
      relatedPlayerId: resolvePlayerId(defaultAssisterId),
      eventType: selectedEventType
    })
    fetchEvents({ gameId: selectedGameId })
  }

  const handleOpponentGoal = async () => {
    if (!selectedGameId) return
    await createOpponentGoal({ gameId: selectedGameId })
    fetchEvents({ gameId: selectedGameId })
  }

  const handleUndo = async () => {
    if (!events || events.length === 0) return
    const lastEvent = events[0]
    await deleteEvent({ eventId: lastEvent.id })
    if (selectedGameId) fetchEvents({ gameId: selectedGameId })
  }

  const handleEditEvent = (event: { id: number; player_id: number | null; related_player_id: number | null }) => {
    setEditingEventId(event.id)
    setEditScorerId(event.player_id ? event.player_id.toString() : '__none__')
    setEditAssisterId(event.related_player_id ? event.related_player_id.toString() : '__none__')
  }

  const handleSaveEdit = async () => {
    if (!editingEventId) return
    await updateEvent({
      eventId: editingEventId,
      playerId: (editScorerId && editScorerId !== '__none__') ? parseInt(editScorerId) : null,
      relatedPlayerId: (editAssisterId && editAssisterId !== '__none__') ? parseInt(editAssisterId) : null
    })
    setEditingEventId(null)
    if (selectedGameId) fetchEvents({ gameId: selectedGameId })
  }

  const handleDeleteEvent = async (eventId: number) => {
    await deleteEvent({ eventId })
    if (selectedGameId) fetchEvents({ gameId: selectedGameId })
  }

  const handleBackToGameSelect = () => {
    setShowGameSelect(true)
    setSelectedGameId(null)
  }

  const isGoalEvent = ['Goal', 'Caught OB'].includes(selectedEventType)
  const scorerLabel = isGoalEvent ? 'Scorer' : 'Player'
  const assisterLabel = isGoalEvent ? 'Assister' : 'Related'

  const playerOptions = [
    { id: '__opponent__', label: 'Opponent' },
    ...((players as { id: number; display_name: string; is_sub: boolean | null }[] | undefined) ?? []).map(p => ({ id: p.id.toString(), label: p.display_name, isSub: !!p.is_sub }))
  ]

  const otherPlayerOptions = ((otherPlayers as { id: number; display_name: string }[] | undefined) ?? [])
    .map(p => ({ id: p.id.toString(), label: p.display_name }))

  const handleAddPlayer = async (name: string) => {
    if (!selectedGameId) return
    const result = await createPlayerForGame({ displayName: name, gameId: selectedGameId })
    if (result) {
      await fetchPlayers({ gameId: selectedGameId })
      await fetchOtherPlayers({ gameId: selectedGameId })
      const newId = (result as { id: number }).id.toString()
      setDefaultScorerId(newId)
    }
  }

  const handleDeleteSub = async (playerId: string) => {
    if (!selectedGameId) return
    await deleteSubPlayer({ playerId: parseInt(playerId), gameId: selectedGameId })
    await fetchPlayers({ gameId: selectedGameId })
    await fetchOtherPlayers({ gameId: selectedGameId })
    if (defaultScorerId === playerId) setDefaultScorerId('')
    if (defaultAssisterId === playerId) setDefaultAssisterId('')
    if (editScorerId === playerId) setEditScorerId('')
    if (editAssisterId === playerId) setEditAssisterId('')
  }

  const handleAddAssister = async (name: string) => {
    if (!selectedGameId) return
    const result = await createPlayerForGame({ displayName: name, gameId: selectedGameId })
    if (result) {
      await fetchPlayers({ gameId: selectedGameId })
      await fetchOtherPlayers({ gameId: selectedGameId })
      const newId = (result as { id: number }).id.toString()
      setDefaultAssisterId(newId)
    }
  }

  const handleAddExistingScorer = async (playerId: string) => {
    if (!selectedGameId) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedGameId })
    await fetchPlayers({ gameId: selectedGameId })
    await fetchOtherPlayers({ gameId: selectedGameId })
    setDefaultScorerId(playerId)
  }

  const handleAddExistingAssister = async (playerId: string) => {
    if (!selectedGameId) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedGameId })
    await fetchPlayers({ gameId: selectedGameId })
    await fetchOtherPlayers({ gameId: selectedGameId })
    setDefaultAssisterId(playerId)
  }

  const getSeasonLabel = (seasonId: number | null) => {
    if (!seasonId || !allSeasons) return null
    const s = (allSeasons as Season[]).find(s => s.id === seasonId)
    return s ? seasonLabel(s) : null
  }

  return (
    <div className="space-y-4">
      {games === undefined ? (
        // Primary data (games) has not resolved yet. Render placeholders shaped
        // like the eventual scoreboard and event list so the page does not flash
        // blank or jump when the first fetch lands.
        <>
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
            <CardContent className="py-4 px-5">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center">
                <div className="min-w-0 space-y-2">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <div className="flex items-center gap-3 px-4">
                  <Skeleton className="h-16 w-14" />
                  <div className="text-3xl font-light text-muted-foreground">-</div>
                  <Skeleton className="h-16 w-14" />
                </div>
                <div />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-4 w-16" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                    <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                    <Skeleton className="h-6 w-6 flex-shrink-0" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
      <>
      {selectedGame && !showGameSelect && (
        <button
          onClick={handleBackToGameSelect}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
          <span className="text-sm font-medium">Change Game</span>
        </button>
      )}

      {!selectedGame || showGameSelect ? (
        <>
          <h1 className="text-2xl font-bold text-foreground">Quick Score</h1>

          {/* Season Filter */}
          <SeasonMultiSelect
            seasons={(allSeasons as Season[] | undefined) ?? []}
            selectedIds={selectedSeasonIds}
            onChange={setSelectedSeasonIds}
            placeholder="All Seasons"
          />

          {/* Game Selection */}
          <div>
            <h2 className="text-lg font-semibold text-foreground mb-3">Select Game</h2>
            <div className="grid grid-cols-1 gap-2 max-h-96 overflow-y-auto">
              {filteredGames.map((game) => (
                <button
                  key={game.id}
                  onClick={() => setSelectedGameId(game.id)}
                  className={`p-3 rounded-lg border transition-all text-left ${
                    selectedGameId === game.id
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border hover:bg-accent hover:border-primary/50'
                  }`}
                >
                  <div className="font-medium">vs {game.opponent}</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {new Date(game.game_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    {game.season_id && getSeasonLabel(game.season_id) ? ` • ${getSeasonLabel(game.season_id)}` : ''}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Live Scoreboard */}
          <FadeIn>
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
            <CardContent className="py-4 px-5">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center">
                <div className="min-w-0">
                  <div className="text-base font-bold text-foreground truncate">vs {selectedGame.opponent}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                    <Calendar className="w-3 h-3 flex-shrink-0" />
                    <span>{new Date((selectedGame as { game_date: string }).game_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                  </div>
                  {selectedGame.season_id && (
                    <div className="text-xs text-muted-foreground mt-0.5">{getSeasonLabel(selectedGame.season_id)}</div>
                  )}
                </div>

                <div className="flex items-center gap-3 px-4">
                  <div className="text-center">
                    <div className="text-7xl font-bold text-primary tabular-nums leading-none">{ourGoals}</div>
                    <div className="text-xs text-muted-foreground mt-1">Us</div>
                  </div>
                  <div className="text-3xl font-light text-muted-foreground">-</div>
                  <div className="text-center">
                    <div className="text-7xl font-bold text-muted-foreground tabular-nums leading-none">{theirGoals}</div>
                    <div className="text-xs text-muted-foreground mt-1">Them</div>
                  </div>
                </div>

                <div />
              </div>
            </CardContent>
          </Card>
          </FadeIn>

          {/* Attendance */}
          {players && (players as any[]).length > 0 && (
            <Card className="bg-card border-border">
              <button
                className="w-full flex items-center justify-between px-5 py-3"
                onClick={() => setShowAttendance(v => !v)}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  <span>Attendance</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    {attendingIds ? `${(attendingIds as { player_id: number; in: boolean }[]).filter(r => r.in).length} / ${(players as any[]).length}` : '…'}
                  </span>
                </div>
                {showAttendance ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
              </button>
              {showAttendance && (
                <CardContent className="pt-0 pb-3 px-5 space-y-2">
                  {allowed && (
                    <div className="flex justify-end">
                      <button
                        className="text-xs text-muted-foreground hover:text-foreground underline"
                        onClick={async () => {
                          const allIds = (players as { id: number }[]).map(p => p.id)
                          await setAllAttendance({ gameId: selectedGameId!, attending: false, playerIds: allIds })
                          fetchAttendance({ gameId: selectedGameId! })
                        }}
                      >
                        Unselect all
                      </button>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {(players as { id: number; display_name: string; is_sub: boolean | null }[]).map(p => {
                      const row = (attendingIds as { player_id: number; in: boolean }[] | undefined)?.find(r => r.player_id === p.id)
                      const attending = row?.in ?? true
                      return (
                        <label key={p.id} className={`flex items-center gap-2 py-1 select-none ${allowed ? 'cursor-pointer' : 'cursor-default'}`}>
                          <input
                            type="checkbox"
                            checked={attending}
                            disabled={!allowed}
                            onChange={async e => {
                              await setAttendance({ gameId: selectedGameId!, playerId: p.id, attending: e.target.checked })
                              fetchAttendance({ gameId: selectedGameId! })
                            }}
                            className="accent-primary w-4 h-4 rounded disabled:opacity-60"
                          />
                          <span className={`text-sm ${attending ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                            {p.display_name}{p.is_sub ? ' ·' : ''}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </CardContent>
              )}
            </Card>
          )}

          {/* Controls */}
          {allowed && (
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-4 space-y-3">
              <div className="space-y-2">
                <div className="grid grid-cols-[60px_1fr] items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground text-right">Event</span>
                  <Select value={selectedEventType} onValueChange={setSelectedEventType}>
                    <SelectTrigger className="h-9 text-sm bg-background text-foreground border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(eventTypes as { id: number; name: string; category: string }[] | undefined)?.map(et => (
                        <SelectItem key={et.id} value={et.name}>{et.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-[60px_1fr] items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground text-right">{scorerLabel}</span>
                  <PlayerCombobox
                    players={playerOptions}
                    otherPlayers={otherPlayerOptions}
                    value={defaultScorerId || '__none__'}
                    onValueChange={setDefaultScorerId}
                    onAddPlayer={handleAddPlayer}
                    onAddExistingPlayer={handleAddExistingScorer}
                    onDeletePlayer={handleDeleteSub}
                    placeholder="None"
                    className="w-full h-9 text-sm bg-background border-border"
                  />
                </div>

                <div className="flex items-center justify-center">
                  <button
                    onClick={() => {
                      const tmp = defaultScorerId
                      setDefaultScorerId(defaultAssisterId)
                      setDefaultAssisterId(tmp)
                    }}
                    title={`Swap ${scorerLabel} ↔ ${assisterLabel}`}
                    aria-label="Swap scorer and assister"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded hover:bg-accent"
                  >
                    <ArrowLeftRight className="w-3 h-3" />
                    <span>swap</span>
                  </button>
                </div>

                <div className="grid grid-cols-[60px_1fr] items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground text-right">{assisterLabel}</span>
                  <PlayerCombobox
                    players={playerOptions}
                    otherPlayers={otherPlayerOptions}
                    value={defaultAssisterId || '__none__'}
                    onValueChange={setDefaultAssisterId}
                    onAddPlayer={handleAddAssister}
                    onAddExistingPlayer={handleAddExistingAssister}
                    onDeletePlayer={handleDeleteSub}
                    placeholder="None"
                    className="w-full h-9 text-sm bg-background border-border"
                  />
                </div>
              </div>

              <div className="border-t border-border" />

              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={handleQuickGoal}
                  className="h-14 font-bold bg-green-600 hover:bg-green-700 text-white dark:bg-green-700 dark:hover:bg-green-600 flex flex-col items-center justify-center gap-0.5"
                >
                  <div className="flex items-center gap-1">
                    <Plus className="w-4 h-4" />
                    <span className="text-sm">{selectedEventType}</span>
                  </div>
                  {defaultScorerId && defaultScorerId !== '__none__' && (
                    <span className="text-xs font-normal opacity-90 truncate max-w-full px-2">
                      {playerOptions.find(p => p.id === defaultScorerId)?.label ?? 'Opponent'}
                    </span>
                  )}
                </Button>

                <Button
                  onClick={handleOpponentGoal}
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
                disabled={!events || events.length === 0}
                variant="outline"
                className="w-full h-8 text-xs font-medium text-muted-foreground hover:text-foreground flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                <Undo2 className="w-3.5 h-3.5" />
                Undo last event
              </Button>
            </CardContent>
          </Card>
          )}

          {/* Recent Events */}
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                <span>Recent Activity</span>
                <span className="text-sm font-normal text-muted-foreground">{events?.length || 0} events</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {events && events.length > 0 ? (
                  events.slice(0, 8).map((event: { id: number; event_type: string; event_timestamp: string; player_id: number | null; related_player_id: number | null }, index: number) => {
                    const player = players?.find((p: { id: number }) => p.id === event.player_id)
                    const assister = players?.find((p: { id: number }) => p.id === event.related_player_id)
                    const isGoal = event.event_type === 'Goal'
                    const isOpponentGoal = event.event_type === 'Opponent Goal'
                    return (
                      <FadeIn key={event.id} delay={index * 40} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          isGoal ? 'bg-green-100 dark:bg-green-950'
                          : isOpponentGoal ? 'bg-red-100 dark:bg-red-950'
                          : 'bg-orange-100 dark:bg-orange-950'
                        }`}>
                          {isGoal ? <Target className="w-5 h-5 text-green-600 dark:text-green-400" />
                          : isOpponentGoal ? <Target className="w-5 h-5 text-red-600 dark:text-red-400" />
                          : <TrendingUp className="w-5 h-5 text-orange-600 dark:text-orange-400" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-foreground text-sm">
                            {isGoal && player && (<>{player.display_name}{assister && <span className="text-xs text-muted-foreground ml-1">(from {assister.display_name})</span>}</>)}
                            {isGoal && !player && 'Our Goal'}
                            {isOpponentGoal && 'Opponent Goal'}
                            {!isGoal && !isOpponentGoal && event.event_type}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(event.event_timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {allowed && (isGoal || !isOpponentGoal) && (
                            <button onClick={() => handleEditEvent(event)} className="p-1.5 rounded hover:bg-accent transition-colors" aria-label="Edit event">
                              <Edit2 className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                            </button>
                          )}
                          {allowed && (
                            <button onClick={() => handleDeleteEvent(event.id)} className="p-1.5 rounded hover:bg-destructive/10 transition-colors" aria-label="Delete event">
                              <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                            </button>
                          )}
                          <div className={`text-lg font-bold tabular-nums ml-1 ${isGoal ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {isGoal || isOpponentGoal ? '+1' : ''}
                          </div>
                        </div>
                      </FadeIn>
                    )
                  })
                ) : (
                  <div className="text-center text-muted-foreground py-8 text-sm">No events yet - start scoring!</div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
      </>
      )}

      {/* Edit Event Dialog */}
      <Dialog open={editingEventId !== null} onOpenChange={(open) => !open && setEditingEventId(null)}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>Edit Event</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Scorer / Player</Label>
              <PlayerCombobox
                players={playerOptions}
                value={editScorerId || '__none__'}
                onValueChange={setEditScorerId}
                placeholder="Select scorer..."
                className="w-full bg-background border-border"
              />
            </div>
            <div className="space-y-2">
              <Label>Assister / Related (optional)</Label>
              <PlayerCombobox
                players={playerOptions}
                otherPlayers={otherPlayerOptions}
                value={editAssisterId || '__none__'}
                onValueChange={setEditAssisterId}
                onAddExistingPlayer={handleAddExistingAssister}
                placeholder="Select assister..."
                className="w-full bg-background border-border"
              />
            </div>
            <Button onClick={handleSaveEdit} className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
