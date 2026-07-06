import { useEffect, useRef, useState } from 'react'
import { useGetPlayers, useUpdatePlayer, useUpdatePlayerPosition, useDeletePlayer, useGetPlayerGameStats, useUploadPlayerPhoto, useGetPlayerSeasons, useUpdatePlayerSeasons, useCreatePlayer } from '../hooks/backend/players'
import { useGetAllSeasons, useGetSeasons } from '../hooks/backend/stats'
import { useSetAttendance } from '../hooks/backend/attendance'
import { getDefaultJamSeasonId } from '../lib/seasonUtils'
import { useAuth } from '../contexts/AuthContext'
import SeasonMultiSelect from '../components/SeasonMultiSelect'
import PlayerAvatar from '../components/PlayerAvatar'
import { Badge } from '../lib/shadcn/badge'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Input } from '../lib/shadcn/input'
import { Label } from '../lib/shadcn/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import { Phone, Search, ChevronLeft, ChevronRight, Users, TrendingUp, Trophy, Trash2, Camera, Edit2, Save, X, Plus, Hash } from 'lucide-react'

type Player = {
  id: number; display_name: string; first_name: string | null; last_name: string | null
  gender_match: string | null; phone: string | null; is_sub: boolean; position: string | null; photo_url: string | null; number: number | null
}
type GameStat = { game_id: number; opponent: string; game_date: string; game_type: string; season_id: number | null; in: boolean; goals: string; assists: string; turnovers: string }
type Season = { id: number; name: string; year: number; organizer: string | null; start_date: string | null; end_date: string | null }
type PlayerSeason = { id: number; name: string; year: number; organizer: string | null; active: boolean }

const POSITIONS = ['Handler', 'Cutter', 'Hybrid', 'Deep Cutter']
const GENDERS = ['Man', 'Woman']

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

// Placeholder card shaped like a real roster player card, shown while the
// first players fetch is in flight so the layout does not jump when data lands.
function RosterCardSkeleton() {
  return (
    <Card className="bg-card text-card-foreground border-border">
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <Skeleton className="w-12 h-12 rounded-full shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="w-5 h-5 rounded shrink-0" />
        </div>
      </CardContent>
    </Card>
  )
}

export default function Roster() {
  const { allowed } = useAuth()
  const { data: rawPlayers, loading, error, trigger: fetchPlayers } = useGetPlayers()
  const { data: gameStats, loading: statsLoading, trigger: fetchGameStats } = useGetPlayerGameStats()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: seasonsWithGames, trigger: fetchSeasonsWithGames } = useGetSeasons()
  const { data: playerSeasons, trigger: fetchPlayerSeasons } = useGetPlayerSeasons()
  const { trigger: updatePlayer } = useUpdatePlayer()
  const { trigger: updatePosition } = useUpdatePlayerPosition()
  const { trigger: deletePlayer } = useDeletePlayer()
  const { trigger: uploadPhoto, loading: uploadingPhoto } = useUploadPlayerPhoto()
  const { trigger: updatePlayerSeasons } = useUpdatePlayerSeasons()
  const { trigger: createPlayer } = useCreatePlayer()
  const { trigger: setAttendance } = useSetAttendance()

  const players = rawPlayers as Player[] | undefined

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null)
  // Empty array means "All Seasons"
  const [seasonFilters, setSeasonFilters] = useState<string[]>([])
  const [rosterSeasonIds, setRosterSeasonIds] = useState<number[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  // Edit mode
  const [editing, setEditing] = useState(false)
  const [editFields, setEditFields] = useState({ display_name: '', number: '', gender_match: '', phone: '', position: '', is_sub: false })
  const [editingSeasons, setEditingSeasons] = useState(false)
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<number[]>([])

  // New player dialog
  const [showNewPlayer, setShowNewPlayer] = useState(false)
  const [newPlayerData, setNewPlayerData] = useState({ display_name: '', number: '', gender_match: '', position: '', season_ids: [] as number[] })
  const [creatingPlayer, setCreatingPlayer] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchAllSeasons()
    fetchSeasonsWithGames()
  }, [])

  useEffect(() => {
    const s = seasonsWithGames as { id: number }[] | undefined
    const allS = allSeasons as Season[] | undefined
    if (!s || s.length === 0 || !allS || allS.length === 0 || rosterSeasonIds.length > 0) return
    const defaultId = getDefaultJamSeasonId(allS, s[0]!.id)
    setRosterSeasonIds([defaultId])
  }, [seasonsWithGames, allSeasons])

  useEffect(() => {
    fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined })
  }, [rosterSeasonIds])

  useEffect(() => {
    // Default the stats filter to every active season whenever a player's
    // seasons load (on select, or after editing their season list).
    const ps = (playerSeasons as PlayerSeason[] | undefined) ?? []
    setSeasonFilters(ps.filter(s => s.active).map(s => s.id.toString()))
  }, [playerSeasons])

  const handleSelectPlayer = (player: Player) => {
    setSelectedPlayer(player)
    setUploadError(null)
    setEditing(false)
    setEditingSeasons(false)
    fetchGameStats({ playerId: player.id })
    fetchPlayerSeasons({ playerId: player.id })
  }

  const handleBack = () => { setSelectedPlayer(null); setSearchQuery(''); setUploadError(null); setEditing(false); setEditingSeasons(false) }

  const handleStartEdit = () => {
    if (!selectedPlayer) return
    setEditFields({
      display_name: selectedPlayer.display_name,
      number: selectedPlayer.number != null ? String(selectedPlayer.number) : '',
      gender_match: selectedPlayer.gender_match ?? '',
      phone: selectedPlayer.phone ?? '',
      position: selectedPlayer.position ?? '',
      is_sub: selectedPlayer.is_sub,
    })
    setEditing(true)
  }

  const handleSaveEdit = async () => {
    if (!selectedPlayer) return
    const updated = await updatePlayer({
      playerId: selectedPlayer.id,
      display_name: editFields.display_name || undefined,
      gender_match: editFields.gender_match || undefined,
      phone: editFields.phone || undefined,
      number: editFields.number ? parseInt(editFields.number) : null,
      position: editFields.position || null,
      is_sub: editFields.is_sub,
    }) as Player | undefined
    if (updated) {
      setSelectedPlayer(updated)
      fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined })
    }
    setEditing(false)
  }

  const handleStartEditSeasons = () => {
    // Pre-select every membership (not just active) so saving doesn't silently drop inactive rows
    const ps = playerSeasons as PlayerSeason[] | undefined
    setSelectedSeasonIds((ps ?? []).map(s => s.id))
    setEditingSeasons(true)
  }

  const handleSaveSeasons = async () => {
    if (!selectedPlayer) return
    await updatePlayerSeasons({ playerId: selectedPlayer.id, seasonIds: selectedSeasonIds })
    await fetchPlayerSeasons({ playerId: selectedPlayer.id })
    setEditingSeasons(false)
  }

  const handleDeletePlayer = async () => {
    if (!selectedPlayer) return
    await deletePlayer({ playerId: selectedPlayer.id })
    setDeleteConfirm(false)
    handleBack()
    fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined })
  }

  const handlePositionChange = async (player: Player, position: string) => {
    const newPos = position === '__none__' ? null : position
    setSelectedPlayer({ ...player, position: newPos })
    await updatePosition({ playerId: player.id, position: newPos })
    fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined })
  }

  const handlePhotoClick = () => fileInputRef.current?.click()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !selectedPlayer) return
    setUploadError(null)
    const result = await uploadPhoto({ playerId: selectedPlayer.id, file })
    if (result?.photo_url) {
      const updated = { ...selectedPlayer, photo_url: result.photo_url }
      setSelectedPlayer(updated)
      fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined })
    } else setUploadError('Upload failed. Please try again.')
    e.target.value = ''
  }

  const handleCreatePlayer = async () => {
    if (!newPlayerData.display_name) return
    setCreatingPlayer(true)
    const created = await createPlayer({
      display_name: newPlayerData.display_name,
      gender_match: newPlayerData.gender_match || undefined,
      number: newPlayerData.number ? parseInt(newPlayerData.number) : undefined,
      position: newPlayerData.position || undefined,
      season_ids: newPlayerData.season_ids,
    })
    setCreatingPlayer(false)
    if (!created) {
      setUploadError(null)
      alert('Failed to create player. Please try again.')
      return
    }
    setShowNewPlayer(false)
    setNewPlayerData({ display_name: '', number: '', gender_match: '', position: '', season_ids: [] })
    fetchPlayers({ seasonIds: rosterSeasonIds.length > 0 ? rosterSeasonIds : undefined })
  }

  const filteredPlayers = players?.filter(p => (p.display_name ?? '').toLowerCase().includes(searchQuery.toLowerCase()))
  const allSeasonsArr = (allSeasons as Season[] | undefined) ?? []

  const filteredStats = ((gameStats as GameStat[] | undefined) ?? []).filter(g =>
    seasonFilters.includes(g.season_id?.toString() ?? '')
  )

  // Only count games the player attended — matches the per-game rows, which show '—' when out
  const summary = filteredStats.reduce(
    (acc, g) => g.in
      ? { goals: acc.goals + parseInt(g.goals), assists: acc.assists + parseInt(g.assists), turnovers: acc.turnovers + parseInt(g.turnovers), games: acc.games + 1 }
      : acc,
    { goals: 0, assists: 0, turnovers: 0, games: 0 }
  )

  const avgGoals = summary.games > 0 ? (summary.goals / summary.games).toFixed(1) : '-'
  const avgAssists = summary.games > 0 ? (summary.assists / summary.games).toFixed(1) : '-'

  const formatDate = (dateStr: string) => new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  // ── Player Detail View ────────────────────────────────────────────────────────
  if (selectedPlayer) {
    const pSeasons = (playerSeasons as PlayerSeason[] | undefined) ?? []
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <button onClick={handleBack} className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ChevronLeft className="w-5 h-5" />
            <span className="text-sm font-medium">Back to Roster</span>
          </button>
          {allowed && (
            <div className="flex items-center gap-2">
              {!editing && (
                <button onClick={handleStartEdit} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                  <Edit2 className="w-4 h-4" />Edit
                </button>
              )}
              <button onClick={() => setDeleteConfirm(true)} className="flex items-center gap-1.5 text-sm text-destructive hover:text-destructive/80 transition-colors">
                <Trash2 className="w-4 h-4" />Delete
              </button>
            </div>
          )}
        </div>

        {/* Player Header */}
        <div className="flex items-center gap-4">
          <div className="relative group">
            <PlayerAvatar photoUrl={selectedPlayer.photo_url} name={selectedPlayer.display_name} genderMatch={selectedPlayer.gender_match} size="lg" />
            {allowed && (
              <button onClick={handlePhotoClick} disabled={uploadingPhoto}
                className="absolute inset-0 rounded-full flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors cursor-pointer"
              >
                <Camera className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" />
              </button>
            )}
            {uploadingPhoto && (
              <div className="absolute inset-0 rounded-full flex items-center justify-center bg-black/50">
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-foreground">{selectedPlayer.display_name}</h1>
              {selectedPlayer.is_sub && <Badge variant="secondary" className="text-xs">Sub</Badge>}
              {selectedPlayer.number != null && (
                <Badge variant="outline" className="text-xs font-mono">#{selectedPlayer.number}</Badge>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {selectedPlayer.gender_match && (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <GenderTag value={selectedPlayer.gender_match} />{selectedPlayer.gender_match}
                </span>
              )}
              {selectedPlayer.position && <span className="text-sm text-muted-foreground">{selectedPlayer.position}</span>}
              {selectedPlayer.phone && (
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Phone className="w-3 h-3" />{selectedPlayer.phone}
                </div>
              )}
            </div>
          </div>
        </div>

        {allowed && <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />}
        {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}

        {/* Edit fields */}
        {editing && (
          <Card className="bg-card border-border">
            <CardContent className="pt-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Display Name</Label>
                  <Input value={editFields.display_name} onChange={e => setEditFields(f => ({ ...f, display_name: e.target.value }))} className="h-8 text-sm bg-background border-border" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Jersey #</Label>
                  <Input type="number" value={editFields.number} onChange={e => setEditFields(f => ({ ...f, number: e.target.value }))} placeholder="-" className="h-8 text-sm bg-background border-border" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Gender</Label>
                  <Select value={editFields.gender_match || '__none__'} onValueChange={v => setEditFields(f => ({ ...f, gender_match: v === '__none__' ? '' : v }))}>
                    <SelectTrigger className="h-8 text-sm bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Not set</SelectItem>
                      {GENDERS.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Position</Label>
                  <Select value={editFields.position || '__none__'} onValueChange={v => setEditFields(f => ({ ...f, position: v === '__none__' ? '' : v }))}>
                    <SelectTrigger className="h-8 text-sm bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Not set</SelectItem>
                      {POSITIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={editFields.phone} onChange={e => setEditFields(f => ({ ...f, phone: e.target.value }))} placeholder="Optional" className="h-8 text-sm bg-background border-border" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Roster Status</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={editFields.is_sub ? 'outline' : 'default'}
                    onClick={() => setEditFields(f => ({ ...f, is_sub: false }))}
                    className={`flex-1 h-8 text-sm ${!editFields.is_sub ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''}`}
                  >
                    Player
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={editFields.is_sub ? 'default' : 'outline'}
                    onClick={() => setEditFields(f => ({ ...f, is_sub: true }))}
                    className={`flex-1 h-8 text-sm ${editFields.is_sub ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''}`}
                  >
                    Sub
                  </Button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSaveEdit} size="sm" className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 h-9">
                  <Save className="w-3.5 h-3.5 mr-1.5" />Save
                </Button>
                <Button onClick={() => setEditing(false)} size="sm" variant="outline" className="h-9"><X className="w-3.5 h-3.5" /></Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Seasons */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>Seasons</span>
              <div className="flex items-center gap-3">
                {!editingSeasons && pSeasons.filter(s => s.active).length > 0 && (
                  <>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                      onClick={() => setSeasonFilters(pSeasons.filter(s => s.active).map(s => s.id.toString()))}
                    >
                      Select all
                    </button>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                      onClick={() => setSeasonFilters([])}
                    >
                      Unselect all
                    </button>
                    {allowed && <div className="w-px h-3.5 bg-border" />}
                  </>
                )}
                {allowed && (!editingSeasons ? (
                  <button onClick={handleStartEditSeasons} className="text-xs text-primary hover:underline">Edit</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <button onClick={handleSaveSeasons} className="text-xs text-green-600 hover:text-green-700 font-medium">Save</button>
                    <button onClick={() => setEditingSeasons(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                  </div>
                ))}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {editingSeasons ? (
              <div className="space-y-2">
                {allSeasonsArr.map(s => (
                  <label key={s.id} className="flex items-center gap-3 cursor-pointer hover:bg-accent rounded px-2 py-1.5 transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedSeasonIds.includes(s.id)}
                      onChange={() => setSelectedSeasonIds(prev =>
                        prev.includes(s.id) ? prev.filter(id => id !== s.id) : [...prev, s.id]
                      )}
                      className="w-4 h-4 rounded border-border"
                    />
                    <span className="text-sm text-foreground">{seasonLabel(s)}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {pSeasons.filter(s => s.active).length > 0
                    ? pSeasons.filter(s => s.active).map(s => (
                      <Badge
                        key={s.id}
                        variant={seasonFilters.includes(s.id.toString()) ? 'default' : 'secondary'}
                        className="text-xs cursor-pointer"
                        onClick={() => setSeasonFilters(prev =>
                          prev.includes(s.id.toString()) ? prev.filter(id => id !== s.id.toString()) : [...prev, s.id.toString()]
                        )}
                      >
                        {seasonLabel(s)}
                      </Badge>
                    ))
                    : <span className="text-sm text-muted-foreground">No seasons assigned</span>
                  }
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-2">
          <Card className="bg-muted/40 border-border">
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

        {/* Avg per game */}
        {summary.games > 0 && (
          <div className="flex gap-3">
            <Card className="flex-1 bg-green-500/5 border-green-500/20">
              <CardContent className="pt-3 pb-3 text-center">
                <div className="text-xl font-bold text-green-600 dark:text-green-400">{avgGoals}</div>
                <div className="text-xs text-muted-foreground">Avg G/game</div>
              </CardContent>
            </Card>
            <Card className="flex-1 bg-blue-500/5 border-blue-500/20">
              <CardContent className="pt-3 pb-3 text-center">
                <div className="text-xl font-bold text-blue-600 dark:text-blue-400">{avgAssists}</div>
                <div className="text-xs text-muted-foreground">Avg A/game</div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Per-Game Breakdown */}
        <Card className="bg-card text-card-foreground border-border">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>Per Game</span>
              <span className="text-sm font-normal text-muted-foreground">{filteredStats.length} games</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="text-center py-8 text-muted-foreground text-sm">Loading...</div>
            ) : filteredStats.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 px-3 text-xs text-muted-foreground font-medium">
                  <div className="flex-1">Game</div>
                  <div className="w-6 text-center">In</div>
                  <div className="w-8 text-center text-green-600 dark:text-green-400">G</div>
                  <div className="w-8 text-center text-blue-600 dark:text-blue-400">A</div>
                  <div className="w-8 text-center text-orange-600 dark:text-orange-400">TO</div>
                </div>
                {filteredStats.map(stat => (
                  <div key={stat.game_id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${stat.in ? 'bg-background' : 'bg-muted/40 opacity-60'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground text-sm truncate">vs {stat.opponent}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">{formatDate(stat.game_date)}</span>
                        {stat.game_type === 'Playoff' && <Trophy className="w-3 h-3 text-yellow-500" />}
                      </div>
                    </div>
                    <div className="w-6 flex justify-center">
                      <input
                        type="checkbox"
                        checked={stat.in}
                        disabled={!allowed}
                        onChange={async e => {
                          await setAttendance({ gameId: stat.game_id, playerId: selectedPlayer.id, attending: e.target.checked })
                          fetchGameStats({ playerId: selectedPlayer.id })
                        }}
                        className={`accent-primary w-4 h-4 ${allowed ? 'cursor-pointer' : 'cursor-default'}`}
                      />
                    </div>
                    <div className="w-8 text-center font-bold text-green-600 dark:text-green-400">{stat.in ? stat.goals : '-'}</div>
                    <div className="w-8 text-center font-bold text-blue-600 dark:text-blue-400">{stat.in ? stat.assists : '-'}</div>
                    <div className="w-8 text-center font-bold text-orange-600 dark:text-orange-400">{stat.in ? stat.turnovers : '-'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-10">
                <TrendingUp className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-40" />
                <p className="text-muted-foreground text-sm">No stats recorded yet</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Delete confirm */}
        <Dialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
          <DialogContent className="bg-card text-card-foreground">
            <DialogHeader><DialogTitle>Delete Player</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              This will permanently delete <strong>{selectedPlayer.display_name}</strong> and all their game event records. This cannot be undone.
            </p>
            <div className="flex gap-3 mt-2">
              <Button variant="outline" onClick={() => setDeleteConfirm(false)} className="flex-1">Cancel</Button>
              <Button onClick={handleDeletePlayer} className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete Player</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // ── Roster List View ──────────────────────────────────────────────────────────
  // Show skeleton player cards until the first players fetch resolves. Gating on
  // players === undefined keeps skeletons out of later refetches once we have data.
  if (loading && players === undefined) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Roster</h1>
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
        <div className="grid grid-cols-1 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <RosterCardSkeleton key={i} />
          ))}
        </div>
      </div>
    )
  }
  if (error) return <div className="flex items-center justify-center h-64"><div className="text-destructive">Error: {error}</div></div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Roster</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{filteredPlayers?.length || 0} of {players?.length || 0}</span>
          {allowed && (
            <button
              onClick={() => setShowNewPlayer(true)}
              className="flex items-center gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />Add
            </button>
          )}
        </div>
      </div>

      {/* Season filter */}
      <SeasonMultiSelect
        seasons={allSeasonsArr}
        selectedIds={rosterSeasonIds}
        onChange={setRosterSeasonIds}
        placeholder="All Seasons"
      />

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search players..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-10 bg-card text-foreground border-border"
        />
      </div>

      <div className="grid grid-cols-1 gap-3">
        {filteredPlayers?.map((player, index) => (
          <FadeIn key={player.id} delay={index * 40}>
            <Card onClick={() => handleSelectPlayer(player)}
              className="bg-card text-card-foreground border-border cursor-pointer hover:bg-accent/50 active:scale-[0.99] transition-all"
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <PlayerAvatar photoUrl={player.photo_url} name={player.display_name} genderMatch={player.gender_match} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground text-lg truncate">{player.display_name}</span>
                      {player.is_sub && <Badge variant="secondary" className="text-xs shrink-0">Sub</Badge>}
                      {player.number != null && <Badge variant="outline" className="text-xs font-mono shrink-0">#{player.number}</Badge>}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      {player.position && <span className="text-sm text-muted-foreground">{player.position}</span>}
                      {player.gender_match && <span className="text-sm text-muted-foreground">{player.gender_match}</span>}
                      {player.phone && (
                        <div className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Phone className="w-3 h-3" />{player.phone}
                        </div>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
                </div>
              </CardContent>
            </Card>
          </FadeIn>
        ))}

        {filteredPlayers?.length === 0 && (
          <FadeIn>
            <Card className="bg-card text-card-foreground border-border">
              <CardContent className="py-12 text-center">
                <Users className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-50" />
                <p className="text-muted-foreground">No players found</p>
              </CardContent>
            </Card>
          </FadeIn>
        )}
      </div>

      {/* New Player Dialog */}
      <Dialog open={showNewPlayer} onOpenChange={setShowNewPlayer}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader><DialogTitle>Add New Player</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Display Name *</Label>
              <Input value={newPlayerData.display_name} onChange={e => setNewPlayerData(d => ({ ...d, display_name: e.target.value }))} placeholder="Player name" className="bg-background border-border" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Jersey #</Label>
                <Input type="number" value={newPlayerData.number} onChange={e => setNewPlayerData(d => ({ ...d, number: e.target.value }))} placeholder="Optional" className="bg-background border-border h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Gender</Label>
                <Select value={newPlayerData.gender_match || '__none__'} onValueChange={v => setNewPlayerData(d => ({ ...d, gender_match: v === '__none__' ? '' : v }))}>
                  <SelectTrigger className="h-9 text-sm bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not set</SelectItem>
                    {GENDERS.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Position</Label>
              <Select value={newPlayerData.position || '__none__'} onValueChange={v => setNewPlayerData(d => ({ ...d, position: v === '__none__' ? '' : v }))}>
                <SelectTrigger className="h-9 text-sm bg-background border-border text-foreground"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Not set</SelectItem>
                  {POSITIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Seasons</Label>
              <div className="max-h-32 overflow-y-auto space-y-1 border border-border rounded-md p-2">
                {allSeasonsArr.map(s => (
                  <label key={s.id} className="flex items-center gap-2 cursor-pointer hover:bg-accent rounded px-2 py-1 transition-colors">
                    <input
                      type="checkbox"
                      checked={newPlayerData.season_ids.includes(s.id)}
                      onChange={() => setNewPlayerData(d => ({
                        ...d,
                        season_ids: d.season_ids.includes(s.id) ? d.season_ids.filter(id => id !== s.id) : [...d.season_ids, s.id]
                      }))}
                      className="w-3.5 h-3.5 rounded"
                    />
                    <span className="text-sm text-foreground">{seasonLabel(s)}</span>
                  </label>
                ))}
              </div>
            </div>
            <Button onClick={handleCreatePlayer} disabled={!newPlayerData.display_name || creatingPlayer} className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              {creatingPlayer ? 'Creating…' : 'Create Player'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
