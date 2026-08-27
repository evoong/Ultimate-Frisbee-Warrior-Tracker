import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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
  useGetStrategyTextBoxes, useCreateStrategyTextBox, useUpdateStrategyTextBox, useDeleteStrategyTextBox,
  useGetStrategyArrows, useCreateStrategyArrow, useUpdateStrategyArrow, useDeleteStrategyArrow,
  useGetStrategyHighlights, useCreateStrategyHighlight, useUpdateStrategyHighlight, useDeleteStrategyHighlight,
  useGetStrategyLines, useCreateStrategyLine, useUpdateStrategyLine, useDeleteStrategyLine,
  type StrategyPlay, type StrategyStep, type StrategyOpponentMarker, type StrategyTextBox, type StrategyArrow, type StrategyHighlight, type StrategyLine,
  type StrategySelectedItem as BoardItem, type StrategyEntityMove as EntityMove,
} from '../hooks/backend/strategy'
import StrategyBoard from '../components/strategy/StrategyBoard'
import FadeIn from '../components/FadeIn'
import { Card, CardContent } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '../lib/shadcn/popover'
import { Label } from '../lib/shadcn/label'
import { Skeleton } from '../lib/shadcn/skeleton'
import { ClipboardList, Plus, Edit2, Trash2, ChevronLeft, ChevronRight, X, Settings2 } from 'lucide-react'

type Player = { id: number; display_name: string; photo_url: string | null; is_sub: boolean | null }
type Game = { id: number; opponent: string; game_date: string; game_time: string | null; season_id: number | null }

const NO_GAME = '__none__'

// How long the slide between steps takes. Persisted in localStorage (not the
// DB): it's a per-device viewing preference, not shared play data.
const TRANSITION_SPEED_KEY = 'ufwt_strategy_transition_ms'
const TRANSITION_SPEEDS = [
  { label: 'Slow', ms: 1200 },
  { label: 'Normal', ms: 700 },
  { label: 'Fast', ms: 350 },
  { label: 'Off', ms: 0 },
] as const
const DEFAULT_TRANSITION_MS: number = 1200

function loadTransitionMs(): number {
  const stored = Number(localStorage.getItem(TRANSITION_SPEED_KEY))
  return TRANSITION_SPEEDS.some(s => s.ms === stored) ? stored : DEFAULT_TRANSITION_MS
}

// Recomputes every default-labeled ("Opp N") marker's number to close any
// gaps left by an add/remove, so the labels on the field always read as a
// dense 1..M run — keeping lower numbers stable (removing the middle one
// shifts only the ones after it down by one, it doesn't reshuffle everyone).
// A marker renamed to custom text (via the pencil icon) no longer matches
// the pattern, so it's left untouched and doesn't consume a number slot.
// Returns only the ids that actually need to change.
function renumberedOpponentLabels(opps: StrategyOpponentMarker[]): Map<number, string> {
  const defaultLabeled = opps
    .map(o => ({ o, n: parseInt(o.label.replace(/^Opp\s*/i, ''), 10) }))
    .filter((e): e is { o: StrategyOpponentMarker; n: number } => /^Opp\s*\d+$/i.test(e.o.label) && !isNaN(e.n))
    .sort((a, b) => a.n - b.n)
  const changes = new Map<number, string>()
  defaultLabeled.forEach((e, i) => {
    const label = `Opp ${i + 1}`
    if (label !== e.o.label) changes.set(e.o.id, label)
  })
  return changes
}

// A full snapshot of one step's board, used for per-step undo/redo.
type Board = {
  positions: Map<number, { x: number; y: number }>
  opponents: StrategyOpponentMarker[]
  textBoxes: StrategyTextBox[]
  arrows: StrategyArrow[]
  highlights: StrategyHighlight[]
  lines: StrategyLine[]
}

export default function Strategy() {
  const { allowed, currentOrgId } = useAuth()
  const navigate = useNavigate()
  // The selected play mirrors this URL segment (see the "default to first
  // play" effect below), so a reload, browser back/forward, or a
  // bookmarked/shared link opens that play directly. Unlike Schedule's
  // selectedGame/Roster's selectedPlayer, this needs no local state or
  // by-id resolver: useGetStrategyPlays already loads every play in the
  // org unfiltered, so the param is just parsed straight through.
  const { playId: playIdParam } = useParams<{ playId: string }>()
  const [transitionMs, setTransitionMs] = useState<number>(loadTransitionMs)
  const handleTransitionSpeedChange = (ms: number) => {
    setTransitionMs(ms)
    localStorage.setItem(TRANSITION_SPEED_KEY, String(ms))
  }
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

  const { trigger: fetchTextBoxes } = useGetStrategyTextBoxes()
  const { trigger: createTextBox } = useCreateStrategyTextBox()
  const { trigger: updateTextBox } = useUpdateStrategyTextBox()
  const { trigger: removeTextBox } = useDeleteStrategyTextBox()

  const { trigger: fetchArrows } = useGetStrategyArrows()
  const { trigger: createArrow } = useCreateStrategyArrow()
  const { trigger: updateArrow } = useUpdateStrategyArrow()
  const { trigger: removeArrow } = useDeleteStrategyArrow()

  const { trigger: fetchHighlights } = useGetStrategyHighlights()
  const { trigger: createHighlight } = useCreateStrategyHighlight()
  const { trigger: updateHighlight } = useUpdateStrategyHighlight()
  const { trigger: removeHighlight } = useDeleteStrategyHighlight()

  const { trigger: fetchLines } = useGetStrategyLines()
  const { trigger: createLine } = useCreateStrategyLine()
  const { trigger: updateLine } = useUpdateStrategyLine()
  const { trigger: removeLine } = useDeleteStrategyLine()

  const players = rawPlayers as Player[] | undefined

  const selectedPlayId = playIdParam ? parseInt(playIdParam, 10) : null
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null)
  // Lets loadStepData (below) tell a stale response apart from the current
  // one — see its own comment for why this matters.
  const selectedStepIdRef = useRef(selectedStepId)
  selectedStepIdRef.current = selectedStepId
  const [positions, setPositions] = useState<Map<number, { x: number; y: number }>>(new Map())
  const [opponents, setOpponents] = useState<StrategyOpponentMarker[]>([])
  const [textBoxes, setTextBoxes] = useState<StrategyTextBox[]>([])
  const [arrows, setArrows] = useState<StrategyArrow[]>([])
  const [highlights, setHighlights] = useState<StrategyHighlight[]>([])
  const [lines, setLines] = useState<StrategyLine[]>([])


  const [showCreate, setShowCreate] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [gameInput, setGameInput] = useState<string>(NO_GAME)

  useEffect(() => {
    if (currentOrgId == null) return
    fetchPlays({ organizationId: currentOrgId })
    fetchPlayers({ organizationId: currentOrgId })
    fetchGames({ organizationId: currentOrgId })
  }, [currentOrgId])

  // Default the selection to the first play, and clear it if the selected
  // play was deleted (possibly by someone else, seen after a refetch).
  useEffect(() => {
    if (!plays) return
    if (selectedPlayId === null || !plays.some(p => p.id === selectedPlayId)) {
      if (plays[0]) navigate(`/plays/${plays[0].id}`, { replace: true })
      else if (playIdParam) navigate('/plays', { replace: true })
    }
  }, [plays, playIdParam])

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
    setTextBoxes([])
    setArrows([])
    setHighlights([])
    setLines([])
    if (selectedPlayId !== null) {
      fetchSteps({ playId: selectedPlayId }).then(rows => {
        if (rows && rows.length > 0) setSelectedStepId(rows[0]!.id)
      })
    }
  }, [selectedPlayId])

  // Fetch attendance and that game's season roster whenever the selected
  // play's assigned game changes. Scoping to the season roster first matters:
  // attendance (see useGetGameAttendance) only has rows for players actually
  // placed in a lineup for that game, so filtering the *global* player list
  // by attendance alone barely narrows anything (everyone else defaults to
  // "attending" via row?.in ?? true, same as the Events tab's convention,
  // since they have no row at all).
  useEffect(() => {
    if (currentOrgId == null) return
    if (selectedPlay?.game_id) {
      fetchAttendance({ gameId: selectedPlay.game_id })
      if (selectedGame?.season_id) {
        fetchSeasonRoster({ seasonId: selectedGame.season_id })
        fetchOtherPlayers({ seasonId: selectedGame.season_id, organizationId: currentOrgId })
      }
    }
  }, [selectedPlay?.game_id, selectedGame?.season_id, currentOrgId])

  // Load positions/opponents/arrows whenever the selected step changes.
  // Deliberately does NOT clear state first: leaving the previous step's
  // positions in place until the new ones arrive is what lets a player
  // present in both steps slide from A to B (same key = same DOM node, so
  // StrategyBoard's left/top CSS transition animates the change) instead of
  // vanishing and popping back in at the new spot.
  const loadStepData = async (stepId: number) => {
    const [posRows, oppRows, textRows, arrowRows, highlightRows, lineRows] = await Promise.all([
      fetchPositions({ stepId }),
      fetchOpponents({ stepId }),
      fetchTextBoxes({ stepId }),
      fetchArrows({ stepId }),
      fetchHighlights({ stepId }),
      fetchLines({ stepId }),
    ])
    // Clicking through steps quickly (e.g. tapping "Next" repeatedly) can
    // fire several of these concurrently with no guarantee they resolve in
    // request order. Applying a response for a step that's no longer
    // selected would jump an entity to that stale step's position instead of
    // sliding it to the current step's — a "teleport" rather than no
    // animation at all, and only for whichever handful of entities differ
    // between the two steps. Discarding stale responses outright (rather
    // than only the more common "landed after a newer one" case) is the
    // simplest rule that's still always correct.
    if (selectedStepIdRef.current !== stepId) return
    if (posRows) setPositions(new Map(posRows.map(r => [r.player_id, { x: r.x, y: r.y }])))
    if (oppRows) setOpponents(oppRows)
    if (textRows) setTextBoxes(textRows)
    if (arrowRows) setArrows(arrowRows)
    if (highlightRows) setHighlights(highlightRows)
    if (lineRows) setLines(lineRows)
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
    const ok = await upsertPosition({ stepId: selectedStepId, playerId, x, y, organizationId: currentOrgId })
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

  // Renumbers whatever default-labeled markers need it in `list` (see
  // renumberedOpponentLabels) and pushes the changed ones to local state +
  // the DB. Called after every add/remove so the field never shows a gap.
  const applyOpponentRenumber = async (list: StrategyOpponentMarker[]) => {
    const changes = renumberedOpponentLabels(list)
    if (changes.size === 0) return
    setOpponents(prev => prev.map(o => (changes.has(o.id) ? { ...o, label: changes.get(o.id)! } : o)))
    await Promise.all([...changes.entries()].map(([id, label]) => updateOpponent({ id, label })))
  }

  const handleAddOpponent = async () => {
    if (selectedStepId === null) return
    pushHistory()
    // Derived from the highest existing "Opp N" rather than opponents.length:
    // removing an opponent then adding a new one would otherwise reuse a
    // number still in use (e.g. remove "Opp 1" from ["Opp 1", "Opp 2"], then
    // add — length-based numbering would produce a duplicate "Opp 2").
    // StrategyBoard keys opponent markers by label, so duplicates would
    // also break React's key uniqueness within a step. Any pre-existing gap
    // (or a custom-renamed marker freeing up its old number) is closed
    // right after by applyOpponentRenumber below.
    const usedNumbers = opponents
      .map(o => parseInt(o.label.replace(/^Opp\s*/i, ''), 10))
      .filter(n => !isNaN(n))
    const label = `Opp ${(usedNumbers.length > 0 ? Math.max(...usedNumbers) : 0) + 1}`
    const x = 0.5
    const y = Math.min(0.9, 0.15 + (opponents.length % 6) * 0.12)
    const tempId = -Date.now()
    const withNew = [...opponents, { id: tempId, label, x, y }]
    setOpponents(withNew)
    const created = await trackCreate(createOpponent({ stepId: selectedStepId, label, x, y, organizationId: currentOrgId }))
    if (created) {
      const settled = withNew.map(o => (o.id === tempId ? created : o))
      setOpponents(settled)
      await applyOpponentRenumber(settled)
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleMoveOpponent = async (id: number, x: number, y: number) => {
    pushHistory()
    setOpponents(prev => prev.map(o => (o.id === id ? { ...o, x, y } : o)))
    const ok = await updateOpponent({ id, x, y })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleRenameOpponent = async (id: number, label: string) => {
    pushHistory()
    setOpponents(prev => prev.map(o => (o.id === id ? { ...o, label } : o)))
    const ok = await updateOpponent({ id, label })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleRemoveOpponent = async (id: number) => {
    pushHistory()
    const remaining = opponents.filter(o => o.id !== id)
    setOpponents(remaining)
    const ok = await removeOpponent({ id })
    if (!ok && selectedStepId !== null) { loadStepData(selectedStepId); return }
    await applyOpponentRenumber(remaining)
  }

  // Text boxes are free-floating annotations: no roster backing, no
  // auto-numbered label to keep dense (unlike opponent markers), so this is
  // simpler than the opponent handlers above — just create/move/edit/remove.
  const handleAddTextBox = async () => {
    if (selectedStepId === null) return
    pushHistory()
    const text = 'Text'
    const x = 0.5
    const y = Math.min(0.9, 0.15 + (textBoxes.length % 6) * 0.12)
    const tempId = -Date.now()
    const withNew = [...textBoxes, { id: tempId, text, x, y, color: null, filled: false, width: 0.12 }]
    setTextBoxes(withNew)
    const created = await trackCreate(createTextBox({ stepId: selectedStepId, text, x, y, organizationId: currentOrgId }))
    if (created) {
      setTextBoxes(withNew.map(t => (t.id === tempId ? created : t)))
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleMoveTextBox = async (id: number, x: number, y: number) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, x, y } : t)))
    const ok = await updateTextBox({ id, x, y })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleEditTextBox = async (id: number, text: string) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, text } : t)))
    const ok = await updateTextBox({ id, text })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleRemoveTextBox = async (id: number) => {
    pushHistory()
    setTextBoxes(prev => prev.filter(t => t.id !== id))
    const ok = await removeTextBox({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  // Color, filled background, and width are cosmetic, not part of a
  // "shape" the way position/text are, but still go through the same
  // optimistic-update/reconcile-on-failure/undo-snapshot shape as the
  // handlers above for consistency.
  const handleUpdateTextBoxStyle = async (id: number, patch: { color?: string | null; filled?: boolean; width?: number }) => {
    pushHistory()
    setTextBoxes(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)))
    const ok = await updateTextBox({ id, ...patch })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  // A 'run' arrow anchored to a player or opponent drives that entity's
  // position in the next step (if one already exists) — its head is where
  // they end up. Dragging them there afterward just overwrites it like any
  // other position, no different from an entity with no arrow at all.
  // Opponent markers have no persistent cross-step id (they're step-scoped
  // rows matched only by label, see handleAddStep), so propagating to them
  // means looking up the next step's marker with the same label and
  // updating it directly, instead of the upsert-by-id players get.
  const propagateRunArrowToNextStep = async (arrow: { arrow_type: 'run' | 'throw'; start_player_id: number | null | undefined; start_opponent_id: number | null | undefined; x2: number; y2: number }) => {
    if (arrow.arrow_type !== 'run') return
    const nextStep = stepList[stepIndex + 1]
    if (!nextStep) return
    if (arrow.start_player_id != null) {
      await upsertPosition({ stepId: nextStep.id, playerId: arrow.start_player_id, x: arrow.x2, y: arrow.y2, organizationId: currentOrgId })
    } else if (arrow.start_opponent_id != null) {
      const label = opponents.find(o => o.id === arrow.start_opponent_id)?.label
      if (!label) return
      const nextOpponents = await fetchOpponents({ stepId: nextStep.id })
      const target = nextOpponents?.find(o => o.label === label)
      if (target) await updateOpponent({ id: target.id, x: arrow.x2, y: arrow.y2 })
    }
  }

  const handleCreateArrow = async (arrow: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id: number | null; start_opponent_id: number | null }) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setArrows(prev => [...prev, { id: tempId, ...arrow }])
    const created = await trackCreate(createArrow({ stepId: selectedStepId, ...arrow, organizationId: currentOrgId }))
    if (created) {
      setArrows(prev => prev.map(a => (a.id === tempId ? created : a)))
      await propagateRunArrowToNextStep(created)
    } else {
      loadStepData(selectedStepId)
    }
  }

  const handleUpdateArrow = async (arrow: { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null; start_opponent_id?: number | null }) => {
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
      const startOpponentId = arrow.start_opponent_id !== undefined ? arrow.start_opponent_id : updated.start_opponent_id
      await propagateRunArrowToNextStep({ arrow_type: updated.arrow_type, start_player_id: startPlayerId, start_opponent_id: startOpponentId, x2: arrow.x2, y2: arrow.y2 })
    }
  }

  const handleDeleteArrow = async (id: number) => {
    pushHistory()
    setArrows(prev => prev.filter(a => a.id !== id))
    const ok = await removeArrow({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  // Highlighted zones: draw/recolor/reshape/lock/delete are each their own
  // undo step, same as arrows above (see the Board type below — highlights
  // and lines are both part of its snapshot).
  const handleCreateHighlight = async (points: { x: number; y: number }[], color: string, isStraight: boolean) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setHighlights(prev => [...prev, { id: tempId, points, color, is_straight: isStraight, locked: false }])
    const created = await trackCreate(createHighlight({ stepId: selectedStepId, points, color, organizationId: currentOrgId, isStraight }))
    if (created) setHighlights(prev => prev.map(h => (h.id === tempId ? created : h)))
    else loadStepData(selectedStepId)
  }

  const handleUpdateHighlightColor = async (id: number, color: string) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, color } : h)))
    const ok = await updateHighlight({ id, color })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateHighlightPoints = async (id: number, points: { x: number; y: number }[]) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, points } : h)))
    const ok = await updateHighlight({ id, points })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateHighlightLocked = async (id: number, locked: boolean) => {
    pushHistory()
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, locked } : h)))
    const ok = await updateHighlight({ id, locked })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleDeleteHighlight = async (id: number) => {
    pushHistory()
    setHighlights(prev => prev.filter(h => h.id !== id))
    const ok = await removeHighlight({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  // Plain unfilled lines: same undoable-optimistic-update/reconcile-on-failure
  // shape as highlights above.
  const handleCreateLine = async (points: { x: number; y: number }[], color: string, isStraight: boolean) => {
    if (selectedStepId === null) return
    pushHistory()
    const tempId = -Date.now()
    setLines(prev => [...prev, { id: tempId, points, color, is_straight: isStraight, locked: false }])
    const created = await trackCreate(createLine({ stepId: selectedStepId, points, color, organizationId: currentOrgId, isStraight }))
    if (created) setLines(prev => prev.map(l => (l.id === tempId ? created : l)))
    else loadStepData(selectedStepId)
  }

  const handleUpdateLineColor = async (id: number, color: string) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, color } : l)))
    const ok = await updateLine({ id, color })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateLinePoints = async (id: number, points: { x: number; y: number }[]) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, points } : l)))
    const ok = await updateLine({ id, points })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleUpdateLineLocked = async (id: number, locked: boolean) => {
    pushHistory()
    setLines(prev => prev.map(l => (l.id === id ? { ...l, locked } : l)))
    const ok = await updateLine({ id, locked })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  const handleDeleteLine = async (id: number) => {
    pushHistory()
    setLines(prev => prev.filter(l => l.id !== id))
    const ok = await removeLine({ id })
    if (!ok && selectedStepId !== null) loadStepData(selectedStepId)
  }

  // ── Undo / redo ─────────────────────────────────────────────────────────
  // Per-step history of board snapshots. A change snapshots the board before
  // applying (in the handlers above and the batch handlers below); undo/redo
  // restore a snapshot and reconcile the database to match. Scoped to board
  // elements only — step/play/game structural changes are not undoable.
  const boardRef = useRef<Board>({ positions, opponents, textBoxes, arrows, highlights, lines })
  boardRef.current = { positions, opponents, textBoxes, arrows, highlights, lines }
  const cloneBoard = (b: Board): Board => ({
    positions: new Map(b.positions),
    opponents: b.opponents.map(o => ({ ...o })),
    textBoxes: b.textBoxes.map(t => ({ ...t })),
    arrows: b.arrows.map(a => ({ ...a })),
    highlights: b.highlights.map(h => ({ ...h, points: h.points.map(p => ({ ...p })) })),
    lines: b.lines.map(l => ({ ...l, points: l.points.map(p => ({ ...p })) })),
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
      if (!c || c.x !== pos.x || c.y !== pos.y) ops.push(upsertPosition({ stepId, playerId: pid, x: pos.x, y: pos.y, organizationId: currentOrgId }))
    }
    for (const [pid] of cur.positions) if (!target.positions.has(pid)) ops.push(deletePosition({ stepId, playerId: pid }))

    setOpponents(target.opponents.map(o => ({ ...o })))
    const curOpp = new Map(cur.opponents.map(o => [o.id, o]))
    const targetOppIds = new Set(target.opponents.map(o => o.id))
    for (const o of target.opponents) {
      const c = curOpp.get(o.id)
      if (!c) {
        const oldId = o.id
        ops.push(trackCreate(createOpponent({ stepId, label: o.label, x: o.x, y: o.y, organizationId: currentOrgId })).then(created => {
          if (created) setOpponents(prev => prev.map(p => (p.id === oldId ? created : p)))
          return !!created
        }))
      } else if (c.x !== o.x || c.y !== o.y || c.label !== o.label) {
        ops.push(updateOpponent({ id: o.id, x: o.x, y: o.y, label: o.label }))
      }
    }
    for (const o of cur.opponents) if (!targetOppIds.has(o.id)) ops.push(removeOpponent({ id: o.id }))

    setTextBoxes(target.textBoxes.map(t => ({ ...t })))
    const curText = new Map(cur.textBoxes.map(t => [t.id, t]))
    const targetTextIds = new Set(target.textBoxes.map(t => t.id))
    for (const t of target.textBoxes) {
      const c = curText.get(t.id)
      if (!c) {
        const oldId = t.id
        ops.push(trackCreate(createTextBox({ stepId, text: t.text, x: t.x, y: t.y, organizationId: currentOrgId })).then(created => {
          if (created) setTextBoxes(prev => prev.map(p => (p.id === oldId ? created : p)))
          return !!created
        }))
      } else if (c.x !== t.x || c.y !== t.y || c.text !== t.text) {
        ops.push(updateTextBox({ id: t.id, x: t.x, y: t.y, text: t.text }))
      }
    }
    for (const t of cur.textBoxes) if (!targetTextIds.has(t.id)) ops.push(removeTextBox({ id: t.id }))

    setArrows(target.arrows.map(a => ({ ...a })))
    const curArr = new Map(cur.arrows.map(a => [a.id, a]))
    const targetArrIds = new Set(target.arrows.map(a => a.id))
    for (const a of target.arrows) {
      const c = curArr.get(a.id)
      if (!c) {
        const oldId = a.id
        ops.push(trackCreate(createArrow({ stepId, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, cx: a.cx, cy: a.cy, arrow_type: a.arrow_type, start_player_id: a.start_player_id, start_opponent_id: a.start_opponent_id, organizationId: currentOrgId })).then(created => {
          if (created) setArrows(prev => prev.map(p => (p.id === oldId ? created : p)))
          return !!created
        }))
      } else if (c.x1 !== a.x1 || c.y1 !== a.y1 || c.x2 !== a.x2 || c.y2 !== a.y2 || c.cx !== a.cx || c.cy !== a.cy || c.start_player_id !== a.start_player_id || c.start_opponent_id !== a.start_opponent_id) {
        ops.push(updateArrow({ id: a.id, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, cx: a.cx, cy: a.cy, start_player_id: a.start_player_id, start_opponent_id: a.start_opponent_id }))
      }
    }
    for (const a of cur.arrows) if (!targetArrIds.has(a.id)) ops.push(removeArrow({ id: a.id }))

    setHighlights(target.highlights.map(h => ({ ...h, points: h.points.map(p => ({ ...p })) })))
    const curHi = new Map(cur.highlights.map(h => [h.id, h]))
    const targetHiIds = new Set(target.highlights.map(h => h.id))
    for (const h of target.highlights) {
      const c = curHi.get(h.id)
      if (!c) {
        const oldId = h.id
        ops.push(trackCreate(createHighlight({ stepId, points: h.points, color: h.color, isStraight: h.is_straight, organizationId: currentOrgId })).then(created => {
          if (created) setHighlights(prev => prev.map(p => (p.id === oldId ? created : p)))
          return !!created
        }))
      } else if (c.color !== h.color || c.locked !== h.locked || JSON.stringify(c.points) !== JSON.stringify(h.points)) {
        ops.push(updateHighlight({ id: h.id, color: h.color, points: h.points, locked: h.locked }))
      }
    }
    for (const h of cur.highlights) if (!targetHiIds.has(h.id)) ops.push(removeHighlight({ id: h.id }))

    setLines(target.lines.map(l => ({ ...l, points: l.points.map(p => ({ ...p })) })))
    const curLn = new Map(cur.lines.map(l => [l.id, l]))
    const targetLnIds = new Set(target.lines.map(l => l.id))
    for (const l of target.lines) {
      const c = curLn.get(l.id)
      if (!c) {
        const oldId = l.id
        ops.push(trackCreate(createLine({ stepId, points: l.points, color: l.color, isStraight: l.is_straight, organizationId: currentOrgId })).then(created => {
          if (created) setLines(prev => prev.map(p => (p.id === oldId ? created : p)))
          return !!created
        }))
      } else if (c.color !== l.color || c.locked !== l.locked || JSON.stringify(c.points) !== JSON.stringify(l.points)) {
        ops.push(updateLine({ id: l.id, color: l.color, points: l.points, locked: l.locked }))
      }
    }
    for (const l of cur.lines) if (!targetLnIds.has(l.id)) ops.push(removeLine({ id: l.id }))

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
    const textIds = items.filter(i => i.kind === 'textbox').map(i => i.id)
    const arrowIds = items.filter(i => i.kind === 'arrow').map(i => i.id)
    const remainingOpponents = opponents.filter(o => !oppIds.includes(o.id))
    if (playerIds.length) setPositions(prev => { const m = new Map(prev); playerIds.forEach(id => m.delete(id)); return m })
    if (oppIds.length) setOpponents(remainingOpponents)
    if (textIds.length) setTextBoxes(prev => prev.filter(t => !textIds.includes(t.id)))
    if (arrowIds.length) setArrows(prev => prev.filter(a => !arrowIds.includes(a.id)))
    const results = await Promise.all([
      ...playerIds.map(id => deletePosition({ stepId, playerId: id })),
      ...oppIds.map(id => removeOpponent({ id })),
      ...textIds.map(id => removeTextBox({ id })),
      ...arrowIds.map(id => removeArrow({ id })),
    ])
    if (results.some(r => !r)) loadStepData(stepId)
    else if (oppIds.length) await applyOpponentRenumber(remainingOpponents)
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
      if (before) { setPositions(new Map(before.positions)); setOpponents(before.opponents.map(o => ({ ...o }))); setTextBoxes(before.textBoxes.map(t => ({ ...t }))); setArrows(before.arrows.map(a => ({ ...a }))) }
      return
    }
    const playerMoves = moves.filter((m): m is Extract<EntityMove, { kind: 'player' }> => m.kind === 'player')
    const oppMoves = moves.filter((m): m is Extract<EntityMove, { kind: 'opponent' }> => m.kind === 'opponent')
    const textMoves = moves.filter((m): m is Extract<EntityMove, { kind: 'textbox' }> => m.kind === 'textbox')
    const arrowMoves = moves.filter((m): m is Extract<EntityMove, { kind: 'arrow' }> => m.kind === 'arrow')
    if (playerMoves.length) setPositions(prev => { const m = new Map(prev); playerMoves.forEach(mv => m.set(mv.id, { x: mv.x, y: mv.y })); return m })
    if (oppMoves.length) setOpponents(prev => prev.map(o => { const mv = oppMoves.find(m => m.id === o.id); return mv ? { ...o, x: mv.x, y: mv.y } : o }))
    if (textMoves.length) setTextBoxes(prev => prev.map(t => { const mv = textMoves.find(m => m.id === t.id); return mv ? { ...t, x: mv.x, y: mv.y } : t }))
    if (arrowMoves.length) setArrows(prev => prev.map(a => { const mv = arrowMoves.find(m => m.id === a.id); return mv ? { ...a, x1: mv.x1, y1: mv.y1, x2: mv.x2, y2: mv.y2, cx: mv.cx, cy: mv.cy, start_player_id: mv.start_player_id, start_opponent_id: mv.start_opponent_id } : a }))
    if (phase === 'commit') {
      const before = groupBeforeRef.current
      groupBeforeRef.current = null
      if (before) pushHistory(before)
      // Group-moved arrows detach (start_player_id/start_opponent_id: null),
      // so there is no anchored run arrow left to propagate into the next step.
      Promise.all([
        ...playerMoves.map(mv => upsertPosition({ stepId, playerId: mv.id, x: mv.x, y: mv.y, organizationId: currentOrgId })),
        ...oppMoves.map(mv => updateOpponent({ id: mv.id, x: mv.x, y: mv.y })),
        ...textMoves.map(mv => updateTextBox({ id: mv.id, x: mv.x, y: mv.y })),
        ...arrowMoves.map(mv => updateArrow({ id: mv.id, x1: mv.x1, y1: mv.y1, x2: mv.x2, y2: mv.y2, cx: mv.cx, cy: mv.cy, start_player_id: mv.start_player_id, start_opponent_id: mv.start_opponent_id })),
      ]).then(results => { if (results.some(r => !r)) loadStepData(stepId) })
    }
  }

  const handleCreate = async () => {
    const name = nameInput.trim()
    if (!name) return
    const play = await createPlay({ name, game_id: gameInput === NO_GAME ? null : parseInt(gameInput), organizationId: currentOrgId })
    if (play) {
      setShowCreate(false)
      setNameInput('')
      setGameInput(NO_GAME)
      await fetchPlays({ organizationId: currentOrgId })
      navigate(`/plays/${play.id}`)
    }
  }

  const handleRename = async () => {
    const name = nameInput.trim()
    if (!name || selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, name })
    setShowRename(false)
    setNameInput('')
    fetchPlays({ organizationId: currentOrgId })
  }

  const handleAssignGame = async (value: string) => {
    if (selectedPlayId === null) return
    await updatePlay({ id: selectedPlayId, game_id: value === NO_GAME ? null : parseInt(value) })
    fetchPlays({ organizationId: currentOrgId })
  }

  const handleDelete = async () => {
    if (selectedPlayId === null) return
    await deletePlay({ id: selectedPlayId })
    setDeleteConfirm(false)
    fetchPlays({ organizationId: currentOrgId })
  }

  // Refresh every list the "add player" combobox depends on after a change:
  // the global player list (for a brand new sub), the assigned game's
  // season roster and attendance (who's visible on the board), and the
  // "from other seasons" list (who's still offerable to add).
  const refreshPlayerLists = async () => {
    await fetchPlayers({ organizationId: currentOrgId })
    if (selectedGame?.season_id) {
      await fetchSeasonRoster({ seasonId: selectedGame.season_id })
      await fetchOtherPlayers({ seasonId: selectedGame.season_id, organizationId: currentOrgId })
    }
    if (selectedPlay?.game_id) fetchAttendance({ gameId: selectedPlay.game_id })
  }

  // Creates a brand new sub. When a game is assigned, reuses the same
  // hook Schedule uses so the sub also lands in that game's lineup and
  // attendance, not just the season roster.
  const handleAddNewSub = async (name: string) => {
    if (selectedPlay?.game_id) {
      await createPlayerForGame({ display_name: name, gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id, organizationId: currentOrgId })
    } else {
      await createPlayer({ display_name: name, is_sub: true, organizationId: currentOrgId })
    }
    await refreshPlayerLists()
  }

  // Adds an existing player (e.g. from another season) onto this game's
  // roster, same hook Schedule uses for the equivalent flow.
  const handleAddExistingPlayer = async (playerId: string) => {
    if (!selectedPlay?.game_id) return
    await addPlayerToGame({ playerId: parseInt(playerId), gameId: selectedPlay.game_id, seasonId: selectedGame?.season_id, organizationId: currentOrgId })
    await refreshPlayerLists()
  }

  const handleAddStep = async () => {
    if (selectedPlayId === null) return
    const step = await addStep({ playId: selectedPlayId, organizationId: currentOrgId })
    if (step) {
      // Seed the new step from the current one instead of starting empty: a
      // placed player or opponent keeps their position unless they have an
      // outgoing 'run' arrow anchored to them, in which case the arrow's
      // head becomes their starting position here.
      const seeds: Promise<unknown>[] = []
      for (const [playerId, pos] of positions.entries()) {
        const runArrow = arrows.find(a => a.arrow_type === 'run' && a.start_player_id === playerId)
        const target = runArrow ? { x: runArrow.x2, y: runArrow.y2 } : pos
        seeds.push(upsertPosition({ stepId: step.id, playerId, x: target.x, y: target.y, organizationId: currentOrgId }))
      }
      for (const opp of opponents) {
        const runArrow = arrows.find(a => a.arrow_type === 'run' && a.start_opponent_id === opp.id)
        const target = runArrow ? { x: runArrow.x2, y: runArrow.y2 } : opp
        seeds.push(createOpponent({ stepId: step.id, label: opp.label, x: target.x, y: target.y, organizationId: currentOrgId }))
      }
      // Text boxes carry their text and position forward unchanged (they
      // don't anchor arrows, so there's no head-position case to handle).
      for (const box of textBoxes) {
        seeds.push(createTextBox({ stepId: step.id, text: box.text, x: box.x, y: box.y, organizationId: currentOrgId }))
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Strategy</h1>
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Strategy board settings"
            >
              <Settings2 className="w-5 h-5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Step transition speed</Label>
              <p className="text-xs text-muted-foreground">
                How long players and opponents take to slide into place when you switch steps.
              </p>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {TRANSITION_SPEEDS.map(s => (
                <button
                  key={s.label}
                  onClick={() => handleTransitionSpeedChange(s.ms)}
                  className={`py-1.5 rounded-md text-xs font-medium transition-colors ${
                    transitionMs === s.ms ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

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
                onValueChange={v => navigate(`/plays/${v}`)}
                onOpenChange={open => { if (open) fetchPlays({ organizationId: currentOrgId }) }}
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
                <Button variant="outline" size="icon" className="h-10 w-10 sm:h-7 sm:w-7" aria-label="Previous step" disabled={stepIndex <= 0}
                  onClick={() => setSelectedStepId(stepList[stepIndex - 1]!.id)}>
                  <ChevronLeft className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                </Button>
                {stepList.map((step, i) => (
                  <Button
                    key={step.id}
                    size="sm"
                    variant={step.id === selectedStepId ? 'default' : 'outline'}
                    className="h-10 w-10 sm:h-7 sm:w-7 p-0 text-sm sm:text-xs"
                    onClick={() => setSelectedStepId(step.id)}
                  >
                    {i + 1}
                  </Button>
                ))}
                <Button variant="outline" size="icon" className="h-10 w-10 sm:h-7 sm:w-7" aria-label="Next step" disabled={stepIndex === -1 || stepIndex >= stepList.length - 1}
                  onClick={() => setSelectedStepId(stepList[stepIndex + 1]!.id)}>
                  <ChevronRight className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                </Button>
                {allowed && (
                  <>
                    <Button variant="outline" size="icon" className="h-10 w-10 sm:h-7 sm:w-7" aria-label="Add step" onClick={handleAddStep}>
                      <Plus className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-10 w-10 sm:h-7 sm:w-7 text-destructive hover:text-destructive" aria-label="Delete step"
                      disabled={stepList.length <= 1} onClick={handleDeleteStep}>
                      <X className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
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
              textBoxes={textBoxes}
              arrows={arrows}
              highlights={highlights}
              lines={lines}
              allowed={allowed}
              onPlace={handlePlace}
              onRemove={handleRemove}
              onAddOpponent={handleAddOpponent}
              onMoveOpponent={handleMoveOpponent}
              onRemoveOpponent={handleRemoveOpponent}
              onRenameOpponent={handleRenameOpponent}
              onAddTextBox={handleAddTextBox}
              onMoveTextBox={handleMoveTextBox}
              onEditTextBox={handleEditTextBox}
              onUpdateTextBoxStyle={handleUpdateTextBoxStyle}
              onRemoveTextBox={handleRemoveTextBox}
              onCreateArrow={handleCreateArrow}
              onUpdateArrow={handleUpdateArrow}
              onDeleteArrow={handleDeleteArrow}
              onCreateHighlight={handleCreateHighlight}
              onUpdateHighlightColor={handleUpdateHighlightColor}
              onUpdateHighlightPoints={handleUpdateHighlightPoints}
              onUpdateHighlightLocked={handleUpdateHighlightLocked}
              onDeleteHighlight={handleDeleteHighlight}
              onCreateLine={handleCreateLine}
              onUpdateLineColor={handleUpdateLineColor}
              onUpdateLinePoints={handleUpdateLinePoints}
              onUpdateLineLocked={handleUpdateLineLocked}
              onDeleteLine={handleDeleteLine}
              onGroupMove={handleGroupMove}
              onDeleteMany={handleDeleteMany}
              transitionMs={transitionMs}
            />
            {allowed && (
              <p className="text-xs text-muted-foreground">
                Drag players from the bench onto the field. Drag a player off the field to bench them.
                Add opponent markers or text boxes and drag them off the field to remove them. Toggle
                Draw arrow (or hold A) and drag on the field — or starting from a player — to add running
                or thrown-pass arrows. Toggle Highlight and drag (Freehand) to trace a filled zone (a
                lane, a cone, an area to attack), or switch to Straight and tap out corners for
                perfectly straight edges — Enter or the checkmark finishes it, Escape cancels. Pencil and
                Straight Line work the same way but draw a plain unfilled line instead of a filled zone.
                Click a shape, then its pencil icon to recolor or the trash icon (or Delete) to remove
                it; a straight-drawn zone or line also shows a small handle on each corner you can drag
                to reshape it. Use the numbered steps to build a sequence; Prev/Next slides everyone into
                place.
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
