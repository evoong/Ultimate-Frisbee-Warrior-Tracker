import { useEffect, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useGetSeasonRoster } from '../hooks/backend/players'
import { useGetGameEvents } from '../hooks/backend/events'
import { useCreateGoalEvent, useCreateOpponentGoalEvent, useCreateTurnoverEvent } from '../hooks/backend/events'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Label } from '../lib/shadcn/label'
import { Target, TrendingUp, AlertCircle } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

export default function Tracker() {
  const { allowed } = useAuth()
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: players, trigger: fetchPlayers } = useGetSeasonRoster()
  const { data: events, trigger: fetchEvents } = useGetGameEvents()
  const { trigger: createGoal } = useCreateGoalEvent()
  const { trigger: createOpponentGoal } = useCreateOpponentGoalEvent()
  const { trigger: createTurnover } = useCreateTurnoverEvent()

  const [selectedGameId, setSelectedGameId] = useState<number | null>(null)
  const [dialogType, setDialogType] = useState<'goal' | 'turnover' | null>(null)
  const [scorerId, setScorerId] = useState<string>('')
  const [assisterId, setAssisterId] = useState<string>('')
  const [turnoverId, setTurnoverId] = useState<string>('')

  useEffect(() => {
    fetchGames()
  }, [])

  useEffect(() => {
    if (selectedGameId) {
      fetchEvents({ gameId: selectedGameId })
      fetchPlayers({ gameId: selectedGameId })
    }
  }, [selectedGameId])

  const selectedGame = games?.find((g: { id: number }) => g.id === selectedGameId)

  const ourGoals = events?.filter((e: { event_type: string }) => e.event_type === 'Goal').length || 0
  const theirGoals = events?.filter((e: { event_type: string }) => e.event_type === 'Opponent Goal').length || 0

  const handleGoal = async () => {
    if (!selectedGameId || !scorerId) return
    await createGoal({
      gameId: selectedGameId,
      playerId: parseInt(scorerId),
      relatedPlayerId: assisterId ? parseInt(assisterId) : null
    })
    setDialogType(null)
    setScorerId('')
    setAssisterId('')
    fetchEvents({ gameId: selectedGameId })
  }

  const handleOpponentGoal = async () => {
    if (!selectedGameId) return
    await createOpponentGoal({ gameId: selectedGameId })
    fetchEvents({ gameId: selectedGameId })
  }

  const handleTurnover = async () => {
    if (!selectedGameId || !turnoverId) return
    await createTurnover({
      gameId: selectedGameId,
      playerId: parseInt(turnoverId)
    })
    setDialogType(null)
    setTurnoverId('')
    fetchEvents({ gameId: selectedGameId })
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Game Tracker</h1>

      <div className="space-y-2">
        <Label>Select Game to Track</Label>
        <Select value={selectedGameId?.toString() || ''} onValueChange={(val) => setSelectedGameId(parseInt(val))}>
          <SelectTrigger className="bg-card text-card-foreground border-border">
            <SelectValue placeholder="Choose a game..." />
          </SelectTrigger>
          <SelectContent>
            {games?.map((game: { id: number; opponent: string; game_date: string; game_time: string }) => (
              <SelectItem key={game.id} value={game.id.toString()}>
                vs {game.opponent} - {new Date(game.game_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedGame && (
        <>
          {/* Scoreboard */}
          <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
            <CardHeader>
              <CardTitle className="text-center text-lg text-muted-foreground">
                vs {selectedGame.opponent}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-center gap-8">
                <div className="text-center">
                  <div className="text-6xl font-bold text-primary">{ourGoals}</div>
                  <div className="text-sm text-muted-foreground mt-1">Us</div>
                </div>
                <div className="text-4xl font-light text-muted-foreground">-</div>
                <div className="text-center">
                  <div className="text-6xl font-bold text-muted-foreground">{theirGoals}</div>
                  <div className="text-sm text-muted-foreground mt-1">Them</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          {allowed && (
          <div className="grid grid-cols-1 gap-3">
            <Button
              onClick={() => setDialogType('goal')}
              className="h-20 text-lg font-semibold bg-green-600 hover:bg-green-700 text-white dark:bg-green-700 dark:hover:bg-green-600"
            >
              <Target className="w-6 h-6 mr-2" />
              Our Goal
            </Button>
            <Button
              onClick={handleOpponentGoal}
              className="h-20 text-lg font-semibold bg-red-600 hover:bg-red-700 text-white dark:bg-red-700 dark:hover:bg-red-600"
            >
              <AlertCircle className="w-6 h-6 mr-2" />
              Opponent Goal
            </Button>
            <Button
              onClick={() => setDialogType('turnover')}
              className="h-20 text-lg font-semibold bg-orange-600 hover:bg-orange-700 text-white dark:bg-orange-700 dark:hover:bg-orange-600"
            >
              <TrendingUp className="w-6 h-6 mr-2" />
              Turnover
            </Button>
          </div>
          )}

          {/* Recent Events */}
          <Card className="bg-card text-card-foreground border-border">
            <CardHeader>
              <CardTitle className="text-base">Recent Events</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {events && events.length > 0 ? (
                  events.slice(0, 10).map((event: { id: number; event_type: string; event_timestamp: string; player_id: number | null; related_player_id: number | null }) => {
                    const player = players?.find((p: { id: number }) => p.id === event.player_id)
                    const assister = players?.find((p: { id: number }) => p.id === event.related_player_id)
                    return (
                      <div key={event.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                        <div className="flex-1">
                          <div className="font-medium text-foreground">
                            {event.event_type}
                            {player && <span className="text-sm text-muted-foreground ml-2">- {player.display_name}</span>}
                            {assister && <span className="text-xs text-muted-foreground ml-1">(assist: {assister.display_name})</span>}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(event.event_timestamp).toLocaleTimeString()}
                          </div>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <div className="text-center text-muted-foreground py-4">No events yet</div>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Goal Dialog */}
      <Dialog open={dialogType === 'goal'} onOpenChange={(open) => !open && setDialogType(null)}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>Log Our Goal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Scorer *</Label>
              <Select value={scorerId} onValueChange={setScorerId}>
                <SelectTrigger className="bg-background text-foreground">
                  <SelectValue placeholder="Select player..." />
                </SelectTrigger>
                <SelectContent>
                  {players?.map((player: { id: number; display_name: string }) => (
                    <SelectItem key={player.id} value={player.id.toString()}>
                      {player.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Assister (optional)</Label>
              <Select value={assisterId} onValueChange={setAssisterId}>
                <SelectTrigger className="bg-background text-foreground">
                  <SelectValue placeholder="Select player..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {players?.map((player: { id: number; display_name: string }) => (
                    <SelectItem key={player.id} value={player.id.toString()}>
                      {player.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleGoal}
              disabled={!scorerId}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Log Goal
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Turnover Dialog */}
      <Dialog open={dialogType === 'turnover'} onOpenChange={(open) => !open && setDialogType(null)}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>Log Turnover</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Player *</Label>
              <Select value={turnoverId} onValueChange={setTurnoverId}>
                <SelectTrigger className="bg-background text-foreground">
                  <SelectValue placeholder="Select player..." />
                </SelectTrigger>
                <SelectContent>
                  {players?.map((player: { id: number; display_name: string }) => (
                    <SelectItem key={player.id} value={player.id.toString()}>
                      {player.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleTurnover}
              disabled={!turnoverId}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Log Turnover
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
