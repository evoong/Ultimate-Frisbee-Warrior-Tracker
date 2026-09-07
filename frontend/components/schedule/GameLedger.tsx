import * as React from 'react'
import './schedule-theme.css'

// The accent rail belongs to the list, not to the row.
//
// A rail-per-row can only ever wipe in and wipe out, so dragging the pointer
// down a list reads as a string of unrelated blinks. One rail owned by the
// ledger can *travel*: it slides from the row you left to the row you
// arrived at, which is the thing that actually communicates "you are moving
// through a list". It is also cheaper -- one element, one transform, no
// per-row pseudo-element.
//
// Position is applied as a translateY plus a scaleY of a 1px-tall bar rather
// than as top/height, so every frame stays on the compositor.

type Props = {
  children: React.ReactNode
  /**
   * Row the rail rests on when nothing is hovered or focused — the featured
   * fixture. Omit and the rail simply fades out when the pointer leaves.
   */
  parkIndex?: number | null
  className?: string
}

export default function GameLedger({ children, parkIndex = null, className = '' }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const railRef = React.useRef<HTMLSpanElement>(null)
  // Whether the rail is currently showing. Drives the one case that must not
  // animate: arriving from nothing should not sweep the bar down from the top
  // of the list to wherever the pointer happens to have entered.
  const shownRef = React.useRef(false)

  const place = React.useCallback((top: number, height: number, instant: boolean) => {
    const el = railRef.current
    if (!el) return
    if (instant) {
      // Move without tweening, then force a reflow so the browser adopts the
      // new position before the transform transition is handed back.
      el.style.transitionProperty = 'opacity'
    }
    el.style.setProperty('--rail-y', `${top}px`)
    el.style.setProperty('--rail-h', `${height}`)
    el.style.setProperty('--rail-o', '1')
    if (instant) {
      void el.offsetHeight
      el.style.transitionProperty = ''
    }
    shownRef.current = true
  }, [])

  const rowsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-sch-row]'))

  const park = React.useCallback((instant = false) => {
    const container = containerRef.current
    const el = railRef.current
    if (!container || !el) return
    const target = parkIndex == null ? null : rowsOf(container)[parkIndex]
    if (target) {
      place(target.offsetTop, target.offsetHeight, instant)
    } else {
      el.style.setProperty('--rail-o', '0')
      shownRef.current = false
    }
  }, [parkIndex, place])

  // Rest state on mount, and again whenever the list reflows underneath the
  // rail (a section collapsing, a filter changing, a window resize).
  React.useLayoutEffect(() => {
    park(true)
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => park(true))
    ro.observe(container)
    return () => ro.disconnect()
  }, [park, children])

  const followFrom = (target: EventTarget | null) => {
    const container = containerRef.current
    if (!container || !(target instanceof Element)) return
    const row = target.closest<HTMLElement>('[data-sch-row]')
    if (!row || row.parentElement !== container) return
    place(row.offsetTop, row.offsetHeight, !shownRef.current)
  }

  return (
    <div
      ref={containerRef}
      className={`sch-ledger ${className}`}
      onPointerOver={e => followFrom(e.target)}
      onPointerLeave={() => park()}
      // Keyboard tabbing moves the rail too, so the accent always marks the
      // row that is actually about to be activated.
      onFocusCapture={e => followFrom(e.target)}
      onBlurCapture={e => {
        const next = e.relatedTarget
        if (!(next instanceof Node) || !containerRef.current?.contains(next)) park()
      }}
    >
      <span ref={railRef} aria-hidden="true" className="sch-rail" />
      {children}
    </div>
  )
}
