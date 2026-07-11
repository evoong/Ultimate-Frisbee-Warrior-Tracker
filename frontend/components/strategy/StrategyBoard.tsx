import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PlayerAvatar from '../PlayerAvatar'
import { Button } from '../../lib/shadcn/button'
import { useMediaQuery } from '../../lib/shadcn/use-media-query'
import { Pencil, UserPlus, Type, Trash2, Disc } from 'lucide-react'
import type { StrategyArrow, StrategyOpponentMarker, StrategyTextBox, StrategySelectedItem as SelectedItem, StrategyEntityMove as EntityMove } from '../../hooks/backend/strategy'

// Canonical coordinates are fractions in [0, 1] of a LANDSCAPE field:
// x along the 100m length (0 = left back line), y across the 37m width
// (0 = top sideline). On mobile the field renders in portrait (rotated
// 90 degrees clockwise, so the canonical left end zone is at the top)
// and the mapping below converts between the two frames.
//
// "Our" end zone is fixed at the canonical x=0 end (left in landscape, top
// in portrait) for every play — this is a diagramming tool, not a live
// scoreboard, so there's no per-play side-flip.

type BoardPlayer = { id: number; display_name: string; photo_url: string | null }

// "Danny Nguyen" -> "Danny N." — keeps player labels short enough to fit
// on the field without truncating into an unreadable ellipsis.
function shortName(name: string) {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return name
  return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`
}
type Entity = { kind: 'player'; id: number } | { kind: 'opponent'; id: number } | { kind: 'textbox'; id: number }

// Stable React key for an opponent marker across step changes: label when
// it's unique in this step (the normal case), else label + index so
// pre-existing duplicate-labeled data (see the call site) never collides.
function oppKey(all: StrategyOpponentMarker[], opp: StrategyOpponentMarker, index: number): string {
  const dupeCount = all.filter(o => o.label === opp.label).length
  return dupeCount > 1 ? `${opp.label}#${index}` : opp.label
}

type DragState = {
  entity: Entity
  pointerId: number
  origin: 'bench' | 'field'
  startX: number
  startY: number
  moved: boolean
}

type ArrowDraft = { x1: number; y1: number; x2: number; y2: number; pointerId: number; startPlayerId?: number; startOpponentId?: number }
type ArrowLive = { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number }

const DRAG_THRESHOLD_PX = 4
const MIN_ARROW_LENGTH = 0.02
const END_ZONE_FRACTION = 0.18

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}

// Canonical -> rendered percentage offsets within the field container.
function toRendered(x: number, y: number, landscape: boolean) {
  if (landscape) return { left: x * 100, top: y * 100 }
  return { left: (1 - y) * 100, top: x * 100 }
}

// One placed player: a plain CSS left/top transition between steps. (An
// earlier version animated anchored players along their outgoing arrow's
// curve via requestAnimationFrame; it stuttered in practice, so it was
// reverted in favor of this simple straight-line slide for everyone.)
function PlayerMarker({
  player, target, transitionMs, isDesktop, isDragSource, isSelected, onTop, drawArmed, allowed, onPointerDown,
}: {
  player: BoardPlayer
  target: { x: number; y: number }
  transitionMs: number
  isDesktop: boolean
  isDragSource: boolean
  isSelected: boolean
  onTop: boolean
  drawArmed: boolean
  allowed: boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
}) {
  const { left, top } = toRendered(target.x, target.y, isDesktop)
  return (
    <div
      onPointerDown={onPointerDown}
      className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center touch-none animate-in fade-in duration-300 ${
        allowed ? (drawArmed ? 'cursor-crosshair' : 'cursor-grab') : ''
      } ${isDragSource ? 'opacity-40' : 'transition-[left,top] ease-in-out'}`}
      style={{ left: `${left}%`, top: `${top}%`, zIndex: onTop ? 20 : 10, transitionDuration: `${transitionMs}ms` }}
    >
      <div className={`rounded-full ${isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}>
        <PlayerAvatar photoUrl={player.photo_url} name={player.display_name} size="sm" />
      </div>
      <span className="text-[9px] font-medium text-foreground bg-background/70 rounded px-1 mt-0.5 max-w-16 truncate">
        {shortName(player.display_name)}
      </span>
    </div>
  )
}

// Pointer position (fraction of the field container) -> canonical coords.
function toCanonical(relLeft: number, relTop: number, landscape: boolean) {
  if (landscape) return { x: clamp01(relLeft), y: clamp01(relTop) }
  return { x: clamp01(relTop), y: clamp01(1 - relLeft) }
}

// On-curve point at t=0.5 of a quadratic Bezier (P0, C, P2): the point a bend
// handle sits on and drags. Also used to place the throw-arrow disc icon.
function onCurveMidpoint(a: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number }) {
  return { x: 0.25 * a.x1 + 0.5 * a.cx + 0.25 * a.x2, y: 0.25 * a.y1 + 0.5 * a.cy + 0.25 * a.y2 }
}

// Solve the control point so the curve passes through handle H at t=0.5:
// H = 0.25*P0 + 0.5*C + 0.25*P2  =>  C = 2H - 0.5*(P0 + P2)
function bendControlPoint(x1: number, y1: number, x2: number, y2: number, hx: number, hy: number) {
  return { cx: 2 * hx - 0.5 * (x1 + x2), cy: 2 * hy - 0.5 * (y1 + y2) }
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

export default function StrategyBoard({
  players, positions, opponents, textBoxes, arrows, allowed,
  onPlace, onRemove, onAddOpponent, onMoveOpponent, onRemoveOpponent, onRenameOpponent,
  onAddTextBox, onMoveTextBox, onEditTextBox, onRemoveTextBox,
  onCreateArrow, onUpdateArrow, onDeleteArrow,
  onGroupMove, onDeleteMany,
  transitionMs = 700,
}: {
  players: BoardPlayer[]
  positions: Map<number, { x: number; y: number }>
  opponents: StrategyOpponentMarker[]
  textBoxes: StrategyTextBox[]
  arrows: StrategyArrow[]
  allowed: boolean
  onPlace: (playerId: number, x: number, y: number) => void
  onRemove: (playerId: number) => void
  onAddOpponent: () => void
  onMoveOpponent: (id: number, x: number, y: number) => void
  onRemoveOpponent: (id: number) => void
  onRenameOpponent: (id: number, label: string) => void
  onAddTextBox: () => void
  onMoveTextBox: (id: number, x: number, y: number) => void
  onEditTextBox: (id: number, text: string) => void
  onRemoveTextBox: (id: number) => void
  onCreateArrow: (arrow: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id: number | null; start_opponent_id: number | null }) => void
  onUpdateArrow: (arrow: { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null; start_opponent_id?: number | null }) => void
  onDeleteArrow: (id: number) => void
  onGroupMove: (moves: EntityMove[], phase: 'start' | 'preview' | 'commit' | 'cancel') => void
  onDeleteMany: (items: SelectedItem[]) => void
  // How long the slide between steps takes, in ms. Set from the Strategy
  // page's Settings menu (persisted in localStorage); the Tailwind duration
  // classes can't take a runtime value, so this drives an inline
  // transitionDuration alongside a static transition-[left,top] class.
  transitionMs?: number
}) {
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const hasHover = useMediaQuery('(hover: hover)')
  const fieldRef = useRef<HTMLDivElement>(null)
  // The ref is the authoritative drag state, updated synchronously inside the
  // event handlers; the state is only a render mirror for the ghost and the
  // source dimming. React commits pointermove updates at continuous (deferred)
  // priority, so a flick whose pointermove and pointerup land in the same
  // frame would read a stale moved=false from state and skip the drop.
  const dragRef = useRef<DragState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  // The ghost that follows the pointer is positioned imperatively (below) so it
  // tracks the cursor at pointer-event rate, with no per-move React render. The
  // ref holds the latest pointer position for the ghost's initial mount frame.
  const pointerPosRef = useRef({ x: 0, y: 0 })
  const ghostRef = useRef<HTMLDivElement>(null)
  // The last placed circle the user grabbed; it renders above the others so
  // overlapping circles stay individually reachable. Keyed by "kind-id" since
  // players and opponents have independent id spaces.
  const [lastActiveKey, setLastActiveKey] = useState<string | null>(null)
  const updateDrag = (d: DragState | null) => {
    dragRef.current = d
    setDrag(d)
  }
  // Removes whatever window listeners the current drag installed. Stored in a
  // ref so both the drag's own pointerup and the unmount cleanup can call it.
  const teardownRef = useRef<() => void>(() => {})
  useEffect(() => () => teardownRef.current(), [])

  // ── Arrow drawing / editing mode ──────────────────────────────────────────
  const [mode, setMode] = useState<'move' | 'draw'>('move')
  const [arrowType, setArrowType] = useState<'run' | 'throw'>('run')
  const [aArmed, setAArmed] = useState(false)
  // A multi-selection shared by players, opponents, and arrows. Click selects
  // one (replacing); Cmd/Ctrl+click toggles membership. Delete/Backspace
  // removes everything selected (benching players, deleting opponents/arrows);
  // dragging a member moves the whole set. Escape, or a click on empty field,
  // clears it.
  const [selected, setSelected] = useState<SelectedItem[]>([])
  const isSel = (kind: SelectedItem['kind'], id: number) => selected.some(s => s.kind === kind && s.id === id)
  const toggleSelected = (item: SelectedItem) =>
    setSelected(prev => prev.some(s => s.kind === item.kind && s.id === item.id)
      ? prev.filter(s => !(s.kind === item.kind && s.id === item.id))
      : [...prev, item])
  // Handles (the tap-to-edit affordance) show only when a single arrow is
  // selected; a multi-selection is for delete/move, not per-handle editing.
  const selectedArrowId = selected.length === 1 && selected[0].kind === 'arrow' ? selected[0].id : null
  // Same one-at-a-time rule for the opponent label editor: a pencil icon
  // appears only when exactly one opponent marker is selected.
  const selectedOpponentId = selected.length === 1 && selected[0].kind === 'opponent' ? selected[0].id : null
  const [editingOpponentId, setEditingOpponentId] = useState<number | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState('')
  const commitOpponentLabel = () => {
    const id = editingOpponentId
    setEditingOpponentId(null)
    if (id == null) return
    const trimmed = editingLabelValue.trim()
    const original = opponents.find(o => o.id === id)?.label
    if (trimmed && trimmed !== original) onRenameOpponent(id, trimmed)
  }
  // Same one-at-a-time rule for the text box editor: a pencil icon appears
  // only when exactly one text box is selected.
  const selectedTextBoxId = selected.length === 1 && selected[0].kind === 'textbox' ? selected[0].id : null
  const [editingTextBoxId, setEditingTextBoxId] = useState<number | null>(null)
  const [editingTextValue, setEditingTextValue] = useState('')
  const commitTextBoxText = () => {
    const id = editingTextBoxId
    setEditingTextBoxId(null)
    if (id == null) return
    const trimmed = editingTextValue.trim()
    const original = textBoxes.find(t => t.id === id)?.text
    if (trimmed !== original) onEditTextBox(id, trimmed)
  }
  // Refs so the window keydown listener (registered once) always sees the
  // latest selection and delete action without re-subscribing every render.
  const selectedRef = useRef<SelectedItem[]>(selected)
  selectedRef.current = selected
  const deleteSelectedRef = useRef<() => void>(() => {})
  deleteSelectedRef.current = () => {
    if (!allowed || selectedRef.current.length === 0) return
    onDeleteMany(selectedRef.current)
    setSelected([])
  }
  // Drop from the selection anything the board no longer contains (after a
  // delete, undo, or a teammate's change) so stale ids never linger selected.
  useEffect(() => {
    setSelected(prev => {
      const next = prev.filter(s =>
        s.kind === 'player' ? positions.has(s.id)
          : s.kind === 'opponent' ? opponents.some(o => o.id === s.id)
            : s.kind === 'textbox' ? textBoxes.some(t => t.id === s.id)
              : arrows.some(a => a.id === s.id))
      return next.length === prev.length ? prev : next
    })
    setEditingOpponentId(id => (id != null && !opponents.some(o => o.id === id) ? null : id))
    setEditingTextBoxId(id => (id != null && !textBoxes.some(t => t.id === id) ? null : id))
  }, [positions, opponents, textBoxes, arrows])
  // On hover-capable devices the edit handles reveal only while the pointer is
  // over the arrow (arrows stay clean otherwise); touch has no hover, so the
  // tap-selected arrow shows them instead. The short clear-delay keeps the
  // handles from flickering out as the pointer crosses from the line onto a
  // handle sitting on top of it.
  const [hoveredArrowId, setHoveredArrowId] = useState<number | null>(null)
  // An arrow selected by a touch/pen tap (not a mouse) shows its handles from
  // the selection alone, since a tap leaves no sustained hover. Gating on the
  // selecting pointer's type — not the device's hover capability — is what
  // lets a hybrid touchscreen laptop (which reports hover:hover) still edit
  // arrows by finger.
  const [touchArrowId, setTouchArrowId] = useState<number | null>(null)
  const hoverClearRef = useRef<number | null>(null)
  const keepArrowHover = (id: number) => {
    if (hoverClearRef.current !== null) { clearTimeout(hoverClearRef.current); hoverClearRef.current = null }
    setHoveredArrowId(id)
  }
  const scheduleArrowHoverClear = () => {
    if (hoverClearRef.current !== null) clearTimeout(hoverClearRef.current)
    hoverClearRef.current = window.setTimeout(() => { setHoveredArrowId(null); hoverClearRef.current = null }, 80)
  }
  useEffect(() => () => { if (hoverClearRef.current !== null) clearTimeout(hoverClearRef.current) }, [])
  const [drawingArrow, setDrawingArrow] = useState<ArrowDraft | null>(null)
  const drawArrowRef = useRef<ArrowDraft | null>(null)
  // While a selected arrow's handle is being dragged, this overrides its
  // rendered coordinates so the curve updates live before the save completes.
  const [liveArrowEdit, setLiveArrowEdit] = useState<ArrowLive | null>(null)
  const arrowDragTeardownRef = useRef<() => void>(() => {})
  useEffect(() => () => arrowDragTeardownRef.current(), [])

  const drawArmed = allowed && (mode === 'draw' || aArmed)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSelected([]); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current.length > 0 && !isTypingTarget(e.target)) {
        e.preventDefault()
        deleteSelectedRef.current()
        return
      }
      if (e.repeat || e.key.toLowerCase() !== 'a' || e.metaKey || e.ctrlKey || isTypingTarget(e.target)) return
      setAArmed(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'a') return
      setAArmed(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const placed = players.filter(p => positions.has(p.id))
  const bench = players.filter(p => !positions.has(p.id))
  const dragPlayer = drag?.entity.kind === 'player' ? players.find(p => p.id === drag.entity.id) : undefined

  // The move/up/cancel handlers live on window for the duration of a drag, not
  // on the dragged avatar. Relying on the avatar's own pointerup (via pointer
  // capture) meant a release over an overlapping circle or empty field, or a
  // browser-issued pointercancel, could land on an element with no handler and
  // silently skip the drop. Window listeners catch the release wherever it
  // happens; capture is no longer needed.
  const handlePointerDown = (entity: Entity, origin: 'bench' | 'field') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!allowed) return
      e.stopPropagation() // don't let the field's own handler also start an arrow draw
      if (drawArmed && (entity.kind === 'player' || entity.kind === 'opponent')) {
        const start = entity.kind === 'player' ? positions.get(entity.id) : opponents.find(o => o.id === entity.id)
        if (start) {
          beginArrowDraw(
            e.pointerId, start.x, start.y,
            entity.kind === 'player' ? entity.id : undefined,
            entity.kind === 'opponent' ? entity.id : undefined,
          )
        }
        return
      }
      // Text boxes don't anchor arrows — a draw-mode pointer-down on one
      // falls through to the normal move/select handling below instead.
      // Cmd/Ctrl+click a field entity toggles its membership in the selection
      // (no drag). On the bench there's nothing to gather, so ignore it.
      if (e.metaKey || e.ctrlKey) {
        if (origin === 'field') toggleSelected(entity)
        return
      }
      // Dragging an entity that's part of a multi-selection moves the whole
      // set together; otherwise plain-clicking it selects just it.
      if (origin === 'field') {
        if (selected.length > 1 && isSel(entity.kind, entity.id)) {
          beginGroupDrag(e, entity)
          return
        }
        setSelected([entity])
      }
      teardownRef.current() // defensively end any drag still in flight
      if (origin === 'field') setLastActiveKey(`${entity.kind}-${entity.id}`)
      pointerPosRef.current = { x: e.clientX, y: e.clientY }
      updateDrag({ entity, pointerId: e.pointerId, origin, startX: e.clientX, startY: e.clientY, moved: false })

      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d || ev.pointerId !== d.pointerId) return
        pointerPosRef.current = { x: ev.clientX, y: ev.clientY }
        // Track the cursor imperatively — no React render per pointer event.
        const g = ghostRef.current
        if (g) { g.style.left = `${ev.clientX}px`; g.style.top = `${ev.clientY}px` }
        const moved = d.moved
          || Math.abs(ev.clientX - d.startX) > DRAG_THRESHOLD_PX
          || Math.abs(ev.clientY - d.startY) > DRAG_THRESHOLD_PX
        if (!moved) return
        // One render on the first threshold cross to mount the ghost and dim the
        // source; the ghost's position is imperative from here on.
        if (!d.moved) updateDrag({ ...d, moved: true })
      }
      const onUp = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d || ev.pointerId !== d.pointerId) return
        teardown()
        updateDrag(null)
        // A tap (no drag) just leaves the selection set on pointer-down in
        // place; only an actual drag places/benches the entity.
        if (!d.moved) return
        const rect = fieldRef.current?.getBoundingClientRect()
        if (!rect) return
        const inside = ev.clientX >= rect.left && ev.clientX <= rect.right
          && ev.clientY >= rect.top && ev.clientY <= rect.bottom
        if (inside) {
          const relLeft = (ev.clientX - rect.left) / rect.width
          const relTop = (ev.clientY - rect.top) / rect.height
          const { x, y } = toCanonical(relLeft, relTop, isDesktop)
          if (d.entity.kind === 'player') onPlace(d.entity.id, x, y)
          else if (d.entity.kind === 'opponent') onMoveOpponent(d.entity.id, x, y)
          else onMoveTextBox(d.entity.id, x, y)
        } else if (d.entity.kind === 'player' && d.origin === 'field') {
          // Any off-field drop returns a player to the bench.
          onRemove(d.entity.id)
        } else if (d.entity.kind === 'opponent') {
          // Opponents have no bench; any off-field drop deletes the marker.
          onRemoveOpponent(d.entity.id)
        } else if (d.entity.kind === 'textbox') {
          // Text boxes have no bench either; any off-field drop deletes it.
          onRemoveTextBox(d.entity.id)
        }
      }
      const onCancel = (ev: PointerEvent) => {
        const d = dragRef.current
        if (d && ev.pointerId !== d.pointerId) return
        teardown()
        updateDrag(null)
      }
      const teardown = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        teardownRef.current = () => {}
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      teardownRef.current = teardown
    }

  // Live group move: translate every selected item by the pointer delta and
  // stream previews to the page, committing once on release. Arrows translate
  // all six curve coordinates so the whole shape shifts. A release without
  // movement collapses the selection down to the grabbed item.
  const beginGroupDrag = (e: React.PointerEvent, grabbed: Entity) => {
    const pointerId = e.pointerId
    const rect0 = fieldRef.current?.getBoundingClientRect()
    if (!rect0) return
    teardownRef.current()
    const startCanon = toCanonical((e.clientX - rect0.left) / rect0.width, (e.clientY - rect0.top) / rect0.height, isDesktop)
    const origPlayers = selected.filter(s => s.kind === 'player')
      .map(s => ({ id: s.id, pos: positions.get(s.id) }))
      .filter((p): p is { id: number; pos: { x: number; y: number } } => !!p.pos)
    const origOpps = selected.filter(s => s.kind === 'opponent')
      .map(s => opponents.find(o => o.id === s.id))
      .filter((o): o is StrategyOpponentMarker => !!o)
    const origBoxes = selected.filter(s => s.kind === 'textbox')
      .map(s => textBoxes.find(t => t.id === s.id))
      .filter((t): t is StrategyTextBox => !!t)
    const origArrows = selected.filter(s => s.kind === 'arrow')
      .map(s => arrows.find(a => a.id === s.id))
      .filter((a): a is StrategyArrow => !!a)
    // Clamp the shared delta (not each coordinate) so the whole group stays
    // rigid at the field edges instead of deforming. Arrows detach from any
    // anchored player or opponent on a group move so all six coordinates
    // translate and render as-is (an anchored tail would otherwise be
    // re-pinned to its anchor and ignore the move).
    const allX = [...origPlayers.map(p => p.pos.x), ...origOpps.map(o => o.x), ...origBoxes.map(t => t.x), ...origArrows.flatMap(a => [a.x1, a.x2, a.cx])]
    const allY = [...origPlayers.map(p => p.pos.y), ...origOpps.map(o => o.y), ...origBoxes.map(t => t.y), ...origArrows.flatMap(a => [a.y1, a.y2, a.cy])]
    const minDx = allX.length ? -Math.min(...allX) : 0
    const maxDx = allX.length ? 1 - Math.max(...allX) : 0
    const minDy = allY.length ? -Math.min(...allY) : 0
    const maxDy = allY.length ? 1 - Math.max(...allY) : 0
    const computeMoves = (dxRaw: number, dyRaw: number): EntityMove[] => {
      const dx = Math.min(maxDx, Math.max(minDx, dxRaw))
      const dy = Math.min(maxDy, Math.max(minDy, dyRaw))
      return [
        ...origPlayers.map(p => ({ kind: 'player' as const, id: p.id, x: p.pos.x + dx, y: p.pos.y + dy })),
        ...origOpps.map(o => ({ kind: 'opponent' as const, id: o.id, x: o.x + dx, y: o.y + dy })),
        ...origBoxes.map(t => ({ kind: 'textbox' as const, id: t.id, x: t.x + dx, y: t.y + dy })),
        ...origArrows.map(a => ({ kind: 'arrow' as const, id: a.id, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy, cx: a.cx + dx, cy: a.cy + dy, start_player_id: null, start_opponent_id: null })),
      ]
    }
    let moved = false
    onGroupMove([], 'start')
    const deltaFrom = (ev: PointerEvent) => {
      const rect = fieldRef.current?.getBoundingClientRect()
      if (!rect) return null
      const canon = toCanonical((ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height, isDesktop)
      return { dx: canon.x - startCanon.x, dy: canon.y - startCanon.y }
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (!moved && Math.abs(ev.clientX - e.clientX) <= DRAG_THRESHOLD_PX && Math.abs(ev.clientY - e.clientY) <= DRAG_THRESHOLD_PX) return
      moved = true
      const d = deltaFrom(ev)
      if (d) onGroupMove(computeMoves(d.dx, d.dy), 'preview')
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      teardown()
      if (!moved) { setSelected([grabbed]); onGroupMove([], 'cancel'); return }
      const d = deltaFrom(ev)
      if (d) onGroupMove(computeMoves(d.dx, d.dy), 'commit')
      else onGroupMove([], 'cancel')
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      teardown()
      onGroupMove([], 'cancel')
    }
    const teardown = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      teardownRef.current = () => {}
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    teardownRef.current = teardown
  }

  // ── Arrow drawing ──────────────────────────────────────────────────────────
  // startPlayerId/startOpponentId is set only when the drag began on a player
  // avatar or opponent marker (not empty field): the arrow's tail is then
  // anchored to that entity — tracking it live if dragged within the step,
  // and (for 'run' arrows anchored to a player) its head drives their
  // position in the next step. At most one of the two is ever set.
  const beginArrowDraw = (pointerId: number, x1: number, y1: number, startPlayerId?: number, startOpponentId?: number) => {
    arrowDragTeardownRef.current() // defensively end any handle-drag still in flight
    const initial: ArrowDraft = { x1, y1, x2: x1, y2: y1, pointerId, startPlayerId, startOpponentId }
    drawArrowRef.current = initial
    setDrawingArrow(initial)

    const onMove = (ev: PointerEvent) => {
      const d = drawArrowRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      const rect = fieldRef.current?.getBoundingClientRect()
      if (!rect) return
      const relLeft = (ev.clientX - rect.left) / rect.width
      const relTop = (ev.clientY - rect.top) / rect.height
      const { x, y } = toCanonical(relLeft, relTop, isDesktop)
      const next = { ...d, x2: x, y2: y }
      drawArrowRef.current = next
      setDrawingArrow(next)
    }
    const onUp = (ev: PointerEvent) => {
      const d = drawArrowRef.current
      if (!d || ev.pointerId !== d.pointerId) return
      teardown()
      drawArrowRef.current = null
      setDrawingArrow(null)
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < MIN_ARROW_LENGTH) return // treat as a tap, not a draw
      onCreateArrow({
        x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, cx: (d.x1 + d.x2) / 2, cy: (d.y1 + d.y2) / 2,
        arrow_type: arrowType, start_player_id: d.startPlayerId ?? null, start_opponent_id: d.startOpponentId ?? null,
      })
    }
    const onCancel = (ev: PointerEvent) => {
      if (drawArrowRef.current?.pointerId !== ev.pointerId) return
      teardown()
      drawArrowRef.current = null
      setDrawingArrow(null)
    }
    const teardown = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  const handleFieldPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawArmed) {
      if (selected.length) setSelected([])
      return
    }
    const rect = fieldRef.current?.getBoundingClientRect()
    if (!rect) return
    const relLeft = (e.clientX - rect.left) / rect.width
    const relTop = (e.clientY - rect.top) / rect.height
    const { x, y } = toCanonical(relLeft, relTop, isDesktop)
    beginArrowDraw(e.pointerId, x, y)
  }

  // Dragging a selected arrow's start/end/bend handle.
  const beginHandleDrag = (arrow: StrategyArrow, handle: 'start' | 'end' | 'bend') =>
    (e: React.PointerEvent) => {
      if (!allowed) return
      e.stopPropagation()
      teardownRef.current() // defensively end any entity drag still in flight
      let current: ArrowLive = { id: arrow.id, x1: arrow.x1, y1: arrow.y1, x2: arrow.x2, y2: arrow.y2, cx: arrow.cx, cy: arrow.cy }
      const pointerId = e.pointerId

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        const rect = fieldRef.current?.getBoundingClientRect()
        if (!rect) return
        const relLeft = (ev.clientX - rect.left) / rect.width
        const relTop = (ev.clientY - rect.top) / rect.height
        const { x, y } = toCanonical(relLeft, relTop, isDesktop)
        if (handle === 'start') current = { ...current, x1: x, y1: y }
        else if (handle === 'end') current = { ...current, x2: x, y2: y }
        else current = { ...current, ...bendControlPoint(current.x1, current.y1, current.x2, current.y2, x, y) }
        setLiveArrowEdit(current)
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        teardown()
        setLiveArrowEdit(null)
        // Manually dragging an anchored tail detaches it: it stops tracking
        // its player/opponent and freezes at the coordinate it was dropped at.
        const detach = handle === 'start' && (arrow.start_player_id != null || arrow.start_opponent_id != null)
        onUpdateArrow(detach ? { ...current, start_player_id: null, start_opponent_id: null } : current)
      }
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        teardown()
        setLiveArrowEdit(null)
      }
      const teardown = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        arrowDragTeardownRef.current = () => {}
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      arrowDragTeardownRef.current = teardown
    }

  // ── End zones ────────────────────────────────────────────────────────────
  // "Ours" is fixed at canonical x=0 (left in landscape, top in portrait),
  // colored to match the Us(green)/Them(red) convention used on Schedule and
  // Quick Score.
  const endZonePct = `${END_ZONE_FRACTION * 100}%`
  const oursClass = 'absolute bg-emerald-500/25 dark:bg-emerald-500/15 border-emerald-600/45 dark:border-white/20 flex items-center justify-center pointer-events-none'
  const theirsClass = 'absolute bg-red-500/25 dark:bg-red-500/15 border-red-600/45 dark:border-white/20 flex items-center justify-center pointer-events-none'
  const oursLabel = <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-800/80 dark:text-emerald-200/60 select-none">Our End Zone</span>
  const theirsLabel = <span className="text-[10px] font-semibold uppercase tracking-widest text-red-800/80 dark:text-red-200/60 select-none">Opponent End Zone</span>
  const endZones = isDesktop ? (
    <>
      <div className={`${oursClass} inset-y-0 left-0 border-r-2`} style={{ width: endZonePct }}>{oursLabel}</div>
      <div className={`${theirsClass} inset-y-0 right-0 border-l-2`} style={{ width: endZonePct }}>{theirsLabel}</div>
    </>
  ) : (
    <>
      <div className={`${oursClass} inset-x-0 top-0 border-b-2`} style={{ height: endZonePct }}>{oursLabel}</div>
      <div className={`${theirsClass} inset-x-0 bottom-0 border-t-2`} style={{ height: endZonePct }}>{theirsLabel}</div>
    </>
  )

  // ── Arrow rendering ──────────────────────────────────────────────────────
  // A non-square viewBox in real field-metre units (100x37 landscape, 37x100
  // portrait) so stroke widths and the arrowhead/disc icons scale uniformly
  // with no distortion, reusing the same toRendered percentages (just scaled
  // from 0-100 down to the viewBox's real units) instead of a second mapping.
  const viewBoxW = isDesktop ? 100 : 37
  const viewBoxH = isDesktop ? 37 : 100
  const toViewBox = (x: number, y: number) => {
    const { left, top } = toRendered(x, y, isDesktop)
    return { vx: (left / 100) * viewBoxW, vy: (top / 100) * viewBoxH }
  }
  const ARROW_COLOR = '#f59e0b' // amber-500: reads on the emerald field in both themes

  // An anchored arrow's stored x1/y1 is just its position when last saved;
  // render it tracking the anchor's current position instead so dragging the
  // player or opponent within this step visibly drags the arrow's tail
  // along with them.
  const getEffectiveArrow = (a: StrategyArrow) => {
    if (a.start_player_id != null) {
      const pos = positions.get(a.start_player_id)
      if (pos) return { ...a, x1: pos.x, y1: pos.y }
    } else if (a.start_opponent_id != null) {
      const opp = opponents.find(o => o.id === a.start_opponent_id)
      if (opp) return { ...a, x1: opp.x, y1: opp.y }
    }
    return a
  }
  const renderedArrows = arrows.map(a => {
    const eff = getEffectiveArrow(a)
    return liveArrowEdit?.id === a.id ? { ...eff, ...liveArrowEdit } : eff
  })
  // Which arrow shows its edit handles: the hovered one (desktop) or the
  // tap-selected one (touch, which has no hover). A handle drag in progress
  // (liveArrowEdit) pins its arrow so the handles don't vanish mid-drag if the
  // pointer strays off the line.
  const handleArrowId = liveArrowEdit?.id
    ?? hoveredArrowId
    ?? (selectedArrowId !== null && selectedArrowId === touchArrowId ? selectedArrowId : null)
  const handleArrow = renderedArrows.find(a => a.id === handleArrowId) ?? null

  return (
    <div className="space-y-3">
      {allowed && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === 'draw' ? 'default' : 'outline'}
              onClick={() => setMode(m => (m === 'draw' ? 'move' : 'draw'))}
              title="Draw arrows for cuts and movement. Toggle on and drag on the field, or hold A and drag."
            >
              <Pencil className="w-3.5 h-3.5 mr-1.5" />Draw arrow
            </Button>
            {mode === 'draw' && (
              <div className="flex rounded-md border border-border overflow-hidden text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setArrowType('run')}
                  className={`px-2.5 py-1.5 ${arrowType === 'run' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}
                >
                  Run
                </button>
                <button
                  type="button"
                  onClick={() => setArrowType('throw')}
                  className={`px-2.5 py-1.5 ${arrowType === 'throw' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}
                >
                  Throw
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onAddOpponent}>
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />Add Opponent
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onAddTextBox}>
              <Type className="w-3.5 h-3.5 mr-1.5" />Add Text
            </Button>
          </div>
        </div>
      )}

      <div
        ref={fieldRef}
        onPointerDown={handleFieldPointerDown}
        className={`relative overflow-hidden rounded-xl border border-border bg-emerald-500/15 dark:bg-emerald-500/10 touch-none ${
          isDesktop ? 'w-full aspect-[100/37]' : 'mx-auto w-full max-w-xl h-[88vh]'
        } ${drawArmed ? 'cursor-crosshair' : ''}`}
      >
        {endZones}

        {/* Arrows: SVG overlay beneath the player/opponent avatars. */}
        <svg
          viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none' }}
        >
          <defs>
            <marker id="strategy-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={ARROW_COLOR} />
            </marker>
          </defs>
          {renderedArrows.map(a => {
            const p0 = toViewBox(a.x1, a.y1)
            const c = toViewBox(a.cx, a.cy)
            const p2 = toViewBox(a.x2, a.y2)
            const d = `M ${p0.vx} ${p0.vy} Q ${c.vx} ${c.vy} ${p2.vx} ${p2.vy}`
            const midCanonical = onCurveMidpoint(a)
            const mid = toViewBox(midCanonical.x, midCanonical.y)
            return (
              <g key={a.id}>
                {/* wide, invisible hit path so thin arrows stay easy to tap */}
                <path d={d} stroke="transparent" strokeWidth={3} fill="none" style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    const item = { kind: 'arrow' as const, id: a.id }
                    if (e.metaKey || e.ctrlKey) { toggleSelected(item); return }
                    setSelected([item])
                    // A touch/pen tap reveals the handles from selection; a mouse relies on hover.
                    setTouchArrowId(e.pointerType === 'mouse' ? null : a.id)
                  }}
                  onPointerEnter={hasHover ? () => keepArrowHover(a.id) : undefined}
                  onPointerLeave={hasHover ? scheduleArrowHoverClear : undefined} />
                <path
                  d={d}
                  stroke={ARROW_COLOR}
                  strokeWidth={0.6}
                  strokeDasharray={a.arrow_type === 'throw' ? '1.6 1.2' : undefined}
                  fill="none"
                  markerEnd="url(#strategy-arrowhead)"
                  opacity={isSel('arrow', a.id) || hoveredArrowId === a.id ? 1 : 0.9}
                />
                {a.arrow_type === 'throw' && (
                  <foreignObject x={mid.vx - 1.5} y={mid.vy - 1.5} width={3} height={3} style={{ pointerEvents: 'none' }}>
                    <Disc className="w-full h-full" style={{ color: ARROW_COLOR }} />
                  </foreignObject>
                )}
              </g>
            )
          })}
          {drawingArrow && (() => {
            const p0 = toViewBox(drawingArrow.x1, drawingArrow.y1)
            const p2 = toViewBox(drawingArrow.x2, drawingArrow.y2)
            return <path d={`M ${p0.vx} ${p0.vy} L ${p2.vx} ${p2.vy}`} stroke={ARROW_COLOR} strokeWidth={0.6} strokeDasharray="1.6 1.2" fill="none" opacity={0.7} />
          })()}
        </svg>

        {/* Selected arrow's handles + delete button (HTML, positioned by percentage). */}
        {handleArrow && (() => {
          const start = toRendered(handleArrow.x1, handleArrow.y1, isDesktop)
          const end = toRendered(handleArrow.x2, handleArrow.y2, isDesktop)
          const mid = onCurveMidpoint(handleArrow)
          const midRendered = toRendered(mid.x, mid.y, isDesktop)
          const handleClass = 'absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background border-2 touch-none cursor-grab'
          const startAnchored = handleArrow.start_player_id != null || handleArrow.start_opponent_id != null
          // Keep the handles alive while the pointer is on them, so crossing
          // from the arrow line onto a handle doesn't dismiss the set.
          const hoverProps = hasHover
            ? { onPointerEnter: () => keepArrowHover(handleArrow.id), onPointerLeave: scheduleArrowHoverClear }
            : {}
          return (
            <>
              <div
                {...hoverProps}
                className={`${handleClass} ${startAnchored ? 'border-sky-400' : 'border-amber-500'}`}
                title={startAnchored ? 'Anchored — drag to detach' : undefined}
                style={{ left: `${start.left}%`, top: `${start.top}%` }}
                onPointerDown={beginHandleDrag(handleArrow, 'start')}
              />
              <div {...hoverProps} className={`${handleClass} border-amber-500`} style={{ left: `${end.left}%`, top: `${end.top}%` }} onPointerDown={beginHandleDrag(handleArrow, 'end')} />
              <div {...hoverProps} className={`${handleClass} border-amber-300`} style={{ left: `${midRendered.left}%`, top: `${midRendered.top}%` }} onPointerDown={beginHandleDrag(handleArrow, 'bend')} />
              <button
                {...hoverProps}
                type="button"
                className="absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow"
                style={{ left: `${midRendered.left}%`, top: `calc(${midRendered.top}% + 18px)` }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => { onDeleteArrow(handleArrow.id); setSelected([]) }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )
        })()}

        {placed.map(player => {
          const pos = positions.get(player.id)!
          const isDragSource = !!(drag?.moved && drag.entity.kind === 'player' && drag.entity.id === player.id)
          // The most recently grabbed circle renders on top, so overlapping
          // circles can be peeled apart: whatever you touch comes forward and
          // stays there, letting you re-grab it instead of the one beneath.
          const onTop = lastActiveKey === `player-${player.id}`
          const isSelected = isSel('player', player.id)
          return (
            <PlayerMarker
              key={player.id}
              player={player}
              target={pos}
              transitionMs={transitionMs}
              isDesktop={isDesktop}
              isDragSource={isDragSource}
              isSelected={isSelected}
              onTop={onTop}
              drawArmed={drawArmed}
              allowed={allowed}
              onPointerDown={handlePointerDown({ kind: 'player', id: player.id }, 'field')}
            />
          )
        })}

        {opponents.map((opp, oppIndex) => {
          const { left, top } = toRendered(opp.x, opp.y, isDesktop)
          const isDragSource = drag?.moved && drag.entity.kind === 'opponent' && drag.entity.id === opp.id
          const onTop = lastActiveKey === `opponent-${opp.id}`
          const isSelected = isSel('opponent', opp.id)
          const isEditingLabel = editingOpponentId === opp.id
          return (
            <div
              // Keyed by label, not id: each step's opponent markers are
              // separate DB rows seeded fresh per step (see handleAddStep
              // in Strategy.tsx), so opp.id changes across steps even
              // though "Opp 1" is conceptually the same marker. Keying by
              // id made React remount the node on every step change (pop,
              // no slide); the label is the stable identity that lets the
              // position transition below actually animate. Older data can
              // have duplicate labels within one step (a since-fixed
              // numbering bug in handleAddOpponent) — disambiguate those
              // with the array index so React never sees a duplicate key,
              // even though a duplicate pair won't animate correctly
              // between steps until its labels are made unique.
              key={oppKey(opponents, opp, oppIndex)}
              onPointerDown={handlePointerDown({ kind: 'opponent', id: opp.id }, 'field')}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center touch-none animate-in fade-in duration-300 ${
                allowed ? (drawArmed ? 'cursor-crosshair' : 'cursor-grab') : ''
              } ${isDragSource ? 'opacity-40' : 'transition-[left,top] ease-in-out'}`}
              style={{ left: `${left}%`, top: `${top}%`, zIndex: onTop ? 20 : 10, transitionDuration: isDragSource ? undefined : `${transitionMs}ms` }}
            >
              <div className={`w-10 h-10 rounded-full bg-red-100 dark:bg-red-950 border-2 border-red-400 dark:border-red-700 flex items-center justify-center shrink-0 select-none ${isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}>
                <span className="text-[10px] font-bold text-red-700 dark:text-red-400">{opp.label.replace(/^Opp\s*/i, '')}</span>
              </div>
              {isEditingLabel ? (
                <input
                  autoFocus
                  value={editingLabelValue}
                  onChange={e => setEditingLabelValue(e.target.value)}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => e.stopPropagation()}
                  onBlur={commitOpponentLabel}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                    else if (e.key === 'Escape') { e.preventDefault(); setEditingOpponentId(null) }
                  }}
                  className="mt-0.5 w-16 text-[9px] text-center rounded px-1 bg-background border border-primary text-foreground"
                />
              ) : (
                <span className="text-[9px] font-medium text-foreground bg-background/70 rounded px-1 mt-0.5 max-w-16 truncate">
                  {opp.label}
                </span>
              )}
              {allowed && selectedOpponentId === opp.id && !isEditingLabel && (
                <button
                  type="button"
                  aria-label="Rename opponent"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => {
                    e.stopPropagation()
                    setEditingLabelValue(opp.label)
                    setEditingOpponentId(opp.id)
                  }}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-background border border-border flex items-center justify-center text-muted-foreground hover:text-foreground shadow"
                >
                  <Pencil className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          )
        })}

        {/* Text boxes: free-floating annotations, no roster backing and no
            arrow-anchoring (see the drawArmed branch in handlePointerDown).
            Keyed by id, not content: unlike opponents, text is expected to
            change freely, so there's no stable content-based identity to key
            on — a text box just fades in fresh on a new step rather than
            sliding, which is an acceptable simplification for a decoration
            layer. */}
        {textBoxes.map(box => {
          const { left, top } = toRendered(box.x, box.y, isDesktop)
          const isDragSource = drag?.moved && drag.entity.kind === 'textbox' && drag.entity.id === box.id
          const onTop = lastActiveKey === `textbox-${box.id}`
          const isSelected = isSel('textbox', box.id)
          const isEditing = editingTextBoxId === box.id
          return (
            <div
              key={box.id}
              onPointerDown={handlePointerDown({ kind: 'textbox', id: box.id }, 'field')}
              className={`absolute -translate-x-1/2 -translate-y-1/2 touch-none animate-in fade-in duration-300 ${
                allowed ? (drawArmed ? '' : 'cursor-grab') : ''
              } ${isDragSource ? 'opacity-40' : 'transition-[left,top] ease-in-out'}`}
              style={{ left: `${left}%`, top: `${top}%`, zIndex: onTop ? 20 : 10, transitionDuration: isDragSource ? undefined : `${transitionMs}ms` }}
            >
              <div className={`relative min-w-[70px] max-w-[160px] px-2 py-1 rounded-md bg-yellow-100 dark:bg-yellow-950 border-2 border-yellow-400 dark:border-yellow-700 shadow-sm ${isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}`}>
                {isEditing ? (
                  <textarea
                    autoFocus
                    value={editingTextValue}
                    onChange={e => setEditingTextValue(e.target.value)}
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => e.stopPropagation()}
                    onBlur={commitTextBoxText}
                    onKeyDown={e => {
                      if (e.key === 'Escape') { e.preventDefault(); setEditingTextBoxId(null) }
                    }}
                    rows={2}
                    className="w-full text-[11px] bg-background border border-primary rounded px-1 text-foreground resize-none"
                  />
                ) : (
                  <span className="block text-[11px] text-foreground whitespace-pre-wrap break-words select-none">
                    {box.text || <span className="italic text-muted-foreground">Text</span>}
                  </span>
                )}
                {allowed && isSelected && !isEditing && (
                  <button
                    type="button"
                    aria-label="Edit text"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={e => {
                      e.stopPropagation()
                      setEditingTextValue(box.text)
                      setEditingTextBoxId(box.id)
                    }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-background border border-border flex items-center justify-center text-muted-foreground hover:text-foreground shadow"
                  >
                    <Pencil className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Bench tray: everyone not placed in the current play. */}
      <div className="flex flex-wrap gap-2 p-3 rounded-xl border border-border bg-card min-h-[4.5rem] items-start">
        {bench.length === 0 && (
          <span className="text-sm text-muted-foreground self-center">Everyone is on the field</span>
        )}
        {bench.map(player => {
          const isDragSource = drag?.moved && drag.entity.kind === 'player' && drag.entity.id === player.id
          return (
            <div
              key={player.id}
              onPointerDown={handlePointerDown({ kind: 'player', id: player.id }, 'bench')}
              className={`flex flex-col items-center w-14 touch-none ${allowed ? 'cursor-grab' : ''} ${
                isDragSource ? 'opacity-40' : ''
              }`}
            >
              <PlayerAvatar photoUrl={player.photo_url} name={player.display_name} size="sm" />
              <span className="text-[9px] text-muted-foreground mt-0.5 max-w-full truncate">
                {shortName(player.display_name)}
              </span>
            </div>
          )
        })}
      </div>

      {/* Drag ghost: follows the pointer while dragging, TFT-style. Rendered
          through a portal to document.body because position:fixed is resolved
          against the nearest transformed ancestor, and the page's FadeIn
          wrapper keeps an identity transform applied (fill-mode-both), which
          would offset the ghost from the pointer by the wrapper's position. */}
      {drag?.moved && drag.entity.kind === 'player' && dragPlayer && createPortal(
        <div
          ref={ghostRef}
          className="fixed z-50 -translate-x-1/2 -translate-y-1/2 pointer-events-none scale-110 drop-shadow-lg"
          style={{ left: pointerPosRef.current.x, top: pointerPosRef.current.y }}
        >
          <PlayerAvatar photoUrl={dragPlayer.photo_url} name={dragPlayer.display_name} size="sm" />
        </div>,
        document.body
      )}
      {drag?.moved && drag.entity.kind === 'opponent' && createPortal(
        <div
          ref={ghostRef}
          className="fixed z-50 -translate-x-1/2 -translate-y-1/2 pointer-events-none scale-110 drop-shadow-lg"
          style={{ left: pointerPosRef.current.x, top: pointerPosRef.current.y }}
        >
          <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950 border-2 border-red-400 dark:border-red-700" />
        </div>,
        document.body
      )}
      {drag?.moved && drag.entity.kind === 'textbox' && createPortal(
        <div
          ref={ghostRef}
          className="fixed z-50 -translate-x-1/2 -translate-y-1/2 pointer-events-none scale-105 drop-shadow-lg"
          style={{ left: pointerPosRef.current.x, top: pointerPosRef.current.y }}
        >
          <div className="min-w-[70px] max-w-[160px] px-2 py-1 rounded-md bg-yellow-100 dark:bg-yellow-950 border-2 border-yellow-400 dark:border-yellow-700 text-[11px] text-foreground">
            {textBoxes.find(t => t.id === drag.entity.id)?.text || 'Text'}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
