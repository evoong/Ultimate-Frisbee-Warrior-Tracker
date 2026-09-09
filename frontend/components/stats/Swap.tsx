import { useLayoutEffect, useRef, type ReactNode } from 'react'
import './stats-theme.css'

// A panel body that changes its contents without changing them abruptly.
//
// Two things happen when a new range lands, and both of them used to be a
// hard cut. The content swaps -- handled by `.st-swap`, which dims through
// the change so the numbers cross-fade rather than flicking over. And the
// panel's height changes, often by a couple of hundred pixels: a leaderboard
// is 12 rows all-time and 7 in one season, a chemistry list is 8 pairings or
// 3. An instant height change moves every panel below it, which is the part
// that reads as the page jolting.
//
// So the outer box owns an explicit height, measured off the inner one and
// transitioned. Recharts is unaffected: its ResponsiveContainer measures the
// explicitly-sized div *inside* the content, which never moves, so nothing
// re-measures per frame while the reveal runs.
export default function Swap({ busy, className, children }: {
  /** A refetch is in flight and the content on screen is the previous one. */
  busy: boolean
  /** Goes on the inner box — padding has to live there, not on the outer
   *  one, or an explicit height clips it. */
  className?: string
  children: ReactNode
}) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const o = outer.current
    const i = inner.current
    if (!o || !i) return

    // -1 so the first measurement counts as a resize and lands instantly:
    // without it every panel on the page glides up from zero on first paint.
    let lastWidth = -1
    const sync = () => {
      const box = i.getBoundingClientRect()
      // A width change means the window resized, and the height that follows
      // from it has to be instant — animated, the panel visibly lags the drag.
      // A height change at a stable width is a new range landing, which is
      // the one case this exists for.
      const resized = Math.abs(box.width - lastWidth) > 0.5
      lastWidth = box.width
      if (resized) o.style.transitionProperty = 'opacity'
      o.style.height = `${box.height}px`
      if (resized) {
        void o.offsetHeight
        o.style.transitionProperty = ''
      }
    }

    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(i)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={outer} className="st-swap st-reveal" data-busy={busy}>
      <div ref={inner} className={className}>{children}</div>
    </div>
  )
}
