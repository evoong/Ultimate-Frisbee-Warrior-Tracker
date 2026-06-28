import { useEffect, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useGetPlayerStats } from '../hooks/backend/stats'
import { useGetSeasons } from '../hooks/backend/stats'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Label } from '../lib/shadcn/label'
import { Award, Target, Users, TrendingUp } from 'lucide-react'

export default function Ranking() {
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: seasons, trigger: fetchSeasons } = useGetSeasons()
  const { data: stats, loading, error, trigger: fetchStats } = useGetPlayerStats()

  const [filterType, setFilterType] = useState<'all' | 'season' | 'games'>('all')
  const [selectedSeasonId, setSelectedSeasonId] = useState<string>('')
  const [selectedGameIds, setSelectedGameIds] = useState<number[]>([])

  useEffect(() => {
    fetchGames()
    fetchSeasons()
  }, [])

  useEffect(() => {
    if (filterType === 'all') {
      fetchStats({})
    } else if (filterType === 'season' && selectedSeasonId) {
      fetchStats({ seasonId: parseInt(selectedSeasonId) })
    } else if (filterType === 'games' && selectedGameIds.length > 0) {
      fetchStats({ gameIds: selectedGameIds })
    }
  }, [filterType, selectedSeasonId, selectedGameIds])

  const handleGameToggle = (gameId: number) => {
    setSelectedGameIds(prev =>
      prev.includes(gameId) ? prev.filter(id => id !== gameId) : [...prev, gameId]
    )
  }

  const topScorer = stats ? [...stats].sort((a, b) => parseInt(b.goals) - parseInt(a.goals))[0] : null
  const topAssister = stats ? [...stats].sort((a, b) => parseInt(b.assists) - parseInt(a.assists))[0] : null

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Rankings</h1>

      {/* Filter Section */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Filter By</Label>
            <Select value={filterType} onValueChange={(val: 'all' | 'season' | 'games') => setFilterType(val)}>
              <SelectTrigger className="bg-background text-foreground border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Games</SelectItem>
                <SelectItem value="season">Season</SelectItem>
                <SelectItem value="games">Specific Games</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filterType === 'season' && (
            <div className="space-y-2">
              <Label>Select Season</Label>
              <Select value={selectedSeasonId} onValueChange={setSelectedSeasonId}>
                <SelectTrigger className="bg-background text-foreground border-border">
                  <SelectValue placeholder="Choose season..." />
                </SelectTrigger>
                <SelectContent>
                  {seasons?.map((season: { season_id: number; game_count: string }) => (
                    <SelectItem key={season.season_id} value={season.season_id.toString()}>
                      Season {season.season_id} ({season.game_count} games)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {filterType === 'games' && (
            <div className="space-y-2">
              <Label>Select Games</Label>
              <div className="max-h-48 overflow-y-auto space-y-1 bg-background rounded-md border border-border p-3">
                {games?.map((game: { id: number; opponent: string; game_date: string }) => (
                  <label
                    key={game.id}
                    className="flex items-center gap-3 cursor-pointer hover:bg-accent rounded px-2 py-1.5 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedGameIds.includes(game.id)}
                      onChange={() => handleGameToggle(game.id)}
                      className="w-4 h-4 rounded border-border"
                    />
                    <span className="text-sm text-foreground">
                      vs {game.opponent} — {new Date(game.game_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top cards */}
      {topScorer && topAssister && (
        <div className="grid grid-cols-2 gap-3">
          <Card className="bg-gradient-to-br from-green-500/10 to-green-500/5 border-green-500/20">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <Target className="w-4 h-4 text-green-600 dark:text-green-400" />
                <div className="text-xs text-muted-foreground">Top Scorer</div>
              </div>
              <div className="font-bold text-sm text-foreground truncate">{topScorer.player_name}</div>
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">{topScorer.goals} <span className="text-sm font-normal">goals</span></div>
            </CardContent>
          </Card>
          <Card className="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border-blue-500/20">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <div className="text-xs text-muted-foreground">Top Assister</div>
              </div>
              <div className="font-bold text-sm text-foreground truncate">{topAssister.player_name}</div>
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{topAssister.assists} <span className="text-sm font-normal">assists</span></div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Leaderboard */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Player Rankings</span>
            <span className="text-sm font-normal text-muted-foreground">{stats?.length || 0} players</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading rankings...</div>
          ) : error ? (
            <div className="text-center py-8 text-destructive">Error: {error}</div>
          ) : stats && stats.length > 0 ? (
            <div className="space-y-2">
              {stats.map((player: { player_id: number; player_name: string; goals: string; assists: string; turnovers: string; games_played: string; ga_rank: number }, index: number) => (
                <div
                  key={player.player_id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-background hover:bg-accent transition-colors"
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0 ${
                    index === 0
                      ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200'
                      : index === 1
                      ? 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                      : index === 2
                      ? 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {index === 0 ? <Award className="w-4 h-4" /> : <span className="text-sm">{player.ga_rank}</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-foreground text-sm truncate">{player.player_name}</div>
                    <div className="text-xs text-muted-foreground">{player.games_played} games</div>
                  </div>
                  <div className="flex gap-3 text-sm shrink-0">
                    <div className="text-center w-8">
                      <div className="font-bold text-green-600 dark:text-green-400">{player.goals}</div>
                      <div className="text-xs text-muted-foreground">G</div>
                    </div>
                    <div className="text-center w-8">
                      <div className="font-bold text-blue-600 dark:text-blue-400">{player.assists}</div>
                      <div className="text-xs text-muted-foreground">A</div>
                    </div>
                    <div className="text-center w-8">
                      <div className="font-bold text-orange-600 dark:text-orange-400">{player.turnovers}</div>
                      <div className="text-xs text-muted-foreground">TO</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <TrendingUp className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground">No rankings available</p>
              <p className="text-sm text-muted-foreground mt-1">
                {filterType === 'games' && selectedGameIds.length === 0
                  ? 'Select games to view rankings'
                  : 'Play some games to see rankings!'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
