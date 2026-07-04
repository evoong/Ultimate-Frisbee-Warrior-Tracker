import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PlayerAvatar from '../PlayerAvatar'
import { useMediaQuery } from '../../lib/shadcn/use-media-query'
import { Button } from '../../lib/shadcn/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../lib/shadcn/tooltip'
import { ArrowUpRight, MousePointer2, X } from 'lucide-react'
import type { ArrowGeom, StrategyArrow } from '../../hooks/backend/strategy'

// Canonical coordinates are fractions in [0, 1] of a LANDSCAPE field:
// x along the 100m length (0 = left back line), y across the 37m width
// (0 = top sideline). On mobile the field renders in portrait (rotated
// 90 degrees clockwise, so the canonical left end zone is at the top)
// and the mappings below convert between the two frames. Arrows share
// this frame with player positions.

type BoardPlayer = { id: number; display_name: string; photo_url: string | null }

type DragState = {
  playerId: number
  pointerId: number
  origin: 'bench' | 'field'
  startX: number
  startY: number
  clientX: number
  clientY: number
  moved: boolean
}

// In-progress arrow being drawn on empty field space.
type DrawState = { startX: number; startY: number; x1: number; y1: number; x2: number; y2: number; moved: boolean }

// In-progress edit of a selected arrow's start/end/midpoint handle.
type HandleKind = 'start' | 'end' | 'mid'
type HandleDrag = { arrowId: number; kind: HandleKind; geom: ArrowGeom }

const DRAG_THRESHOLD_PX = 4
const END_ZONE_FRACTION = 0.18
// One bold colour for all arrows. amber-500 reads on the emerald field
// in both light and dark themes.
const ARROW_COLOR = '#f59e0b'

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

// viewBox dimensions match the field aspect so 1 unit = 1 metre and
// strokes/arrowheads scale uniformly with no distortion.
function vbDims(landscape: boolean) {
  return landscape ? { w: 100, h: 37 } : { w: 37, h: 100 }
}

// Canonical -> SVG viewBox coordinates.
function toViewBox(x: number, y: number, landscape: boolean) {
  const { left, top } = toRendered(x, y, landscape)
  const { w, h } = vbDims(landscape)
  return { vx: (left / 100) * w, vy: (top / 100) * h }
}

// The on-curve midpoint of a quadratic Bezier (t = 0.5). This is where
// the draggable "bend" handle sits.
function curveMidpoint(a: ArrowGeom) {
  return {
    x: 0.25 * a.x1 + 0.5 * a.cx + 0.25 * a.x2,
    y: 0.25 * a.y1 + 0.5 * a.cy + 0.25 * a.y2,
  }
}

// Solve the control point so the curve's midpoint passes through the
// handle H: midpoint = 0.25 P0 + 0.5 C + 0.25 P2  =>  C = 2H - 0.5(P0+P2).
// Clamp to [0,1] to satisfy the DB coordinate checks.
function controlFromHandle(x1: number, y1: number, x2: number, y2: number, hx: number, hy: number) {
  return { cx: clamp01(2 * hx - 0.5 * (x1 + x2)), cy: clamp01(2 * hy - 0.5 * (y1 + y2)) }
}

export default function StrategyBoard({
  players, positions, arrows, allowed,
  selectedArrowId, onSelectArrow,
  onPlace, onRemove, onCreateArrow, onUpdateArrow, onDeleteArrow,
}: {
  players: BoardPlayer[]
  positions: Map<number, { x: number; y: number }>
  arrows: StrategyArrow[]
  allowed: boolean
  selectedArrowId: number | null
  onSelectArrow: (id: number | null) => void
  onPlace: (playerId: number, x: number, y: number) => void
  onRemove: (playerId: number) => void
  onCreateArrow: (geom: ArrowGeom) => void
  onUpdateArrow: (id: number, geom: ArrowGeom) => void
  onDeleteArrow: (id: number) => void
}) {
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const fieldRef = useRef<HTMLDivElement>(null)

  // Player drag. The ref is authoritative (synchronous); state mirrors it
  // for rendering the ghost and dimming the source. See the original
  // component comment: a flick whose move+up land in one frame must not
  // read a stale moved=false from state.
  const dragRef = useRef<DragState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const updateDrag = (d: DragState | null) => { dragRef.current = d; setDrag(d) }
  // The last placed circle the user grabbed; it renders above the others so
  // overlapping circles stay individually reachable.
  const [lastActiveId, setLastActiveId] = useState<number | null>(null)
  // Removes whatever window listeners the current drag installed. Stored in a
  // ref so both the drag's own pointerup and the unmount cleanup can call it.
  const teardownRef = useRef<() => void>(() => {})
  useEffect(() => () => teardownRef.current(), [])

  // Arrow drawing / editing state, same ref+mirror discipline.
  const [drawMode, setDrawMode] = useState(false)
  const [aKeyHeld, setAKeyHeld] = useState(false)
  const drawRef = useRef<DrawState | null>(null)
  const [draw, setDraw] = useState<DrawState | null>(null)
  const updateDraw = (d: DrawState | null) => { drawRef.current = d; setDraw(d) }
  const handleRef = useRef<HandleDrag | null>(null)
  const [handleDrag, setHandleDrag] = useState<HandleDrag | null>(null)
  const updateHandle = (h: HandleDrag | null) => { handleRef.current = h; setHandleDrag(h) }

  const armed = allowed && (drawMode || aKeyHeld)
  const playerInteractive = allowed && !drawMode

  // Hold-A arms drawing on desktop; Escape deselects. Ignore auto-repeat
  // and any typing context so a play name never arms drawing.
  useEffect(() => {
    if (!allowed) return
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      if (!el || !el.tagName) return false
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    }
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onSelectArrow(null); return }
      if ((e.key === 'a' || e.key === 'A') && !e.repeat && !isTyping(e.target)) setAKeyHeld(true)
    }
    const up = (e: KeyboardEvent) => { if (e.key === 'a' || e.key === 'A') setAKeyHeld(false) }
    // If the window loses focus while A is held (e.g. alt-tab), the keyup
    // never arrives; reset on blur so the board does not stay armed.
    const blur = () => setAKeyHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [allowed, onSelectArrow])

  const pointerToCanonical = (clientX: number, clientY: number) => {
    const rect = fieldRef.current!.getBoundingClientRect()
    const relLeft = (clientX - rect.left) / rect.width
    const relTop = (clientY - rect.top) / rect.height
    return toCanonical(relLeft, relTop, isDesktop)
  }

  const placed = players.filter(p => positions.has(p.id))
  const bench = players.filter(p => !positions.has(p.id))
  const dragPlayer = drag ? players.find(p => p.id === drag.playerId) : undefined

  // ---- Player drag handlers ----
  // The move/up/cancel handlers live on window for the duration of a drag, not
  // on the dragged avatar. Relying on the avatar's own pointerup (via pointer
  // capture) meant a release over an overlapping circle or empty field, or a
  // browser-issued pointercancel, could land on an element with no handler and
  // silently skip the drop. Window listeners catch the release wherever it
  // happens; capture is no longer needed.
  const handlePointerDown = (playerId: number, origin: 'bench' | 'field') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!playerInteractive) return
      // Grabbing a player must not also start a draw or deselect via the
      // field handler, so stop propagation and clear selection here.
      e.stopPropagation()
      onSelectArrow(null)
      teardownRef.current() // defensively end any drag still in flight
      if (origin === 'field') setLastActiveId(playerId)
      updateDrag({ playerId, pointerId: e.pointerId, origin, startX: e.clientX, startY: e.clientY, clientX: e.clientX, clientY: e.clientY, moved: false })

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
          const { x, y } = pointerToCanonical(ev.clientX, ev.clientY)
          onPlace(d.playerId, x, y)
        } else if (d.origin === 'field') {
          // Any off-field drop returns the player to the bench.
          onRemove(d.playerId)
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

  // ---- Field-level handlers: draw a new arrow, or deselect on empty tap ----
  const handleFieldPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!allowed) return
    if (!armed) { onSelectArrow(null); return }
    onSelectArrow(null)
    const { x, y } = pointerToCanonical(e.clientX, e.clientY)
    e.currentTarget.setPointerCapture(e.pointerId)
    updateDraw({ startX: e.clientX, startY: e.clientY, x1: x, y1: y, x2: x, y2: y, moved: false })
  }

  const handleFieldPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drawRef.current
    if (!d) return
    const moved = d.moved
      || Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD_PX
      || Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD_PX
    const { x, y } = pointerToCanonical(e.clientX, e.clientY)
    updateDraw({ ...d, x2: x, y2: y, moved })
  }

  const handleFieldPointerUp = () => {
    const d = drawRef.current
    updateDraw(null)
    if (!d || !d.moved) return
    onCreateArrow({ x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, cx: (d.x1 + d.x2) / 2, cy: (d.y1 + d.y2) / 2 })
  }

  const handleFieldPointerCancel = () => updateDraw(null)

  // ---- Selected-arrow handle drag ----
  const startHandleDrag = (a: StrategyArrow, kind: HandleKind) =>
    (e: React.PointerEvent<SVGCircleElement>) => {
      if (!allowed) return
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      updateHandle({ arrowId: a.id, kind, geom: { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, cx: a.cx, cy: a.cy } })
    }

  const moveHandleDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    const h = handleRef.current
    if (!h) return
    const { x, y } = pointerToCanonical(e.clientX, e.clientY)
    let geom = h.geom
    if (h.kind === 'start') geom = { ...geom, x1: x, y1: y }
    else if (h.kind === 'end') geom = { ...geom, x2: x, y2: y }
    else {
      const { cx, cy } = controlFromHandle(geom.x1, geom.y1, geom.x2, geom.y2, x, y)
      geom = { ...geom, cx, cy }
    }
    updateHandle({ ...h, geom })
  }

  const endHandleDrag = () => {
    const h = handleRef.current
    updateHandle(null)
    if (!h) return
    onUpdateArrow(h.arrowId, h.geom)
  }

  // A cancelled handle gesture (e.g. browser-issued pointercancel) discards
  // the in-progress geometry instead of persisting it.
  const cancelHandleDrag = () => updateHandle(null)

  const selectArrow = (id: number) => (e: React.PointerEvent<SVGPathElement>) => {
    if (!allowed || drawMode || aKeyHeld) return
    e.stopPropagation()
    onSelectArrow(id)
  }

  // Arrow geometry to render: the live handle-drag draft overrides the
  // stored geometry for the arrow being edited.
  const renderGeom = (a: StrategyArrow): ArrowGeom =>
    handleDrag && handleDrag.arrowId === a.id ? handleDrag.geom : a

  const { w: vbW, h: vbH } = vbDims(isDesktop)
  const pathD = (g: ArrowGeom) => {
    const s = toViewBox(g.x1, g.y1, isDesktop)
    const c = toViewBox(g.cx, g.cy, isDesktop)
    const e = toViewBox(g.x2, g.y2, isDesktop)
    return `M ${s.vx} ${s.vy} Q ${c.vx} ${c.vy} ${e.vx} ${e.vy}`
  }

  const previewArrow: ArrowGeom | null = draw && draw.moved
    ? { x1: draw.x1, y1: draw.y1, x2: draw.x2, y2: draw.y2, cx: (draw.x1 + draw.x2) / 2, cy: (draw.y1 + draw.y2) / 2 }
    : null

  const selectedArrow = selectedArrowId !== null ? arrows.find(a => a.id === selectedArrowId) : undefined

  // End zone strips along the long axis: left/right in landscape,
  // top/bottom in portrait (canonical left end zone renders at the top).
  const endZonePct = `${END_ZONE_FRACTION * 100}%`
  const endZoneClass = 'absolute bg-emerald-600/25 dark:bg-emerald-500/15 flex items-center justify-center pointer-events-none'
  const endZoneLabel = (
    <span className="text-[9px] font-semibold uppercase tracking-widest text-emerald-800/50 dark:text-emerald-300/40 select-none">
      End zone
    </span>
  )
  const endZones = isDesktop ? (
    <>
      <div className={`${endZoneClass} inset-y-0 left-0 border-r-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ width: endZonePct }}>{endZoneLabel}</div>
      <div className={`${endZoneClass} inset-y-0 right-0 border-l-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ width: endZonePct }}>{endZoneLabel}</div>
    </>
  ) : (
    <>
      <div className={`${endZoneClass} inset-x-0 top-0 border-b-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ height: endZonePct }}>{endZoneLabel}</div>
      <div className={`${endZoneClass} inset-x-0 bottom-0 border-t-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ height: endZonePct }}>{endZoneLabel}</div>
    </>
  )

  const renderHandle = (a: StrategyArrow, pt: { vx: number; vy: number }, kind: HandleKind) => (
    <g key={kind}>
      <circle
        cx={pt.vx} cy={pt.vy} r={4.5} fill="transparent"
        style={{ pointerEvents: 'all', cursor: 'grab' }}
        onPointerDown={startHandleDrag(a, kind)}
        onPointerMove={moveHandleDrag}
        onPointerUp={endHandleDrag}
        onPointerCancel={cancelHandleDrag}
      />
      <circle
        cx={pt.vx} cy={pt.vy} r={kind === 'mid' ? 1.8 : 2.2}
        fill={kind === 'mid' ? '#ffffff' : ARROW_COLOR}
        stroke={ARROW_COLOR} strokeWidth={0.8}
        style={{ pointerEvents: 'none' }}
      />
    </g>
  )

  return (
    <div className="space-y-3">
      {allowed && (
        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={drawMode ? 'default' : 'outline'}
                  size="sm"
                  className="gap-1.5"
                  onClick={() => { setDrawMode(m => !m); onSelectArrow(null) }}
                >
                  {drawMode ? <ArrowUpRight className="w-4 h-4" /> : <MousePointer2 className="w-4 h-4" />}
                  {drawMode ? 'Drawing arrows' : 'Draw arrow'}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Draw arrows for cuts and movement. Toggle on and drag on the field, or hold A and drag.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {(drawMode || aKeyHeld) && (
            <span className="text-xs text-muted-foreground">Drag on the field to draw a cutting arrow.</span>
          )}
        </div>
      )}

      <div
        ref={fieldRef}
        onPointerDown={handleFieldPointerDown}
        onPointerMove={handleFieldPointerMove}
        onPointerUp={handleFieldPointerUp}
        onPointerCancel={handleFieldPointerCancel}
        className={`relative overflow-hidden rounded-xl border border-border bg-emerald-600/20 dark:bg-emerald-500/10 touch-none ${
          isDesktop ? 'w-full aspect-[100/37]' : 'mx-auto h-[70vh] aspect-[37/100]'
        } ${armed ? 'cursor-crosshair' : ''}`}
      >
        {endZones}

        {/* Arrows overlay. pointer-events none on the svg so only the arrow
            hit paths and handles interact; everything else passes through. */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={`0 0 ${vbW} ${vbH}`}
          preserveAspectRatio="none"
        >
          <defs>
            <marker id="strategy-arrowhead" markerWidth="4" markerHeight="4" refX="3" refY="2" orient="auto">
              <path d="M0,0 L4,2 L0,4 Z" fill={ARROW_COLOR} />
            </marker>
          </defs>

          {arrows.map(a => {
            const g = renderGeom(a)
            const selected = selectedArrowId === a.id
            return (
              <g key={a.id}>
                {!drawMode && allowed && (
                  <path
                    d={pathD(g)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={5}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onPointerDown={selectArrow(a.id)}
                  />
                )}
                <path
                  d={pathD(g)}
                  fill="none"
                  stroke={ARROW_COLOR}
                  strokeWidth={selected ? 1.8 : 1.3}
                  strokeLinecap="round"
                  markerEnd="url(#strategy-arrowhead)"
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            )
          })}

          {previewArrow && (
            <path
              d={pathD(previewArrow)}
              fill="none"
              stroke={ARROW_COLOR}
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeDasharray="2 2"
              opacity={0.85}
              markerEnd="url(#strategy-arrowhead)"
              style={{ pointerEvents: 'none' }}
            />
          )}

          {allowed && !drawMode && selectedArrow && (() => {
            const g = renderGeom(selectedArrow)
            const s = toViewBox(g.x1, g.y1, isDesktop)
            const e = toViewBox(g.x2, g.y2, isDesktop)
            const mid = curveMidpoint(g)
            const m = toViewBox(mid.x, mid.y, isDesktop)
            return (
              <>
                {renderHandle(selectedArrow, s, 'start')}
                {renderHandle(selectedArrow, e, 'end')}
                {renderHandle(selectedArrow, m, 'mid')}
              </>
            )
          })()}
        </svg>

        {/* Delete button for the selected arrow, near its end point. */}
        {allowed && !drawMode && selectedArrow && (() => {
          const g = renderGeom(selectedArrow)
          const { left, top } = toRendered(g.x2, g.y2, isDesktop)
          return (
            <button
              type="button"
              aria-label="Delete arrow"
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onDeleteArrow(selectedArrow.id)}
              className="absolute z-20 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-md"
              style={{ left: `${left}%`, top: `${top}%`, marginTop: '-1.5rem' }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )
        })()}

        {placed.map(player => {
          const pos = positions.get(player.id)!
          const { left, top } = toRendered(pos.x, pos.y, isDesktop)
          const isDragSource = drag?.moved && drag.playerId === player.id
          // The most recently grabbed circle renders on top, so overlapping
          // circles can be peeled apart: whatever you touch comes forward and
          // stays there, letting you re-grab it instead of the one beneath.
          const onTop = lastActiveId === player.id
          return (
            <div
              key={player.id}
              onPointerDown={handlePointerDown(player.id, 'field')}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center touch-none ${
                playerInteractive ? 'cursor-grab' : ''
              } ${isDragSource ? 'opacity-40' : ''}`}
              style={{ left: `${left}%`, top: `${top}%`, zIndex: onTop ? 20 : 10 }}
            >
              <PlayerAvatar photoUrl={player.photo_url} name={player.display_name} size="sm" />
              <span className="text-[9px] font-medium text-foreground bg-background/70 rounded px-1 mt-0.5 max-w-16 truncate">
                {player.display_name}
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
          const isDragSource = drag?.moved && drag.playerId === player.id
          return (
            <div
              key={player.id}
              onPointerDown={handlePointerDown(player.id, 'bench')}
              className={`flex flex-col items-center w-14 touch-none ${playerInteractive ? 'cursor-grab' : ''} ${
                isDragSource ? 'opacity-40' : ''
              }`}
            >
              <PlayerAvatar photoUrl={player.photo_url} name={player.display_name} size="sm" />
              <span className="text-[9px] text-muted-foreground mt-0.5 max-w-full truncate">
                {player.display_name}
              </span>
            </div>
          )
        })}
      </div>

      {/* Drag ghost: follows the pointer while dragging a player. Rendered
          through a portal to document.body because position:fixed resolves
          against the nearest transformed ancestor, and the page's FadeIn
          wrapper keeps an identity transform applied (fill-mode-both). */}
      {drag?.moved && dragPlayer && createPortal(
        <div
          className="fixed z-50 -translate-x-1/2 -translate-y-1/2 pointer-events-none scale-110 drop-shadow-lg"
          style={{ left: drag.clientX, top: drag.clientY }}
        >
          <PlayerAvatar photoUrl={dragPlayer.photo_url} name={dragPlayer.display_name} size="sm" />
        </div>,
        document.body
      )}
    </div>
  )
}
