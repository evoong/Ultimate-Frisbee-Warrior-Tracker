import { useEffect, useState } from 'react'
import { useGetGames } from '../hooks/backend/games'
import { useGetPlayerStats, useGetAllSeasons, useGetSeasons } from '../hooks/backend/stats'
import { getDefaultJamSeasonId } from '../lib/seasonUtils'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Label } from '../lib/shadcn/label'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import { Award, Target } from 'lucide-react'

type Season = { id: number; name: string; year: number; organizer: string | null; start_date: string | null; end_date: string | null }
type Game = { id: number; opponent: string; game_date: string; season_id: number | null }

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

export default function Ranking() {
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: seasonsWithGames, trigger: fetchSeasonsWithGames } = useGetSeasons()
  const { data: stats, loading, error, trigger: fetchStats } = useGetPlayerStats()

  const [filterType, setFilterType] = useState<'all' | 'season' | 'games'>('all')
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<number[]>([])
  const [selectedGameIds, setSelectedGameIds] = useState<number[]>([])

  useEffect(() => {
    fetchGames()
    fetchAllSeasons()
    fetchSeasonsWithGames()
  }, [])

  useEffect(() => {
    const s = seasonsWithGames as { id: number }[] | undefined
    const allS = allSeasons as Season[] | undefined
    if (!s || s.length === 0 || !allS || allS.length === 0 || selectedSeasonIds.length > 0) return
    const defaultId = getDefaultJamSeasonId(allS, s[0]!.id)
    setFilterType('season')
    setSelectedSeasonIds([defaultId])
  }, [seasonsWithGames, allSeasons])

  useEffect(() => {
    if (filterType === 'all') fetchStats({})
    else if (filterType === 'season') {
      if (selectedSeasonIds.length > 0) fetchStats({ seasonIds: selectedSeasonIds })
      else fetchStats({})
    }
    else if (filterType === 'games' && selectedGameIds.length > 0) fetchStats({ gameIds: selectedGameIds })
  }, [filterType, selectedSeasonIds, selectedGameIds])

  const handleGameToggle = (gameId: number) => {
    setSelectedGameIds(prev => prev.includes(gameId) ? prev.filter(id => id !== gameId) : [...prev, gameId])
  }

  const handleSelectAll = () => {
    const allIds = (games as Game[] | undefined)?.map(g => g.id) ?? []
    setSelectedGameIds(allIds)
  }

  const handleUnselectAll = () => setSelectedGameIds([])

  const topScorer = stats ? [...stats].sort((a, b) => parseInt(b.goals) - parseInt(a.goals))[0] : null
  const topAssister = stats ? [...stats].sort((a, b) => parseInt(b.assists) - parseInt(a.assists))[0] : null

  const allGames = games as Game[] | undefined
  const allSeasonsArr = (allSeasons as Season[] | undefined) ?? []

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Rankings</h1>

      {/* Filter Section */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader><CardTitle className="text-base">Filters</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Filter By</Label>
            <Select value={filterType} onValueChange={(val: 'all' | 'season' | 'games') => {
              setFilterType(val); setSelectedGameIds([]); setSelectedSeasonIds([])
            }}>
              <SelectTrigger className="bg-background text-foreground border-border"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Games</SelectItem>
                <SelectItem value="season">Season</SelectItem>
                <SelectItem value="games">Specific Games</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filterType === 'season' && (
            <div className="space-y-2">
              <Label>Select Season(s)</Label>
              <SeasonMultiSelect
                seasons={allSeasonsArr}
                selectedIds={selectedSeasonIds}
                onChange={setSelectedSeasonIds}
                placeholder="All Seasons"
              />
            </div>
          )}

          {filterType === 'games' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Select Games</Label>
                <div className="flex gap-2">
                  <button onClick={handleSelectAll} className="text-xs text-primary hover:underline">Select all</button>
                  <span className="text-xs text-muted-foreground">·</span>
                  <button onClick={handleUnselectAll} className="text-xs text-muted-foreground hover:text-foreground">Unselect all</button>
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1 bg-background rounded-md border border-border p-3">
                {allGames?.map(game => {
                  const s = allSeasonsArr.find(s => s.id === game.season_id)
                  return (
                    <label key={game.id} className="flex items-center gap-3 cursor-pointer hover:bg-accent rounded px-2 py-1.5 transition-colors">
                      <input type="checkbox" checked={selectedGameIds.includes(game.id)} onChange={() => handleGameToggle(game.id)} className="w-4 h-4 rounded border-border" />
                      <span className="text-sm text-foreground">
                        vs {game.opponent}, {new Date(game.game_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {s && <span className="text-xs text-muted-foreground ml-1">· {seasonLabel(s)}</span>}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top cards */}
      {topScorer && topAssister && (
        <FadeIn className="grid grid-cols-2 gap-3">
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-yellow-500 mb-1">
                <Award className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wide">Top Scorer</span>
              </div>
              <p className="font-bold text-foreground">{topScorer.player_name}</p>
              <p className="text-2xl font-bold text-primary">{topScorer.goals}</p>
              <p className="text-xs text-muted-foreground">goals</p>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-blue-500 mb-1">
                <Target className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wide">Top Assister</span>
              </div>
              <p className="font-bold text-foreground">{topAssister.player_name}</p>
              <p className="text-2xl font-bold text-primary">{topAssister.assists}</p>
              <p className="text-xs text-muted-foreground">assists</p>
            </CardContent>
          </Card>
        </FadeIn>
      )}

      {/* Rankings Table */}
      <Card className="bg-card text-card-foreground border-border">
        <CardHeader>
          <CardTitle className="text-base">Player Rankings</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">#</th>
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">Player</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Goals</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Assists</th>
                    <th className="text-right py-2 font-semibold text-muted-foreground">G+A</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Placeholder rows shaped like the real ranking rows */}
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <tr key={idx} className="border-b border-border/50">
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-4" /></td>
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-32" /></td>
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-6 ml-auto" /></td>
                      <td className="py-2 pr-3"><Skeleton className="h-4 w-6 ml-auto" /></td>
                      <td className="py-2"><Skeleton className="h-4 w-8 ml-auto" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!loading && !error && (!stats || stats.length === 0) && (
            <p className="text-sm text-muted-foreground text-center py-4">
              {filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view rankings' : 'Play some games to see rankings!'}
            </p>
          )}
          {stats && stats.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">#</th>
                    <th className="text-left py-2 pr-3 font-semibold text-muted-foreground">Player</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Goals</th>
                    <th className="text-right py-2 pr-3 font-semibold text-muted-foreground">Assists</th>
                    <th className="text-right py-2 font-semibold text-muted-foreground">G+A</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((row, idx) => (
                    <FadeIn
                      as="tr"
                      key={row.player_id}
                      delay={idx * 40}
                      className={`border-b border-border/50 ${idx < 3 ? 'font-medium' : ''}`}
                    >
                      <td className="py-2 pr-3 text-muted-foreground">
                        {idx + 1}
                      </td>
                      <td className="py-2 pr-3 text-foreground">{row.player_name}</td>
                      <td className="py-2 pr-3 text-right text-foreground">{row.goals}</td>
                      <td className="py-2 pr-3 text-right text-foreground">{row.assists}</td>
                      <td className="py-2 text-right font-bold text-primary">{parseInt(row.goals) + parseInt(row.assists)}</td>
                    </FadeIn>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
