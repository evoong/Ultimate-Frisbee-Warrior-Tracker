import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import PlayerAvatar from '../PlayerAvatar'
import { useMediaQuery } from '../../lib/shadcn/use-media-query'

// Canonical coordinates are fractions in [0, 1] of a LANDSCAPE field:
// x along the 100m length (0 = left back line), y across the 37m width
// (0 = top sideline). On mobile the field renders in portrait (rotated
// 90 degrees clockwise, so the canonical left end zone is at the top)
// and the mapping below converts between the two frames.

type BoardPlayer = { id: number; display_name: string; photo_url: string | null }

type DragState = {
  playerId: number
  origin: 'bench' | 'field'
  startX: number
  startY: number
  clientX: number
  clientY: number
  moved: boolean
}

const DRAG_THRESHOLD_PX = 4
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

export default function StrategyBoard({ players, positions, allowed, onPlace, onRemove }: {
  players: BoardPlayer[]
  positions: Map<number, { x: number; y: number }>
  allowed: boolean
  onPlace: (playerId: number, x: number, y: number) => void
  onRemove: (playerId: number) => void
}) {
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const fieldRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  const placed = players.filter(p => positions.has(p.id))
  const bench = players.filter(p => !positions.has(p.id))
  const dragPlayer = drag ? players.find(p => p.id === drag.playerId) : undefined

  const handlePointerDown = (playerId: number, origin: 'bench' | 'field') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!allowed) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag({ playerId, origin, startX: e.clientX, startY: e.clientY, clientX: e.clientX, clientY: e.clientY, moved: false })
    }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    setDrag(d => {
      if (!d) return d
      const moved = d.moved
        || Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD_PX
        || Math.abs(e.clientY - d.startY) > DRAG_THRESHOLD_PX
      if (!moved) return d
      return { ...d, clientX: e.clientX, clientY: e.clientY, moved: true }
    })
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag
    setDrag(null)
    if (!d || !d.moved) return
    const rect = fieldRef.current?.getBoundingClientRect()
    if (!rect) return
    const inside = e.clientX >= rect.left && e.clientX <= rect.right
      && e.clientY >= rect.top && e.clientY <= rect.bottom
    if (inside) {
      const relLeft = (e.clientX - rect.left) / rect.width
      const relTop = (e.clientY - rect.top) / rect.height
      const { x, y } = toCanonical(relLeft, relTop, isDesktop)
      onPlace(d.playerId, x, y)
    } else if (d.origin === 'field') {
      // Any off-field drop returns the player to the bench.
      onRemove(d.playerId)
    }
  }

  const handlePointerCancel = () => setDrag(null)

  const dragHandlers = allowed
    ? {
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerCancel,
      }
    : {}

  // End zone strips along the long axis: left/right in landscape,
  // top/bottom in portrait (canonical left end zone renders at the top).
  const endZonePct = `${END_ZONE_FRACTION * 100}%`
  const endZoneClass = 'absolute bg-emerald-600/25 dark:bg-emerald-500/15'
  const endZones = isDesktop ? (
    <>
      <div className={`${endZoneClass} inset-y-0 left-0 border-r-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ width: endZonePct }} />
      <div className={`${endZoneClass} inset-y-0 right-0 border-l-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ width: endZonePct }} />
    </>
  ) : (
    <>
      <div className={`${endZoneClass} inset-x-0 top-0 border-b-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ height: endZonePct }} />
      <div className={`${endZoneClass} inset-x-0 bottom-0 border-t-2 border-emerald-700/40 dark:border-emerald-400/30`} style={{ height: endZonePct }} />
    </>
  )

  return (
    <div className="space-y-3">
      <div
        ref={fieldRef}
        className={`relative overflow-hidden rounded-xl border border-border bg-emerald-600/20 dark:bg-emerald-500/10 ${
          isDesktop ? 'w-full aspect-[100/37]' : 'mx-auto h-[70vh] aspect-[37/100]'
        }`}
      >
        {endZones}
        {placed.map(player => {
          const pos = positions.get(player.id)!
          const { left, top } = toRendered(pos.x, pos.y, isDesktop)
          const isDragSource = drag?.moved && drag.playerId === player.id
          return (
            <div
              key={player.id}
              onPointerDown={handlePointerDown(player.id, 'field')}
              {...dragHandlers}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center touch-none ${
                allowed ? 'cursor-grab' : ''
              } ${isDragSource ? 'opacity-40' : ''}`}
              style={{ left: `${left}%`, top: `${top}%` }}
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
              {...dragHandlers}
              className={`flex flex-col items-center w-14 touch-none ${allowed ? 'cursor-grab' : ''} ${
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

      {/* Drag ghost: follows the pointer while dragging, TFT-style. Rendered
          through a portal to document.body because position:fixed is resolved
          against the nearest transformed ancestor, and the page's FadeIn
          wrapper keeps an identity transform applied (fill-mode-both), which
          would offset the ghost from the pointer by the wrapper's position. */}
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
