import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useGetPlayers, useGetSeasonRoster, useGetPlayersNotInSeason, useCreatePlayer, useCreatePlayerForGame, useAddPlayerToGame } from '../hooks/backend/players'
import { useGetGames } from '../hooks/backend/games'
import { useGetGameAttendance } from '../hooks/backend/attendance'
import { sortGamesUpcomingFirst } from '../lib/gameOrder'
import PlayerCombobox from '../components/PlayerCombobox'
import {
  useGetStrategyPlays, useCreateStrategyPlay, useUpdateStrategyPlay, useDeleteStrategyPlay,
  useGetStrategySteps, useAddStrategyStep, useDeleteStrategyStep,
  useGetStrategyPositions, useUpsertStrategyPosition, useDeleteStrategyPosition,
  useGetStrategyOpponentMarkers, useCreateStrategyOpponentMarker, useUpdateStrategyOpponentMarker, useDeleteStrategyOpponentMarker,
  useGetStrategyArrows, useCreateStrategyArrow, useUpdateStrategyArrow, useDeleteStrategyArrow,
  type StrategyPlay, type StrategyStep, type StrategyOpponentMarker, type StrategyArrow,
  type StrategySelectedItem as BoardItem, type StrategyEntityMove as EntityMove,
} from '../hooks/backend/strategy'
import StrategyBoard from '../components/strategy/StrategyBoard'
import FadeIn from '../components/FadeIn'
import { Card, CardContent } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Label } from '../lib/shadcn/label'
import { Skeleton } from '../lib/shadcn/skeleton'
import { ClipboardList, Plus, Edit2, Trash2, ChevronLeft, ChevronRight, X } from 'lucide-react'

type Player = { id: number; display_name: string; photo_url: string | null; is_sub: boolean | null }
type Game = { id: number; opponent: string; game_date: string; game_time: string | null; season_id: number | null }

const NO_GAME = '__none__'

// A full snapshot of one step's board, used for per-step undo/redo.
type Board = {
  positions: Map<number, { x: number; y: number }>
  opponents: StrategyOpponentMarker[]
  arrows: StrategyArrow[]
}

export default function Strategy() {
  const { allowed } = useAuth()
  const { data: rawPlayers, loading: playersLoading, error: playersError, trigger: fetchPlayers } = useGetPlayers()
  const { trigger: createPlayer } = useCreatePlayer()
  const { trigger: createPlayerForGame } = useCreatePlayerForGame()
  const { trigger: addPlayerToGame } = useAddPlayerToGame()
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: attendanceRows, trigger: fetchAttendance } = useGetGameAttendance()
  const { data: seasonRoster, trigger: fetchSeasonRoster } = useGetSeasonRoster()
  const { data: otherPlayers, trigger: fetchOtherPlayers } = useGetPlayersNotInSeason()

  const { data: plays, loading: playsLoading, error: playsError, trigger: fetchPlays } = useGetStrategyPlays()
  const { trigger: createPlay, loading: creating } = useCreateStrategyPlay()
  const { trigger: updatePlay } = useUpdateStrategyPlay()
  const { trigger: deletePlay } = useDeleteStrategyPlay()

  const { data: steps, trigger: fetchSteps } = useGetStrategySteps()
  const { trigger: addStep } = useAddStrategyStep()
  const { trigger: removeStep } = useDeleteStrategyStep()

  const { trigger: fetchPositions } = useGetStrategyPositions()
  const { trigger: upsertPosition, error: upsertError } = useUpsertStrategyPosition()
  const { trigger: deletePosition, error: removeError } = useDeleteStrategyPosition()

  const { trigger: fetchOpponents } = useGetStrategyOpponentMarkers()
  const { trigger: createOpponent } = useCreateStrategyOpponentMarker()
  const { trigger: updateOpponent } = useUpdateStrategyOpponentMarker()
  const { trigger: removeOpponent } = useDeleteStrategyOpponentMarker()

  const { trigger: fetchArrows } = useGetStrategyArrows()
  const { trigger: createArrow } = useCreateStrategyArrow()
  const { trigger: updateArrow } = useUpdateStrategyArrow()
  const { trigger: removeArrow } = useDeleteStrategyArrow()

  const players = rawPlayers as Player[] | undefined

  const [selectedPlayId, setSelectedPlayId] = useState<number | null>(null)
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null)
  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map())
  const [opponents, setOpponents] = useState<StrategyOpponentMarker[]>([])
  const [arrows, setArrows] = useState<StrategyArrow[]>([])

  const [showCreate, setShowCreate] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [gameInput, setGameInput] = useState<string>(NO_GAME)

  useEffect(() => {
    fetchPlays()
    fetchPlayers()
    fetchGames()
  }, [])

  // Default the selection to the first play, and clear it if the selected
  // play was deleted (possibly by someone else, seen after a refetch).
  useEffect(() => {
    if (!plays) return
    if (selectedPlayId === null || !plays.some(p => p.id === selectedPlayId)) {
      setSelectedPlayId(plays[0]?.id ?? null)
    }
  }, [plays])

  const selectedPlay = (plays as StrategyPlay[] | undefined)?.find(p => p.id === selectedPlayId) ?? null
  const selectedGame = (games as Game[] | undefined)?.find(g => g.id === selectedPlay?.game_id) ?? null
  // Same upcoming-first, then most-recent-first ordering as the Schedule page.
  const sortedGames = sortGamesUpcomingFirst((games as Game[] | undefined) ?? [])
  const stepList = (steps as StrategyStep[] | undefined) ?? []
  const stepIndex = stepList.findIndex(s => s.id === selectedStepId)

  // Load this play's steps whenever it changes, defaulting to the first step.
  // Clearing the board here (not on every step change below) keeps a stale
  // play's placements from flashing while a different play's steps load.
  useEffect(() => {
    setSelectedStepId(null)
    setPositions(new Map())
    setOpponents([])
    setArrows([])
    if (selectedPlayId !== null) {
      fetchSteps({ playId: selectedPlayId }).then(rows => {
        if (rows && rows.length > 0) setSelectedStepId(rows[0]!.id)
      })
    }
  }, [selectedPlayId])

  // Fetch attendance and that game's season roster whenever the selected
  // play's assigned game changes. Scoping to the season roster first matters:
  // game_attendance only has rows for players actually on that season's
  // roster, so filtering the *global* player list by attendance alone barely
  // narrows anything (everyone else defaults to "attending" via row?.in ??
  // true, same as Quick Score's convention, since they have no row at all).
  useEffect(() => {
    if (selectedPlay?.game_id) {
      fetchAttendance({ gameId: selectedPlay.game_id })
      if (selectedGame?.season_id) {
        fetchSeasonRoster({ seasonId: selectedGame.season_id })
        fetchOtherPlayers({ seasonId: selectedGame.season_id })
      }
    }
  }, [selectedPlay?.game_id, selectedGame?.season_id])

  // Load positions/opponents/arrows whenever the selected step changes.
  // Deliberately does NOT clear state first: leaving the previous step's
  // positions in place until the new ones arrive is what lets a player
  // present in both steps slide from A to B (same key = same DOM node, so
  // StrategyBoard's left/top CSS transition animates the change) instead of
  // vanishing and popping back in at the new spot.
  const loadStepData = async (stepId: number) => {
    const [posRows, oppRows, arrowRows] = await Promise.all([
      fetchPositions({ stepId }),
      fetchOpponents({ stepId }),
      fetchArrows({ stepId }),
    ])
    if (posRows) setPositions(new Map(posRows.map(r => [r.player_id, { x: r.x, y: r.y }])))
    if (oppRows) setOpponents(oppRows)
    if (arrowRows) setArrows(arrowRows)
  }

  useEffect(() => {
    if (selectedStepId !== null) loadStepData(selectedStepId)
  }, [selectedStepId])

  // When a game is assigned, scope down to that game's season roster first
  // (matching the Schedule live-scoring convention), then filter by attendance on top
  // of that roster; missing attendance row still defaults to "attending".
  const boardPlayers = selectedPlay?.game_id
    ? ((selectedGame?.season_id ? (seasonRoster as Player[] | undefined) : players) ?? []).filter(p => {
        const row = (attendanceRows as { player_id: number; in: boolean }[] | undefined)?.find(r => r.player_id === p.id)
        return row?.in ?? true
      })
    : (players ?? [])

  // Players not already on the assigned game's season roster, offered in the
  // "Add player" combobox's "From other seasons" group (empty, and so
  // effectively hidden, when no game is assigned).
  const otherPlayerOptions = ((otherPlayers as { id: number; display_name: string }[] | undefined) ?? [])
    .map(p => ({ id: p.id.toString(), label: p.display_name }))

  const handlePlace = async (playerId: number, x: number, y: number) => {
    if (selectedStepId === null) return
    pushHistory()
    setPositions(prev => new Map(prev).set(playerId, { x, y }))
    const ok = await upsertPosition({ stepId: selectedStepId, playerId, x, y })
    if (!ok) loadStepData(selectedStepId)
  }

  const handleRemove = async (playerId: number) => {
    if (selectedStepId === null) return
    pushHistory()
    setPositions(prev => {
      const next = new Map(prev)
      next.delete(playerId)
      return next
    })
    const ok = await deletePosition({ stepId: selectedStepId, playerId })
    if (!ok) loadStepData(selectedStepId)
  }

  const handleAddOpponent = async () => {
    if (selectedStepId === null) return
    pushHistory()
    const label = `Opp ${opponents.length + 1}`
    const x = 0.5
    const y = Math.min(0.9, 0.15 + (opponents.length % 6) * 0.12)
    const tempId = -Date.now()
    setOpponents(prev => [...prev, { id: tempId, label, x, y }])
    const created = await trackCreate(createOpponent({ stepId: selectedStepId, label, x, y }))
    if (created) setOpponents(prev => prev.map(o => (o.id === tempId ? created : o)))
    else loadStepData(selectedStepId)
  }

  const handleMoveOpponent = async (id: number, x: number, y: number) => {
    pushHistory()
    setOpponents(prev => prev.map(o => (o.id === id ? { ...o, x, y } : o)))
    const ok = await updateOpponent({ id, x, y })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleRemoveOpponent = async (id: number) => {
    pushHistory()
    setOpponents(prev => prev.filter(o => o.id !== id))
    const ok = await removeOpponent({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  // A 'run' arrow anchored to a player drives that player's position in the
  // next step (if one already exists) — its head is where they end up.
  // Dragging them there afterward just overwrites it like any other
  // position, no different from a player with no arrow at all.
  const propagateRunArrowToNextStep = async (arrow: { arrow_type: 'run' | 'throw'; start_player_id: number | null | undefined; x2: number; y2: number }) => {
    if (arrow.arrow_type !== 'run' || arrow.start_player_id == null) return
    const nextStep = stepList[stepIndex + 1]
    if (!nextStep) return
    await upsertPosition({ stepId: nextStep.id, playerId: arrow.start_player_id, x: arrow.x2, y: arrow.y2 })
  }

  const handleCreateArrow = async (arrow: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id: number | null }) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setArrows(prev => [...prev, { id: tempId, ...arrow }])
    const created = await trackCreate(createArrow({ stepId: selectedStepId, ...arrow }))
    if (created) {
      setArrows(prev => prev.map(a => (a.id === tempId ? created : a)))
      await propagateRunArrowToNextStep(created)
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleUpdateArrow = async (arrow: { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null }) => {
    pushHistory()
    setArrows(prev => prev.map(a => (a.id === arrow.id ? { ...a, ...arrow } : a)))
    const ok = await updateArrow(arrow)
    if (!ok && selectedStepId !== null) {
      loadStepData(selectedStepId)
      return
    }
    const updated = arrows.find(a => a.id === arrow.id)
    if (updated) {
      const startPlayerId = arrow.start_player_id !== undefined ? arrow.start_player_id : updated.start_player_id
      await propagateRunArrowToNextStep({ arrow_type: updated.arrow_type, start_player_id: startPlayerId, x2: arrow.x2, y2: arrow.y2 })
    }
  }

  const handleDeleteArrow = async (id: number) => {
    pushHistory()
    setArrows(prev => prev.filter(a => a.id !== id))
    const ok = await removeArrow({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────
  // Per-step history of board snapshots. A change snapshots the board before
  // applying (in the handlers above and the batch handlers below); undo/redo
  // restore a snapshot and reconcile the database to match. Scoped to board
  // elements only — step/play/game structural changes are not undoable.
  const boardRef = useRef<Board>({ positions, opponents, arrows })
  boardRef.current = { positions, opponents, arrows }
  const cloneBoard = (b: Board): Board => ({
    positions: new Map(b.positions),
    opponents: b.opponents.map(o => ({ ...o })),
    arrows: b.arrows.map(a => ({ ...a })),
  })
  const historyRef = useRef<Map<number, { past: Board[]; future: Board[] }>>(new Map())
  // Guards against undo/redo firing while an optimistic insert is still in
  // flight. Reconcile matches items by id, so deleting or recreating one whose
  // real server id has not yet replaced its negative temp id would miss the DB
  // row and orphan it. Undo/redo no-op until creates settle and reconcile is idle.
  const pendingCreatesRef = useRef(0)
  const reconcilingRef = useRef(false)
  const trackCreate = <T,>(p: Promise<T>): Promise<T> => {
    pendingCreatesRef.current++
    return p.finally(() => { pendingCreatesRef.current-- })
  }
  function pushHistory(before: Board = boardRef.current) {
    if (selectedStepId === null) return
    const h = historyRef.current.get(selectedStepId) ?? { past: [], future: [] }
    h.past.push(cloneBoard(before))
    h.future = []
    historyRef.current.set(selectedStepId, h)
  }

  // Make the live board (local state + database) equal `target`, issuing the
  // minimal set of writes. Positions key on player_id (stable); opponents and
  // arrows key on id — a recreated row gets a fresh id, patched into local
  // state once the insert returns. The visual result always matches `target`.
  const reconcileBoard = async (target: Board) => {
    if (selectedStepId === null) return
    const stepId = selectedStepId
    const cur = boardRef.current
    const ops: Promise<unknown>[] = []
    reconcilingRef.current = true

    setPositions(new Map(target.positions))
    for (const [pid, pos] of target.positions) {
      const c = cur.positions.get(pid)
      if (!c || c.x !== pos.x || c.y !== pos.y) ops.push(upsertPosition({ stepId, playerId: pid, x: pos.x, y: pos.y }))
    }
    for (const [pid] of cur.positions) if (!target.positions.has(pid)) ops.push(deletePosition({ stepId, playerId: pid }))

    setOpponents(target.opponents.map(o => ({ ...o })))
    const curOpp = new Map(cur.opponents.map(o => [o.id, o]))
    const targetOppIds = new Set(target.opponents.map(o => o.id))
    for (const o of target.opponents) {
      const c = curOpp.get(o.id)
      if (!c) {
        const oldId = o.id
        ops.push(trackCreate(createOpponent({ stepId, label: o.label, x: o.x, y: o.y })).then(created => {
          if (created) setOpponents(prev => prev.map(p => (p.id === oldId ? created : p)))
          return !!created
        }))
      } else if (c.x !== o.x || c.y !== o.y) {
        ops.push(updateOpponent({ id: o.id, x: o.x, y: o.y }))
      }
    }
    for (const o of cur.opponents) if (!targetOppIds.has(o.id)) ops.push(removeOpponent({ id: o.id }))

    setArrows(target.arrows.map(a => ({ ...a })))
    const curArr = new Map(cur.arrows.map(a => [a.id, a]))
    const targetArrIds = new Set(target.arrows.map(a => a.id))
    for (const a of target.arrows) {
      const c = curArr.get(a.id)
      if (!c) {
        const oldId = a.id
        ops.push(trackCreate(createArrow({ stepId, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, cx: a.cx, cy: a.cy, arrow_type: a.arrow_type, start_player_id: a.start_player_id })).then(created => {
          if (created) setArrows(prev => prev.map(p => (p.id === oldId ? created : p)))
          return !!created
        }))
      } else if (c.x1 !== a.x1 || c.y1 !== a.y1 || c.x2 !== a.x2 || c.y2 !== a.y2 || c.cx !== a.cx || c.cy !== a.cy || c.start_player_id !== a.start_player_id) {
        ops.push(updateArrow({ id: a.id, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, cx: a.cx, cy: a.cy, start_player_id: a.start_player_id }))
      }
    }
    for (const a of cur.arrows) if (!targetArrIds.has(a.id)) ops.push(removeArrow({ id: a.id }))

    const results = await Promise.all(ops)
    reconcilingRef.current = false
    if (results.some(r => r === false || r === undefined)) loadStepData(stepId)
  }

  // Ignore undo/redo while a create is in flight or a reconcile is running, so
  // reconcile never matches against an id that is about to change.
  const historyBusy = () => reconcilingRef.current || pendingCreatesRef.current > 0

  const undo = () => {
    if (!allowed || selectedStepId === null || historyBusy()) return
    const h = historyRef.current.get(selectedStepId)
    if (!h || h.past.length === 0) return
    const prev = h.past.pop()!
    h.future.push(cloneBoard(boardRef.current))
    reconcileBoard(prev)
  }
  const redo = () => {
    if (!allowed || selectedStepId === null || historyBusy()) return
    const h = historyRef.current.get(selectedStepId)
    if (!h || h.future.length === 0) return
    const next = h.future.pop()!
    h.past.push(cloneBoard(boardRef.current))
    reconcileBoard(next)
  }
  const undoRef = useRef(undo); undoRef.current = undo
  const redoRef = useRef(redo); redoRef.current = redo

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.repeat) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoRef.current() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Delete every item in a multi-selection as one undoable action.
  const handleDeleteMany = async (items: BoardItem[]) => {
    if (selectedStepId === null || items.length === 0) return
    pushHistory()
    const stepId = selectedStepId
    const playerIds = items.filter(i => i.kind === 'player').map(i => i.id)
    const oppIds = items.filter(i => i.kind === 'opponent').map(i => i.id)
    const arrowIds = items.filter(i => i.kind === 'arrow').map(i => i.id)
    if (playerIds.length) setPositions(prev => { const m = new Map(prev); playerIds.forEach(id => m.delete(id)); return m })
    if (oppIds.length) setOpponents(prev => prev.filter(o => !oppIds.includes(o.id)))
    if (arrowIds.length) setArrows(prev => prev.filter(a => !arrowIds.includes(a.id)))
    const results = await Promise.all([
      ...playerIds.map(id => deletePosition({ stepId, playerId: id })),
      ...oppIds.map(id => removeOpponent({ id })),
      ...arrowIds.map(id => removeArrow({ id })),
    ])
    if (results.some(r => !r)) loadStepData(stepId)
  }

  // Live group move of a multi-selection. `start` captures the pre-move board
  // (so the whole drag is one undo), `preview` updates local state only as the
  // pointer moves, `commit` persists and records history, `cancel` reverts.
  const groupBeforeRef = useRef<Board | null>(null)
  const handleGroupMove = (moves: EntityMove[], phase: 'start' | 'preview' | 'commit' | 'cancel') => {
    if (selectedStepId === null) return
    const stepId = selectedStepId
    if (phase === 'start') { groupBeforeRef.current = cloneBoard(boardRef.current); return }
    if (phase === 'cancel') {
      const before = groupBeforeRef.current
      groupBeforeRef.current = null
      if (before) { setPositions(new Map(before.positions)); setOpponents(before.opponents.map(o => ({ ...o }))); setArrows(before.arrows.map(a => ({ ...a }))) }
      return
    }
    const playerMoves = moves.filter((m): m is Extract<EntityMove, { kind: 'player' }> => m.kind === 'player')
    const oppMoves = moves.filter((m): m is Extract<EntityMove, { kind: 'opponent' }> => m.kind === 'opponent')
    const arrowMoves = moves.filter((m): m is Extract<EntityMove, { kind: 'arrow' }> => m.kind === 'arrow')
    if (playerMoves.length) setPositions(prev => { const m = new Map(prev); playerMoves.forEach(mv => m.set(mv.id, { x: mv.x, y: mv.y })); return m })
    if (oppMoves.length) setOpponents(prev => prev.map(o => { const mv = oppMoves.find(m => m.id === o.id); return mv ? { ...o, x: mv.x, y: mv.y } : o }))
    if (arrowMoves.length) setArrows(prev => prev.map(a => { const mv = arrowMoves.find(m => m.id === a.id); return mv ? { ...a, x1: mv.x1, y1: mv.y1, x2: mv.x2, y2: mv.y2, cx: mv.cx, cy: mv.cy, start_player_id: mv.start_player_id } : a }))
    if (phase === 'commit') {
      const before = groupBeforeRef.current
      groupBeforeRef.current = null
      if (before) pushHistory(before)
      // Group-moved arrows detach (start_player_id: null), so there is no
      // anchored run arrow left to propagate into the next step.
      Promise.all([
        ...playerMoves.map(mv => upsertPosition({ stepId, playerId: mv.id, x: mv.x, y: mv.y })),
        ...oppMoves.map(mv => updateOpponent({ id: mv.id, x: mv.x, y: mv.y })),
        ...arrowMoves.map(mv => updateArrow({ id: mv.id, x1: mv.x1, y1: mv.y1, x2: mv.x2, y2: mv.y2, cx: mv.cx, cy: mv.cy, start_player_id: mv.start_player_id })),
      ]).then(results => { if (results.some(r => !r)) loadStepData(stepId) })
    }
  }

  const handleCreate = async () => {
    const name = nameInput.trim()
    if (!name) return
    const play = await createPlay({ name, game_id: gameInput === NO_GAME ? null : parseInt(gameInput) })
    if (play) {
      setShowCreate(false)
      setNameInput('')
      setGameInput(NO_GAME)
      await fetchPlays()
      setSelectedPlayId(play.id)
    }
  }

  const handleRename = async () => {
    const name = nameInput.trim()
    if (!name || selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, name })
    setShowRename(false)
    setNameInput('')
    fetchPlays()
  }

  const handleAssignGame = async (value: string) => {
    if (selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, game_id: value === NO_GAME ? null : parseInt(value) })
    fetchPlays()
  }

  const handleDelete = async () => {
    if (selectedPlayId === null) return
    await deletePlay({ id: selectedPlayId })
    setDeleteConfirm(false)
    fetchPlays()
  }

  // Refresh every list the "add player" combobox depends on after a change:
  // the global player list (for a brand new sub), the assigned game's
  // season roster and attendance (who's visible on the board), and the
  // "from other seasons" list (who's still offerable to add).
  const refreshPlayerLists = async () => {
    await fetchPlayers()
    if (selectedGame?.season_id) {
      await fetchSeasonRoster({ seasonId: selectedGame.season_id })
      await fetchOtherPlayers({ seasonId: selectedGame.season_id })
    }
    if (selectedPlay?.game_id) fetchAttendance({ gameId: selectedPlay.game_id })
  }

  // Creates a brand new sub. When a game is assigned, reuses the same
  // hook Schedule uses so the sub also lands in that game's lineup and
  // attendance, not just the season roster.
  const handleAddNewSub = async (name: string) => {
    if (selectedPlay?.game_id) {
      await createPlayerForGame({ display_name: name, gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id })
    } else {
      await createPlayer({ display_name: name, is_sub: true })
    }
    await refreshPlayerLists()
  }

  // Adds an existing player (e.g. from another season) onto this game's
  // roster, same hook Schedule uses for the equivalent flow.
  const handleAddExistingPlayer = async (playerId: string) => {
    if (!selectedPlay?.game_id) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id })
    await refreshPlayerLists()
  }

  const handleAddStep = async () => {
    if (selectedPlayId === null) return
    const step = await addStep({ playId: selectedPlayId })
    if (step) {
      // Seed the new step from the current one instead of starting empty:
      // a placed player keeps their position unless they have an outgoing
      // 'run' arrow anchored to them, in which case the arrow's head becomes
      // their starting position here. Opponent markers just carry over.
      const seeds: Promise<unknown>[] = []
      for (const [playerId, pos] of positions.entries()) {
        const runArrow = arrows.find(a => a.arrow_type === 'run' && a.start_player_id === playerId)
        const target = runArrow ? { x: runArrow.x2, y: runArrow.y2 } : pos
        seeds.push(upsertPosition({ stepId: step.id, playerId, x: target.x, y: target.y }))
      }
      for (const opp of opponents) {
        seeds.push(createOpponent({ stepId: step.id, label: opp.label, x: opp.x, y: opp.y }))
      }
      await Promise.all(seeds)
      await fetchSteps({ playId: selectedPlayId })
      setSelectedStepId(step.id)
    }
  }

  const handleDeleteStep = async () => {
    if (selectedStepId === null || stepList.length <= 1) return
    const deletedIndex = stepIndex
    await removeStep({ stepId: selectedStepId })
    const remaining = await fetchSteps({ playId: selectedPlayId! })
    if (remaining && remaining.length > 0) {
      setSelectedStepId(remaining[Math.max(0, deletedIndex - 1)]!.id)
    }
  }

  const saveError = upsertError || removeError

  if ((playsLoading && plays === undefined) || (playersLoading && players === undefined)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-foreground">Strategy</h1>
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="w-full aspect-[100/37] max-lg:aspect-auto max-lg:max-w-xl max-lg:h-[88vh] max-lg:mx-auto rounded-xl" />
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
                <Button onClick={() => { setNameInput(''); setGameInput(NO_GAME); setShowCreate(true) }}>
                  <Plus className="w-4 h-4 mr-1.5" />New play
                </Button>
              )}
            </CardContent>
          </Card>
        </FadeIn>
      ) : (
        <FadeIn>
          <div className="space-y-3">
            {/* Play-level controls: select, rename, delete, assign game. */}
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
                    onClick={() => { setNameInput(''); setGameInput(NO_GAME); setShowCreate(true) }}>
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

            {selectedPlay && (
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground shrink-0">Game</Label>
                <Select
                  value={selectedPlay.game_id ? String(selectedPlay.game_id) : NO_GAME}
                  onValueChange={handleAssignGame}
                  disabled={!allowed}
                >
                  <SelectTrigger className="flex-1 h-8 text-sm bg-card text-foreground border-border">
                    <SelectValue placeholder="No game assigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_GAME}>No game (full roster)</SelectItem>
                    {sortedGames.map(g => (
                      <SelectItem key={g.id} value={String(g.id)}>vs {g.opponent} — {g.game_date}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {allowed && (
                  <PlayerCombobox
                    players={[]}
                    otherPlayers={otherPlayerOptions}
                    value="__none__"
                    onValueChange={() => {}}
                    onAddPlayer={handleAddNewSub}
                    onAddExistingPlayer={handleAddExistingPlayer}
                    placeholder="Add player..."
                    className="h-8 text-sm bg-card border-border w-36 shrink-0"
                  />
                )}
              </div>
            )}

            {/* Step-level controls: numbered tabs, prev/next, add/delete step. */}
            {selectedPlay && stepList.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Previous step" disabled={stepIndex <= 0}
                  onClick={() => setSelectedStepId(stepList[stepIndex - 1]!.id)}>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                {stepList.map((step, i) => (
                  <Button
                    key={step.id}
                    size="sm"
                    variant={step.id === selectedStepId ? 'default' : 'outline'}
                    className="h-7 w-7 p-0 text-xs"
                    onClick={() => setSelectedStepId(step.id)}
                  >
                    {i + 1}
                  </Button>
                ))}
                <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Next step" disabled={stepIndex === -1 || stepIndex >= stepList.length - 1}
                  onClick={() => setSelectedStepId(stepList[stepIndex + 1]!.id)}>
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
                {allowed && (
                  <>
                    <Button variant="outline" size="icon" className="h-7 w-7" aria-label="Add step" onClick={handleAddStep}>
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" aria-label="Delete step"
                      disabled={stepList.length <= 1} onClick={handleDeleteStep}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </>
                )}
              </div>
            )}

            {saveError && (
              <div className="text-sm text-destructive">Failed to save: {saveError}</div>
            )}

            <StrategyBoard
              players={boardPlayers}
              positions={positions}
              opponents={opponents}
              arrows={arrows}
              allowed={allowed}
              onPlace={handlePlace}
              onRemove={handleRemove}
              onAddOpponent={handleAddOpponent}
              onMoveOpponent={handleMoveOpponent}
              onRemoveOpponent={handleRemoveOpponent}
              onCreateArrow={handleCreateArrow}
              onUpdateArrow={handleUpdateArrow}
              onDeleteArrow={handleDeleteArrow}
              onGroupMove={handleGroupMove}
              onDeleteMany={handleDeleteMany}
            />
            {allowed && (
              <p className="text-xs text-muted-foreground">
                Drag players from the bench onto the field. Drag a player off the field to bench them.
                Add opponent markers and drag them off the field to remove them. Toggle Draw arrow (or
                hold A) and drag on the field — or starting from a player — to add running or thrown-pass
                arrows. Use the numbered steps to build a sequence; Prev/Next slides everyone into place.
              </p>
            )}
          </div>
        </FadeIn>
      )}

      {/* Create play */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader><DialogTitle>New Play</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Play name (e.g. Vert stack)"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
              autoFocus
            />
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Game (optional)</Label>
              <Select value={gameInput} onValueChange={setGameInput}>
                <SelectTrigger className="bg-background border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_GAME}>No game (full roster)</SelectItem>
                  {sortedGames.map(g => (
                    <SelectItem key={g.id} value={String(g.id)}>vs {g.opponent} — {g.game_date}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
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
            This will permanently delete <strong>{selectedPlay?.name}</strong> and its steps and player placements. This cannot be undone.
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
