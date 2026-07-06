import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PlayerAvatar from '../PlayerAvatar'
import { Button } from '../../lib/shadcn/button'
import { useMediaQuery } from '../../lib/shadcn/use-media-query'
import { Pencil, UserPlus, Trash2, Disc } from 'lucide-react'
import type { StrategyArrow, StrategyOpponentMarker } from '../../hooks/backend/strategy'

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
type Entity = { kind: 'player'; id: number } | { kind: 'opponent'; id: number }

type DragState = {
  entity: Entity
  pointerId: number
  origin: 'bench' | 'field'
  startX: number
  startY: number
  clientX: number
  clientY: number
  moved: boolean
}

type ArrowDraft = { x1: number; y1: number; x2: number; y2: number; pointerId: number; startPlayerId?: number }
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
  players, positions, opponents, arrows, allowed,
  onPlace, onRemove, onAddOpponent, onMoveOpponent, onRemoveOpponent,
  onCreateArrow, onUpdateArrow, onDeleteArrow,
}: {
  players: BoardPlayer[]
  positions: Map<number, { x: number; y: number }>
  opponents: StrategyOpponentMarker[]
  arrows: StrategyArrow[]
  allowed: boolean
  onPlace: (playerId: number, x: number, y: number) => void
  onRemove: (playerId: number) => void
  onAddOpponent: () => void
  onMoveOpponent: (id: number, x: number, y: number) => void
  onRemoveOpponent: (id: number) => void
  onCreateArrow: (arrow: { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; arrow_type: 'run' | 'throw'; start_player_id: number | null }) => void
  onUpdateArrow: (arrow: { id: number; x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; start_player_id?: number | null }) => void
  onDeleteArrow: (id: number) => void
}) {
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const fieldRef = useRef<HTMLDivElement>(null)
  // The ref is the authoritative drag state, updated synchronously inside the
  // event handlers; the state is only a render mirror for the ghost and the
  // source dimming. React commits pointermove updates at continuous (deferred)
  // priority, so a flick whose pointermove and pointerup land in the same
  // frame would read a stale moved=false from state and skip the drop.
  const dragRef = useRef<DragState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
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
  const [selectedArrowId, setSelectedArrowId] = useState<number | null>(null)
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
      if (e.key === 'Escape') { setSelectedArrowId(null); return }
      if (e.repeat || e.key.toLowerCase() !== 'a' || isTypingTarget(e.target)) return
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
      if (drawArmed) {
        const start = entity.kind === 'player' ? positions.get(entity.id) : opponents.find(o => o.id === entity.id)
        if (start) beginArrowDraw(e.pointerId, start.x, start.y, entity.kind === 'player' ? entity.id : undefined)
        return
      }
      teardownRef.current() // defensively end any drag still in flight
      if (origin === 'field') setLastActiveKey(`${entity.kind}-${entity.id}`)
      updateDrag({ entity, pointerId: e.pointerId, origin, startX: e.clientX, startY: e.clientY, clientX: e.clientX, clientY: e.clientY, moved: false })

      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d || ev.pointerId !== d.pointerId) return
        const moved = d.moved
          || Math.abs(ev.clientX - d.startX) > DRAG_THRESHOLD_PX
          || Math.abs(ev.clientY - d.startY) > DRAG_THRESHOLD_PX
        if (!moved) return
        updateDrag({ ...d, clientX: ev.clientX, clientY: ev.clientY, moved: true })
      }
      const onUp = (ev: PointerEvent) => {
        const d = dragRef.current
        if (!d || ev.pointerId !== d.pointerId) return
        teardown()
        updateDrag(null)
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
          else onMoveOpponent(d.entity.id, x, y)
        } else if (d.entity.kind === 'player' && d.origin === 'field') {
          // Any off-field drop returns a player to the bench.
          onRemove(d.entity.id)
        } else if (d.entity.kind === 'opponent') {
          // Opponents have no bench; any off-field drop deletes the marker.
          onRemoveOpponent(d.entity.id)
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

  // ── Arrow drawing ──────────────────────────────────────────────────────────
  // startPlayerId is set only when the drag began on a player avatar (not
  // empty field or an opponent marker): the arrow's tail is then anchored to
  // that player — tracking them live if dragged within the step, and (for
  // 'run' arrows) its head drives their position in the next step.
  const beginArrowDraw = (pointerId: number, x1: number, y1: number, startPlayerId?: number) => {
    arrowDragTeardownRef.current() // defensively end any handle-drag still in flight
    const initial: ArrowDraft = { x1, y1, x2: x1, y2: y1, pointerId, startPlayerId }
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
        arrow_type: arrowType, start_player_id: d.startPlayerId ?? null,
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
      if (selectedArrowId !== null) setSelectedArrowId(null)
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
        // the player and freezes at the coordinate it was dropped at.
        const detach = handle === 'start' && arrow.start_player_id != null
        onUpdateArrow(detach ? { ...current, start_player_id: null } : current)
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
  // render it tracking the player's current position instead so dragging the
  // player within this step visibly drags the arrow's tail along with them.
  const getEffectiveArrow = (a: StrategyArrow) => {
    if (a.start_player_id == null) return a
    const pos = positions.get(a.start_player_id)
    return pos ? { ...a, x1: pos.x, y1: pos.y } : a
  }
  const renderedArrows = arrows.map(a => {
    const eff = getEffectiveArrow(a)
    return liveArrowEdit?.id === a.id ? { ...eff, ...liveArrowEdit } : eff
  })
  const selectedArrow = renderedArrows.find(a => a.id === selectedArrowId) ?? null

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
          <Button type="button" size="sm" variant="outline" onClick={onAddOpponent}>
            <UserPlus className="w-3.5 h-3.5 mr-1.5" />Add Opponent
          </Button>
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
                  onPointerDown={(e) => { e.stopPropagation(); setSelectedArrowId(a.id) }} />
                <path
                  d={d}
                  stroke={ARROW_COLOR}
                  strokeWidth={0.6}
                  strokeDasharray={a.arrow_type === 'throw' ? '1.6 1.2' : undefined}
                  fill="none"
                  markerEnd="url(#strategy-arrowhead)"
                  opacity={selectedArrowId === a.id ? 1 : 0.9}
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
        {selectedArrow && (() => {
          const start = toRendered(selectedArrow.x1, selectedArrow.y1, isDesktop)
          const end = toRendered(selectedArrow.x2, selectedArrow.y2, isDesktop)
          const mid = onCurveMidpoint(selectedArrow)
          const midRendered = toRendered(mid.x, mid.y, isDesktop)
          const handleClass = 'absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background border-2 touch-none cursor-grab'
          const startAnchored = selectedArrow.start_player_id != null
          return (
            <>
              <div
                className={`${handleClass} ${startAnchored ? 'border-sky-400' : 'border-amber-500'}`}
                title={startAnchored ? 'Anchored to a player — drag to detach' : undefined}
                style={{ left: `${start.left}%`, top: `${start.top}%` }}
                onPointerDown={beginHandleDrag(selectedArrow, 'start')}
              />
              <div className={`${handleClass} border-amber-500`} style={{ left: `${end.left}%`, top: `${end.top}%` }} onPointerDown={beginHandleDrag(selectedArrow, 'end')} />
              <div className={`${handleClass} border-amber-300`} style={{ left: `${midRendered.left}%`, top: `${midRendered.top}%` }} onPointerDown={beginHandleDrag(selectedArrow, 'bend')} />
              <button
                type="button"
                className="absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow"
                style={{ left: `${midRendered.left}%`, top: `calc(${midRendered.top}% + 18px)` }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => { onDeleteArrow(selectedArrow.id); setSelectedArrowId(null) }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )
        })()}

        {placed.map(player => {
          const pos = positions.get(player.id)!
          const { left, top } = toRendered(pos.x, pos.y, isDesktop)
          const isDragSource = drag?.moved && drag.entity.kind === 'player' && drag.entity.id === player.id
          // The most recently grabbed circle renders on top, so overlapping
          // circles can be peeled apart: whatever you touch comes forward and
          // stays there, letting you re-grab it instead of the one beneath.
          const onTop = lastActiveKey === `player-${player.id}`
          return (
            <div
              key={player.id}
              onPointerDown={handlePointerDown({ kind: 'player', id: player.id }, 'field')}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center touch-none animate-in fade-in duration-300 ${
                allowed ? (drawArmed ? 'cursor-crosshair' : 'cursor-grab') : ''
              } ${isDragSource ? 'opacity-40' : 'transition-[left,top] duration-300 ease-out'}`}
              style={{ left: `${left}%`, top: `${top}%`, zIndex: onTop ? 20 : 10 }}
            >
              <PlayerAvatar photoUrl={player.photo_url} name={player.display_name} size="sm" />
              <span className="text-[9px] font-medium text-foreground bg-background/70 rounded px-1 mt-0.5 max-w-16 truncate">
                {shortName(player.display_name)}
              </span>
            </div>
          )
        })}

        {opponents.map(opp => {
          const { left, top } = toRendered(opp.x, opp.y, isDesktop)
          const isDragSource = drag?.moved && drag.entity.kind === 'opponent' && drag.entity.id === opp.id
          const onTop = lastActiveKey === `opponent-${opp.id}`
          return (
            <div
              key={opp.id}
              onPointerDown={handlePointerDown({ kind: 'opponent', id: opp.id }, 'field')}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center touch-none animate-in fade-in duration-300 ${
                allowed ? (drawArmed ? 'cursor-crosshair' : 'cursor-grab') : ''
              } ${isDragSource ? 'opacity-40' : 'transition-[left,top] duration-300 ease-out'}`}
              style={{ left: `${left}%`, top: `${top}%`, zIndex: onTop ? 20 : 10 }}
            >
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950 border-2 border-red-400 dark:border-red-700 flex items-center justify-center shrink-0 select-none">
                <span className="text-[10px] font-bold text-red-700 dark:text-red-400">{opp.label.replace(/^Opp\s*/i, '')}</span>
              </div>
              <span className="text-[9px] font-medium text-foreground bg-background/70 rounded px-1 mt-0.5 max-w-16 truncate">
                {opp.label}
              </span>
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
          className="fixed z-50 -translate-x-1/2 -translate-y-1/2 pointer-events-none scale-110 drop-shadow-lg"
          style={{ left: drag.clientX, top: drag.clientY }}
        >
          <PlayerAvatar photoUrl={dragPlayer.photo_url} name={dragPlayer.display_name} size="sm" />
        </div>,
        document.body
      )}
      {drag?.moved && drag.entity.kind === 'opponent' && createPortal(
        <div
          className="fixed z-50 -translate-x-1/2 -translate-y-1/2 pointer-events-none scale-110 drop-shadow-lg"
          style={{ left: drag.clientX, top: drag.clientY }}
        >
          <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-950 border-2 border-red-400 dark:border-red-700" />
        </div>,
        document.body
      )}
    </div>
  )
}
