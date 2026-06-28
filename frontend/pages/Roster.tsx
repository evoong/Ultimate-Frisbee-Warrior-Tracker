import { useEffect, useState } from 'react'
import { useGetPlayers, useUpdatePlayerPosition, useDeleteSubPlayer } from '../hooks/backend/players'
import { useGetPlayerGameStats } from '../hooks/backend/players'
import { useGetSeasons } from '../hooks/backend/stats'
import { Badge } from '../lib/shadcn/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { User, Phone, Search, ChevronLeft, ChevronRight, Users, TrendingUp, Trophy, Trash2 } from 'lucide-react'

type Player = {
  id: number
  display_name: string
  gender_match: string | null
  phone: string | null
  is_sub: boolean
  position: string | null
}

type GameStat = {
  game_id: number
  opponent: string
  game_date: string
  game_type: string
  season_id: number | null
  goals: string
  assists: string
  turnovers: string
}

const POSITIONS = ['Handler', 'Cutter', 'Hybrid', 'Hybrid Handler', 'Hybrid Cutter']

export default function Roster() {
  const { data: rawPlayers, loading, error, trigger: fetchPlayers } = useGetPlayers()
  const { data: gameStats, loading: statsLoading, trigger: fetchGameStats } = useGetPlayerGameStats()
  const { data: seasons, trigger: fetchSeasons } = useGetSeasons()
  const { trigger: updatePosition } = useUpdatePlayerPosition()
  const { trigger: deleteSubPlayer } = useDeleteSubPlayer()

  const players = rawPlayers as Player[] | undefined

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null)
  const [seasonFilter, setSeasonFilter] = useState<string>('all')
  const [rosterSeasonFilter, setRosterSeasonFilter] = useState<string | null>(null)

  useEffect(() => {
    fetchSeasons()
  }, [])

  // Auto-select most recent season once loaded
  useEffect(() => {
    const s = seasons as { season_id: number }[] | undefined
    if (s && rosterSeasonFilter === null) {
      setRosterSeasonFilter(s.length > 0 ? s[0]!.season_id.toString() : 'all')
    }
  }, [seasons])

  useEffect(() => {
    if (rosterSeasonFilter === null) return
    fetchPlayers({ seasonId: rosterSeasonFilter === 'all' ? null : parseInt(rosterSeasonFilter) })
  }, [rosterSeasonFilter])

  const handleDeleteSub = async (playerId: number) => {
    await deleteSubPlayer({ playerId, gameId: 0 })
    fetchPlayers({ seasonId: rosterSeasonFilter === 'all' || rosterSeasonFilter === null ? null : parseInt(rosterSeasonFilter!) })
  }

  const handleSelectPlayer = (player: Player) => {
    setSelectedPlayer(player)
    setSeasonFilter('all')
    fetchGameStats({ playerId: player.id })
  }

  const handleBack = () => {
    setSelectedPlayer(null)
    setSearchQuery('')
  }

  const handlePositionChange = async (player: Player, position: string) => {
    const newPosition = position === '__none__' ? null : position
    // Optimistically update local state
    setSelectedPlayer({ ...player, position: newPosition })
    await updatePosition({ playerId: player.id, position: newPosition })
    // Refresh list so the card also reflects the change
    fetchPlayers({ seasonId: rosterSeasonFilter === 'all' ? null : parseInt(rosterSeasonFilter!) })
  }

  const filteredPlayers = players?.filter(p =>
    p.display_name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Filter game stats by season
  const filteredStats = (gameStats as GameStat[] | undefined)?.filter(g =>
    seasonFilter === 'all' || g.season_id?.toString() === seasonFilter
  ) ?? []

  // Compute summary totals from filtered stats
  const summary = filteredStats.reduce(
    (acc, g) => ({
      goals: acc.goals + parseInt(g.goals),
      assists: acc.assists + parseInt(g.assists),
      turnovers: acc.turnovers + parseInt(g.turnovers),
      games: acc.games + 1,
    }),
    { goals: 0, assists: 0, turnovers: 0, games: 0 }
  )

  const formatDate = (dateStr: string) => {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    })
  }

  // ── Player Detail View ───────────────────────────────────────────────────────
  if (selectedPlayer) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <button
            onClick={handleBack}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
            <span className="text-sm font-medium">Back to Roster</span>
          </button>
          {selectedPlayer.is_sub && (
            <button
              onClick={async () => {
                await handleDeleteSub(selectedPlayer.id)
                handleBack()
              }}
              className="flex items-center gap-1.5 text-sm text-destructive hover:text-destructive/80 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Remove sub
            </button>
          )}
        </div>

        {/* Player Header */}
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <User className="w-8 h-8 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-foreground">{selectedPlayer.display_name}</h1>
              {selectedPlayer.is_sub && (
                <Badge variant="secondary" className="text-xs">Sub</Badge>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1">
              {selectedPlayer.gender_match && (
                <span className="text-sm text-muted-foreground">{selectedPlayer.gender_match}</span>
              )}
              {selectedPlayer.phone && (
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Phone className="w-3 h-3" />
                  {selectedPlayer.phone}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Position */}
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Position</Label>
          <Select
            value={selectedPlayer.position ?? '__none__'}
            onValueChange={(val) => handlePositionChange(selectedPlayer, val)}
          >
            <SelectTrigger className="bg-card border-border text-foreground">
              <SelectValue placeholder="Select position..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— No position —</SelectItem>
              {POSITIONS.map(pos => (
                <SelectItem key={pos} value={pos}>{pos}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Season Filter */}
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Filter by Season</Label>
          <Select value={seasonFilter} onValueChange={setSeasonFilter}>
            <SelectTrigger className="bg-card border-border text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Seasons</SelectItem>
              {(seasons as { season_id: number; game_count: string }[] | undefined)?.map(s => (
                <SelectItem key={s.season_id} value={s.season_id.toString()}>
                  Season {s.season_id} ({s.game_count} games)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-2">
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-3 text-center">
              <div className="text-2xl font-bold text-foreground">{summary.games}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Games</div>
            </CardContent>
          </Card>
          <Card className="bg-green-500/5 border-green-500/20">
            <CardContent className="pt-4 pb-3 text-center">
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">{summary.goals}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Goals</div>
            </CardContent>
          </Card>
          <Card className="bg-blue-500/5 border-blue-500/20">
            <CardContent className="pt-4 pb-3 text-center">
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{summary.assists}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Assists</div>
            </CardContent>
          </Card>
          <Card className="bg-orange-500/5 border-orange-500/20">
            <CardContent className="pt-4 pb-3 text-center">
              <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">{summary.turnovers}</div>
              <div className="text-xs text-muted-foreground mt-0.5">TOs</div>
            </CardContent>
          </Card>
        </div>

        {/* Per-Game Breakdown */}
        <Card className="bg-card text-card-foreground border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>Per Game</span>
              <span className="text-sm font-normal text-muted-foreground">
                {filteredStats.length} games
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="text-center py-8 text-muted-foreground text-sm">Loading...</div>
            ) : filteredStats.length > 0 ? (
              <div className="space-y-2">
                {/* Column headers */}
                <div className="flex items-center gap-3 px-3 text-xs text-muted-foreground font-medium">
                  <div className="flex-1">Game</div>
                  <div className="w-8 text-center text-green-600 dark:text-green-400">G</div>
                  <div className="w-8 text-center text-blue-600 dark:text-blue-400">A</div>
                  <div className="w-8 text-center text-orange-600 dark:text-orange-400">TO</div>
                </div>

                {filteredStats.map((stat) => (
                  <div key={stat.game_id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-background">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground text-sm truncate">
                        vs {stat.opponent}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">{formatDate(stat.game_date)}</span>
                        {stat.game_type === 'Playoff' && (
                          <Trophy className="w-3 h-3 text-yellow-500 dark:text-yellow-400" />
                        )}
                        {stat.season_id && (
                          <span className="text-xs text-muted-foreground">S{stat.season_id}</span>
                        )}
                      </div>
                    </div>
                    <div className="w-8 text-center font-bold text-green-600 dark:text-green-400">
                      {stat.goals}
                    </div>
                    <div className="w-8 text-center font-bold text-blue-600 dark:text-blue-400">
                      {stat.assists}
                    </div>
                    <div className="w-8 text-center font-bold text-orange-600 dark:text-orange-400">
                      {stat.turnovers}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-10">
                <TrendingUp className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-40" />
                <p className="text-muted-foreground text-sm">No stats recorded yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Stats appear once goals and assists are logged in Quick Score
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Roster List View ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading players...</div>
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
        <h1 className="text-2xl font-bold text-foreground">Roster</h1>
        <div className="text-sm text-muted-foreground">
          {filteredPlayers?.length || 0} of {players?.length || 0}
        </div>
      </div>

      {/* Season filter */}
      <Select value={rosterSeasonFilter ?? 'all'} onValueChange={setRosterSeasonFilter}>
        <SelectTrigger className="bg-card border-border text-foreground">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Seasons</SelectItem>
          {(seasons as { season_id: number; game_count: string }[] | undefined)?.map(s => (
            <SelectItem key={s.season_id} value={s.season_id.toString()}>
              Season {s.season_id} ({s.game_count} games)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search players..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10 bg-card text-foreground border-border"
        />
      </div>

      <div className="grid grid-cols-1 gap-3">
        {filteredPlayers?.map((player) => (
          <Card
            key={player.id}
            onClick={() => handleSelectPlayer(player)}
            className="bg-card text-card-foreground border-border cursor-pointer hover:bg-accent/50 active:scale-[0.99] transition-all"
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-6 h-6 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground text-lg">{player.display_name}</span>
                    {player.is_sub && (
                      <Badge variant="secondary" className="text-xs">Sub</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    {player.position && (
                      <span className="text-sm text-muted-foreground">{player.position}</span>
                    )}
                    {player.gender_match && (
                      <span className="text-sm text-muted-foreground">{player.gender_match}</span>
                    )}
                    {player.phone && (
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Phone className="w-3 h-3" />
                        {player.phone}
                      </div>
                    )}
                  </div>
                </div>
                {player.is_sub ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteSub(player.id) }}
                    className="p-2 rounded hover:bg-destructive/10 transition-colors"
                    aria-label={`Remove sub ${player.display_name}`}
                  >
                    <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                  </button>
                ) : (
                  <ChevronRight className="w-5 h-5 text-muted-foreground" />
                )}
              </div>
            </CardContent>
          </Card>
        ))}

        {filteredPlayers?.length === 0 && (
          <Card className="bg-card text-card-foreground border-border">
            <CardContent className="py-12 text-center">
              <Users className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground">No players found</p>
              <p className="text-sm text-muted-foreground mt-1">Try a different search or season</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
