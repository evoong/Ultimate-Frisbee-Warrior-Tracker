import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useGetPlayers } from '../hooks/backend/players'
import {
  useGetStrategyPlays, useCreateStrategyPlay, useRenameStrategyPlay, useDeleteStrategyPlay,
  useGetStrategyPositions, useUpsertStrategyPosition, useDeleteStrategyPosition,
  useGetStrategyArrows, useCreateStrategyArrow, useUpdateStrategyArrow, useDeleteStrategyArrow,
  type StrategyPlay, type StrategyArrow, type ArrowGeom,
} from '../hooks/backend/strategy'
import StrategyBoard from '../components/strategy/StrategyBoard'
import FadeIn from '../components/FadeIn'
import { Card, CardContent } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Skeleton } from '../lib/shadcn/skeleton'
import { ClipboardList, Plus, Edit2, Trash2 } from 'lucide-react'

type Player = { id: number; display_name: string; photo_url: string | null }

export default function Strategy() {
  const { allowed } = useAuth()
  const { data: rawPlayers, loading: playersLoading, error: playersError, trigger: fetchPlayers } = useGetPlayers()
  const { data: plays, loading: playsLoading, error: playsError, trigger: fetchPlays } = useGetStrategyPlays()
  const { trigger: fetchPositions } = useGetStrategyPositions()
  const { trigger: createPlay, loading: creating } = useCreateStrategyPlay()
  const { trigger: renamePlay } = useRenameStrategyPlay()
  const { trigger: deletePlay } = useDeleteStrategyPlay()
  const { trigger: upsertPosition, error: upsertError } = useUpsertStrategyPosition()
  const { trigger: deletePosition, error: removeError } = useDeleteStrategyPosition()
  const { trigger: fetchArrows } = useGetStrategyArrows()
  const { trigger: createArrow, error: createArrowError } = useCreateStrategyArrow()
  const { trigger: updateArrow, error: updateArrowError } = useUpdateStrategyArrow()
  const { trigger: deleteArrow, error: deleteArrowError } = useDeleteStrategyArrow()

  const players = rawPlayers as Player[] | undefined

  const [selectedPlayId, setSelectedPlayId] = useState<number | null>(null)
  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map())
  const [arrows, setArrows] = useState<StrategyArrow[]>([])
  const [selectedArrowId, setSelectedArrowId] = useState<number | null>(null)
  // Optimistic-create bookkeeping. Temp arrows get a decreasing negative
  // id until the server assigns a real one.
  const tempIdRef = useRef(-1)
  // Edits made to a temp arrow before its insert resolves, flushed on
  // reconcile so a draw-then-bend before the round-trip is not lost.
  const pendingEditsRef = useRef<Map<number, ArrowGeom>>(new Map())
  // Temp arrows deleted before their insert resolved: delete the server
  // row once it lands so no orphan survives a reload.
  const cancelledRef = useRef<Set<number>>(new Set())
  const [showCreate, setShowCreate] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [nameInput, setNameInput] = useState('')

  useEffect(() => {
    fetchPlays()
    fetchPlayers()
  }, [])

  // Default the selection to the first play, and clear it if the selected
  // play was deleted (possibly by someone else, seen after a refetch).
  useEffect(() => {
    if (!plays) return
    if (selectedPlayId === null || !plays.some(p => p.id === selectedPlayId)) {
      setSelectedPlayId(plays[0]?.id ?? null)
    }
  }, [plays])

  // Load positions whenever the selected play changes. Clearing first keeps
  // the previous play's placements from flashing on the new board. Rows for
  // players no longer on the roster are dropped (the DB cascade removes them
  // server-side; this guards a stale fetch).
  const loadPositions = async (playId: number) => {
    const rows = await fetchPositions({ playId })
    if (rows) {
      setPositions(new Map(rows.map(r => [r.player_id, { x: r.x, y: r.y }])))
    }
  }

  const loadArrows = async (playId: number) => {
    const rows = await fetchArrows({ playId })
    if (rows) setArrows(rows)
  }

  useEffect(() => {
    setPositions(new Map())
    setArrows([])
    setSelectedArrowId(null)
    if (selectedPlayId !== null) {
      loadPositions(selectedPlayId)
      loadArrows(selectedPlayId)
    }
  }, [selectedPlayId])

  const handlePlace = async (playerId: number, x: number, y: number) => {
    if (selectedPlayId === null) return
    setPositions(prev => new Map(prev).set(playerId, { x, y }))
    const ok = await upsertPosition({ playId: selectedPlayId, playerId, x, y })
    if (!ok) loadPositions(selectedPlayId)
  }

  const handleRemove = async (playerId: number) => {
    if (selectedPlayId === null) return
    setPositions(prev => {
      const next = new Map(prev)
      next.delete(playerId)
      return next
    })
    const ok = await deletePosition({ playId: selectedPlayId, playerId })
    if (!ok) loadPositions(selectedPlayId)
  }

  const handleCreateArrow = async (geom: ArrowGeom) => {
    if (selectedPlayId === null) return
    const tempId = tempIdRef.current--
    setArrows(prev => [...prev, { id: tempId, ...geom }])
    setSelectedArrowId(tempId)
    const row = await createArrow({ playId: selectedPlayId, ...geom })
    if (!row) {
      // Insert failed: drop the optimistic arrow.
      pendingEditsRef.current.delete(tempId)
      cancelledRef.current.delete(tempId)
      setArrows(prev => prev.filter(a => a.id !== tempId))
      setSelectedArrowId(prev => (prev === tempId ? null : prev))
      return
    }
    // Deleted while the insert was in flight: remove the now-orphaned row.
    if (cancelledRef.current.has(tempId)) {
      cancelledRef.current.delete(tempId)
      pendingEditsRef.current.delete(tempId)
      deleteArrow({ id: row.id })
      return
    }
    // Reconcile temp id -> server id and keep selection following it.
    setArrows(prev => prev.map(a => (a.id === tempId ? { ...a, id: row.id } : a)))
    setSelectedArrowId(prev => (prev === tempId ? row.id : prev))
    // Flush any edits made to the arrow while its insert was pending.
    const pending = pendingEditsRef.current.get(tempId)
    pendingEditsRef.current.delete(tempId)
    if (pending) {
      const ok = await updateArrow({ id: row.id, ...pending })
      if (!ok) loadArrows(selectedPlayId)
    }
  }

  const handleUpdateArrow = async (id: number, geom: ArrowGeom) => {
    setArrows(prev => prev.map(a => (a.id === id ? { ...a, ...geom } : a)))
    if (id < 0) {
      // Still pending its insert; reconcile will persist the latest geom.
      pendingEditsRef.current.set(id, geom)
      return
    }
    if (selectedPlayId === null) return
    const ok = await updateArrow({ id, ...geom })
    if (!ok) loadArrows(selectedPlayId)
  }

  const handleDeleteArrow = async (id: number) => {
    setArrows(prev => prev.filter(a => a.id !== id))
    setSelectedArrowId(prev => (prev === id ? null : prev))
    if (id < 0) {
      // Never persisted yet: cancel it so the in-flight insert cleans up.
      cancelledRef.current.add(id)
      return
    }
    if (selectedPlayId === null) return
    const ok = await deleteArrow({ id })
    if (!ok) loadArrows(selectedPlayId)
  }

  const handleCreate = async () => {
    const name = nameInput.trim()
    if (!name) return
    const play = await createPlay({ name })
    if (play) {
      setShowCreate(false)
      setNameInput('')
      await fetchPlays()
      setSelectedPlayId(play.id)
    }
  }

  const handleRename = async () => {
    const name = nameInput.trim()
    if (!name || selectedPlayId === null) return
    await renamePlay({ id: selectedPlayId, name })
    setShowRename(false)
    setNameInput('')
    fetchPlays()
  }

  const handleDelete = async () => {
    if (selectedPlayId === null) return
    await deletePlay({ id: selectedPlayId })
    setDeleteConfirm(false)
    fetchPlays()
  }

  const selectedPlay = (plays as StrategyPlay[] | undefined)?.find(p => p.id === selectedPlayId)
  const saveError = upsertError || removeError || createArrowError || updateArrowError || deleteArrowError

  if ((playsLoading && plays === undefined) || (playersLoading && players === undefined)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-foreground">Strategy</h1>
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="w-full aspect-[100/37] max-lg:aspect-[37/100] max-lg:h-[70vh] max-lg:w-auto max-lg:mx-auto rounded-xl" />
        <div className="flex flex-wrap gap-2 p-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="w-10 h-10 rounded-full" />
          ))}
        </div>
      </div>
    )
  }
  const loadError = playsError || playersError
  if (loadError) return <div className="flex items-center justify-center h-64"><div className="text-destructive">Error: {loadError}</div></div>

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">Strategy</h1>

      {(plays?.length ?? 0) === 0 ? (
        <FadeIn>
          <Card className="bg-card text-card-foreground border-border">
            <CardContent className="p-10 text-center space-y-3">
              <ClipboardList className="w-12 h-12 text-muted-foreground mx-auto opacity-40" />
              <p className="text-muted-foreground text-sm">No plays yet. Create one and drag players onto the field.</p>
              {allowed && (
                <Button onClick={() => { setNameInput(''); setShowCreate(true) }}>
                  <Plus className="w-4 h-4 mr-1.5" />New play
                </Button>
              )}
            </CardContent>
          </Card>
        </FadeIn>
      ) : (
        <FadeIn>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Select
                value={selectedPlayId !== null ? String(selectedPlayId) : undefined}
                onValueChange={v => setSelectedPlayId(Number(v))}
              >
                <SelectTrigger className="flex-1 bg-card text-foreground border-border">
                  <SelectValue placeholder="Select a play" />
                </SelectTrigger>
                <SelectContent>
                  {plays?.map(play => (
                    <SelectItem key={play.id} value={String(play.id)}>{play.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {allowed && (
                <>
                  <Button variant="outline" size="icon" aria-label="New play"
                    onClick={() => { setNameInput(''); setShowCreate(true) }}>
                    <Plus className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="icon" aria-label="Rename play" disabled={!selectedPlay}
                    onClick={() => { setNameInput(selectedPlay?.name ?? ''); setShowRename(true) }}>
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="icon" aria-label="Delete play" disabled={!selectedPlay}
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleteConfirm(true)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </>
              )}
            </div>

            {saveError && (
              <div className="text-sm text-destructive">Failed to save: {saveError}</div>
            )}

            <StrategyBoard
              players={players ?? []}
              positions={positions}
              arrows={arrows}
              allowed={allowed}
              selectedArrowId={selectedArrowId}
              onSelectArrow={setSelectedArrowId}
              onPlace={handlePlace}
              onRemove={handleRemove}
              onCreateArrow={handleCreateArrow}
              onUpdateArrow={handleUpdateArrow}
              onDeleteArrow={handleDeleteArrow}
            />
            {allowed && (
              <p className="text-xs text-muted-foreground">
                Drag players from the bench onto the field. Drag a player off the field to bench them.
                Toggle Draw arrow (or hold A) and drag on the field to add cutting arrows; tap an arrow to
                bend, move, or delete it.
              </p>
            )}
          </div>
        </FadeIn>
      )}

      {/* Create play */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader><DialogTitle>New Play</DialogTitle></DialogHeader>
          <Input
            placeholder="Play name (e.g. Vert stack)"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            autoFocus
          />
          <div className="flex gap-3 mt-2">
            <Button variant="outline" onClick={() => setShowCreate(false)} className="flex-1">Cancel</Button>
            <Button onClick={handleCreate} disabled={!nameInput.trim() || creating} className="flex-1">Create</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Rename play */}
      <Dialog open={showRename} onOpenChange={setShowRename}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader><DialogTitle>Rename Play</DialogTitle></DialogHeader>
          <Input
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRename() }}
            autoFocus
          />
          <div className="flex gap-3 mt-2">
            <Button variant="outline" onClick={() => setShowRename(false)} className="flex-1">Cancel</Button>
            <Button onClick={handleRename} disabled={!nameInput.trim()} className="flex-1">Rename</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader><DialogTitle>Delete Play</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete <strong>{selectedPlay?.name}</strong> and its player placements. This cannot be undone.
          </p>
          <div className="flex gap-3 mt-2">
            <Button variant="outline" onClick={() => setDeleteConfirm(false)} className="flex-1">Cancel</Button>
            <Button onClick={handleDelete} className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete Play</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
