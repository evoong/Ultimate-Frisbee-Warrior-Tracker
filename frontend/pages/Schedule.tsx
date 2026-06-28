import { useEffect, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useCreateGame } from '../hooks/backend/games'
import { useGetGameEvents } from '../hooks/backend/events'
import { useGetPlayers } from '../hooks/backend/players'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../lib/shadcn/dialog'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Calendar, Plus, Trophy, ChevronLeft, ChevronRight, Target, TrendingUp } from 'lucide-react'

type Game = {
  id: number
  opponent: string
  game_date: string
  game_time: string
  game_type: string
  our_score: number
  their_score: number
  result: string
  notes: string
}

type GameEvent = {
  id: number
  event_type: string
  event_timestamp: string
  player_id: number | null
  related_player_id: number | null
}

type Player = {
  id: number
  display_name: string
}

export default function Schedule() {
  const { data: games, loading, error, trigger: fetchGames } = useGetGames()
  const { data: events, loading: eventsLoading, trigger: fetchEvents } = useGetGameEvents()
  const { data: players, trigger: fetchPlayers } = useGetPlayers()
  const { trigger: createGame } = useCreateGame()

  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [selectedGame, setSelectedGame] = useState<Game | null>(null)
  const [formData, setFormData] = useState({
    opponent: '',
    game_date: '',
    game_time: '',
    game_type: 'Regular'
  })

  useEffect(() => {
    fetchGames()
    fetchPlayers()
  }, [])

  const handleSelectGame = (game: Game) => {
    setSelectedGame(game)
    fetchEvents({ gameId: game.id })
  }

  const handleBack = () => {
    setSelectedGame(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await createGame(formData)
    setIsDialogOpen(false)
    setFormData({ opponent: '', game_date: '', game_time: '', game_type: 'Regular' })
    fetchGames()
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr + 'T00:00:00')
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }

  const formatTime = (timeStr: string) => {
    const [hours, minutes] = timeStr.split(':')
    const hour = parseInt(hours || '0')
    const ampm = hour >= 12 ? 'PM' : 'AM'
    const displayHour = hour % 12 || 12
    return `${displayHour}:${minutes || '00'} ${ampm}`
  }

  const formatTimestamp = (ts: string) => {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  const getPlayerName = (id: number | null) =>
    id ? (players as Player[] | undefined)?.find((p) => p.id === id)?.display_name ?? null : null

  // --- Game Detail View ---
  if (selectedGame) {
    const ourGoals = (events as GameEvent[] | undefined)?.filter(e => e.event_type === 'Goal').length ?? 0
    const theirGoals = (events as GameEvent[] | undefined)?.filter(e => e.event_type === 'Opponent Goal').length ?? 0

    // Group goals, assists, turnovers per player
    const playerMap: Record<number, { name: string; goals: number; assists: number; turnovers: number }> = {}
    const ensurePlayer = (id: number, name: string) => {
      if (!playerMap[id]) playerMap[id] = { name, goals: 0, assists: 0, turnovers: 0 }
    }

    ;(events as GameEvent[] | undefined)?.forEach(e => {
      const scorerName = getPlayerName(e.player_id)
      const assisterName = getPlayerName(e.related_player_id)
      if (e.event_type === 'Goal') {
        if (e.player_id && scorerName) {
          ensurePlayer(e.player_id, scorerName)
          playerMap[e.player_id]!.goals++
        }
        if (e.related_player_id && assisterName) {
          ensurePlayer(e.related_player_id, assisterName)
          playerMap[e.related_player_id]!.assists++
        }
      } else if (e.event_type === 'Turnover') {
        if (e.player_id && scorerName) {
          ensurePlayer(e.player_id, scorerName)
          playerMap[e.player_id]!.turnovers++
        }
      }
    })

    const playerStats = Object.values(playerMap).sort((a, b) => b.goals - a.goals || b.assists - a.assists)

    return (
      <div className="space-y-4">
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
          <span className="text-sm font-medium">Back to Schedule</span>
        </button>

        {/* Game Header */}
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

            {selectedGame.result && (
              <div className={`text-center mt-4 text-sm font-semibold ${
                selectedGame.result.startsWith('Win')
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}>
                {selectedGame.result}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Player Box Scores */}
        {playerStats.length > 0 && (
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base">Box Score</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {/* Header */}
                <div className="flex items-center gap-3 px-3 text-xs text-muted-foreground font-medium">
                  <div className="flex-1">Player</div>
                  <div className="w-10 text-center text-green-600 dark:text-green-400">G</div>
                  <div className="w-10 text-center text-blue-600 dark:text-blue-400">A</div>
                  <div className="w-10 text-center text-orange-600 dark:text-orange-400">TO</div>
                </div>
                {playerStats.map((p) => (
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

        {/* Event Log */}
        <Card className="bg-card text-card-foreground border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>Event Log</span>
              <span className="text-sm font-normal text-muted-foreground">
                {(events as GameEvent[] | undefined)?.length ?? 0} events
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {eventsLoading ? (
              <div className="text-center py-8 text-muted-foreground text-sm">Loading events...</div>
            ) : (events as GameEvent[] | undefined)?.length ? (
              <div className="space-y-0">
                {(events as GameEvent[]).map((event, i) => {
                  const scorer = getPlayerName(event.player_id)
                  const assister = getPlayerName(event.related_player_id)
                  const isGoal = event.event_type === 'Goal'
                  const isOpponentGoal = event.event_type === 'Opponent Goal'
                  const isTurnover = event.event_type === 'Turnover'

                  return (
                    <div key={event.id} className="flex items-center gap-3 py-2.5 border-b border-border last:border-0">
                      <div className="w-6 text-xs text-muted-foreground text-center tabular-nums">{i + 1}</div>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isGoal ? 'bg-green-100 dark:bg-green-950'
                        : isOpponentGoal ? 'bg-red-100 dark:bg-red-950'
                        : 'bg-orange-100 dark:bg-orange-950'
                      }`}>
                        {isGoal && <Target className="w-4 h-4 text-green-600 dark:text-green-400" />}
                        {isOpponentGoal && <Target className="w-4 h-4 text-red-600 dark:text-red-400" />}
                        {isTurnover && <TrendingUp className="w-4 h-4 text-orange-600 dark:text-orange-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground">
                          {isGoal && (
                            <>
                              {scorer ?? 'Unknown'} scored
                              {assister && <span className="text-muted-foreground font-normal"> (from {assister})</span>}
                            </>
                          )}
                          {isOpponentGoal && 'Opponent goal'}
                          {isTurnover && <>{scorer ?? 'Unknown'} turned it over</>}
                          {!isGoal && !isOpponentGoal && !isTurnover && event.event_type}
                        </div>
                        <div className="text-xs text-muted-foreground">{formatTimestamp(event.event_timestamp)}</div>
                      </div>
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
      </div>
    )
  }

  // --- Schedule List View ---
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading games...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-destructive">Error: {error}</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-4 h-4 mr-2" />
              Add Game
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card text-card-foreground">
            <DialogHeader>
              <DialogTitle>Schedule New Game</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="opponent">Opponent</Label>
                <Input
                  id="opponent"
                  value={formData.opponent}
                  onChange={(e) => setFormData({ ...formData, opponent: e.target.value })}
                  required
                  className="bg-background text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="game_date">Date</Label>
                <Input
                  id="game_date"
                  type="date"
                  value={formData.game_date}
                  onChange={(e) => setFormData({ ...formData, game_date: e.target.value })}
                  required
                  className="bg-background text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="game_time">Time</Label>
                <Input
                  id="game_time"
                  type="time"
                  value={formData.game_time}
                  onChange={(e) => setFormData({ ...formData, game_time: e.target.value })}
                  required
                  className="bg-background text-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="game_type">Game Type</Label>
                <Select value={formData.game_type} onValueChange={(value) => setFormData({ ...formData, game_type: value })}>
                  <SelectTrigger className="bg-background text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Regular">Regular</SelectItem>
                    <SelectItem value="Playoff">Playoff</SelectItem>
                    <SelectItem value="Tournament">Tournament</SelectItem>
                    <SelectItem value="Friendly">Friendly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Create Game
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {games?.map((game: Game) => (
          <Card
            key={game.id}
            onClick={() => handleSelectGame(game)}
            className="bg-card text-card-foreground border-border cursor-pointer hover:bg-accent/50 active:scale-[0.99] transition-all"
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <CardTitle className="text-lg font-bold text-foreground">
                    vs {game.opponent}
                  </CardTitle>
                  <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                    <Calendar className="w-4 h-4" />
                    <span>{formatDate(game.game_date)}</span>
                    <span>•</span>
                    <span>{formatTime(game.game_time)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {game.game_type === 'Playoff' && (
                    <Trophy className="w-5 h-5 text-yellow-500 dark:text-yellow-400" />
                  )}
                  <div className={`px-2 py-1 rounded text-xs font-semibold ${
                    game.game_type === 'Playoff'
                      ? 'bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-100'
                      : 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100'
                  }`}>
                    {game.game_type}
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="text-3xl font-bold">
                  <span className="text-primary">{game.our_score}</span>
                  <span className="text-muted-foreground mx-2">-</span>
                  <span className="text-muted-foreground">{game.their_score}</span>
                </div>
                {game.result && (
                  <div className={`text-sm font-medium ${
                    game.result.startsWith('Win')
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}>
                    {game.result}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
