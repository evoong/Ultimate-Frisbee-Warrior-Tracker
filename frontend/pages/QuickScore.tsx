import { useEffect, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useGetSeasonRoster } from '../hooks/backend/players'
import { useGetGameEvents } from '../hooks/backend/events'
import { useCreateGoalEvent, useCreateOpponentGoalEvent, useDeleteEvent, useUpdateEvent, useGetEventTypes } from '../hooks/backend/events'
import { useCreatePlayerForGame, useDeleteSubPlayer } from '../hooks/backend/players'
import { useGetAllSeasons } from '../hooks/backend/stats'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Label } from '../lib/shadcn/label'
import PlayerCombobox from '../components/PlayerCombobox'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Target, Plus, Minus, TrendingUp, Undo2, Edit2, ChevronLeft, Trash2, Calendar, ArrowLeftRight } from 'lucide-react'

type Season = { id: number; name: string; year: number; organizer: string | null }
type Game = { id: number; opponent: string; game_date: string; season_id: number | null }

function seasonLabel(s: Season) {
  const parts = [s.organizer, s.name, s.year].filter(Boolean)
  return parts.join(' ')
}

export default function QuickScore() {
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: players, trigger: fetchPlayers } = useGetSeasonRoster()
  const { data: events, trigger: fetchEvents } = useGetGameEvents()
  const { trigger: createGoal } = useCreateGoalEvent()
  const { trigger: createOpponentGoal } = useCreateOpponentGoalEvent()
  const { trigger: deleteEvent } = useDeleteEvent()
  const { trigger: updateEvent } = useUpdateEvent()
  const { data: eventTypes, trigger: fetchEventTypes } = useGetEventTypes()
  const { trigger: createPlayerForGame } = useCreatePlayerForGame()
  const { trigger: deleteSubPlayer } = useDeleteSubPlayer()

  const [selectedGameId, setSelectedGameId] = useState<number | null>(null)
  const [showGameSelect, setShowGameSelect] = useState(false)
  const [defaultScorerId, setDefaultScorerId] = useState<string>('')
  const [defaultAssisterId, setDefaultAssisterId] = useState<string>('')
  const [selectedEventType, setSelectedEventType] = useState<string>('Goal')
  const [editingEventId, setEditingEventId] = useState<number | null>(null)
  const [editScorerId, setEditScorerId] = useState<string>('')
  const [editAssisterId, setEditAssisterId] = useState<string>('')
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<number[]>([])

  useEffect(() => {
    fetchGames()
    fetchEventTypes()
    fetchAllSeasons()
  }, [])

  useEffect(() => {
    fetchGames({ seasonIds: selectedSeasonIds.length > 0 ? selectedSeasonIds : undefined })
    setSelectedGameId(null)
  }, [selectedSeasonIds])

  useEffect(() => {
    if (games && (games as Game[]).length > 0 && selectedGameId === null) {
      const g = games as Game[]
      if (g.length > 0) setSelectedGameId(g[0]!.id)
    }
  }, [games])

  useEffect(() => {
    if (selectedGameId) {
      fetchEvents({ gameId: selectedGameId })
      fetchPlayers({ gameId: selectedGameId })
      setShowGameSelect(false)
    }
  }, [selectedGameId])

  const filteredGames = (games as Game[] | undefined) ?? []

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
    { id: '__opponent__', label: '— Opponent —' },
    ...((players as { id: number; display_name: string; is_sub: boolean | null }[] | undefined) ?? []).map(p => ({ id: p.id.toString(), label: p.display_name, isSub: !!p.is_sub }))
  ]

  const handleAddPlayer = async (name: string) => {
    if (!selectedGameId) return
    const result = await createPlayerForGame({ displayName: name, gameId: selectedGameId })
    if (result) {
      await fetchPlayers({ gameId: selectedGameId })
      const newId = (result as { id: number }).id.toString()
      setDefaultScorerId(newId)
    }
  }

  const handleDeleteSub = async (playerId: string) => {
    if (!selectedGameId) return
    await deleteSubPlayer({ playerId: parseInt(playerId), gameId: selectedGameId })
    await fetchPlayers({ gameId: selectedGameId })
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
      const newId = (result as { id: number }).id.toString()
      setDefaultAssisterId(newId)
    }
  }

  const getSeasonLabel = (seasonId: number | null) => {
    if (!seasonId || !allSeasons) return null
    const s = (allSeasons as Season[]).find(s => s.id === seasonId)
    return s ? seasonLabel(s) : null
  }

  return (
    <div className="space-y-4">
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
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base">Select Game</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Select value={selectedGameId?.toString() || ''} onValueChange={(val) => setSelectedGameId(parseInt(val))}>
                <SelectTrigger className="bg-background text-foreground border-border">
                  <SelectValue placeholder="Choose a game..." />
                </SelectTrigger>
                <SelectContent>
                  {filteredGames.map((game) => (
                    <SelectItem key={game.id} value={game.id.toString()}>
                      vs {game.opponent} - {new Date(game.game_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {game.season_id && getSeasonLabel(game.season_id) ? ` (${getSeasonLabel(game.season_id)})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          {/* Live Scoreboard */}
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

          {/* Controls */}
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
                    value={defaultScorerId || '__none__'}
                    onValueChange={setDefaultScorerId}
                    onAddPlayer={handleAddPlayer}
                    onDeletePlayer={handleDeleteSub}
                    placeholder="None"
                    className="w-full h-9 text-sm bg-background border-border"
                  />
                </div>

                <div className="grid grid-cols-[60px_1fr] items-center gap-2">
                  <button
                    onClick={() => {
                      const tmp = defaultScorerId
                      setDefaultScorerId(defaultAssisterId)
                      setDefaultAssisterId(tmp)
                    }}
                    title={`Swap ${scorerLabel} ↔ ${assisterLabel}`}
                    className="flex flex-col items-end gap-0.5 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Swap scorer and assister"
                  >
                    <span className="text-xs font-medium">{assisterLabel}</span>
                    <ArrowLeftRight className="w-3 h-3" />
                  </button>
                  <PlayerCombobox
                    players={playerOptions}
                    value={defaultAssisterId || '__none__'}
                    onValueChange={setDefaultAssisterId}
                    onAddPlayer={handleAddAssister}
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
                  events.slice(0, 8).map((event: { id: number; event_type: string; event_timestamp: string; player_id: number | null; related_player_id: number | null }) => {
                    const player = players?.find((p: { id: number }) => p.id === event.player_id)
                    const assister = players?.find((p: { id: number }) => p.id === event.related_player_id)
                    const isGoal = event.event_type === 'Goal'
                    const isOpponentGoal = event.event_type === 'Opponent Goal'
                    return (
                      <div key={event.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
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
                          {(isGoal || !isOpponentGoal) && (
                            <button onClick={() => handleEditEvent(event)} className="p-1.5 rounded hover:bg-accent transition-colors" aria-label="Edit event">
                              <Edit2 className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                            </button>
                          )}
                          <button onClick={() => handleDeleteEvent(event.id)} className="p-1.5 rounded hover:bg-destructive/10 transition-colors" aria-label="Delete event">
                            <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                          </button>
                          <div className={`text-lg font-bold tabular-nums ml-1 ${isGoal ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {isGoal || isOpponentGoal ? '+1' : ''}
                          </div>
                        </div>
                      </div>
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

      {!selectedGame && showGameSelect && (
        <Card className="bg-card text-card-foreground border-border">
          <CardContent className="py-12 text-center">
            <Target className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-50" />
            <p className="text-muted-foreground">Select a game to start quick scoring</p>
          </CardContent>
        </Card>
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
                value={editAssisterId || '__none__'}
                onValueChange={setEditAssisterId}
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
