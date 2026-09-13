import { useEffect, useRef, useState, type ReactNode } from 'react'

/** One handover, in milliseconds. Matches the fade in index.css. */
export const RESOLVE_MS = 180

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * A skeleton that resolves into its content instead of being replaced by it.
 *
 * The pattern this replaces is `cold ? <Skeleton/> : <Content/>`, a hard swap:
 * the skeleton is gone in the same frame the content appears, so there is
 * nothing on screen to fade from and the handover reads as one element leaving
 * and a different one arriving. Here both are mounted for one transition, in
 * the same box, so the placeholder appears to become the thing.
 *
 * That only works because the skeleton is laid out where the content will be.
 * A skeleton of a different shape cross fades into a jump.
 *
 * Composes with Swap rather than duplicating it: Swap owns the panel's height
 * change, Resolve owns its content change.
 */
export default function Resolve({ loading, skeleton, className, children }: {
  /** True while there is nothing to show yet. */
  loading: boolean
  /** Laid out to match the content it stands in for. */
  skeleton: ReactNode
  /** Goes on the box that directly holds `children` (and, while fading, the
   *  one that directly holds `skeleton`) in every state -- never on an
   *  ancestor of it. A layout class like `grid` only lays out its own direct
   *  children, so putting it one level up leaves `children` collapsed into a
   *  single grid item instead of laid out across the row it names.
   *
   *  That box (`.ufwt-resolve-in` / `.ufwt-resolve-out`) is the animated one:
   *  it runs its entrance and exit with `animation-fill-mode: both`, so it
   *  keeps ownership of `opacity` after the animation ends and a transition
   *  on the same element never runs. This className therefore must not carry
   *  `.ufwt-swap` -- the dim would silently never fire. Put `Swap` on the
   *  outside instead, wrapping this whole `Resolve`, which is the
   *  composition the Stats page already uses. */
  className?: string
  children: ReactNode
}) {
  // Holds the outgoing skeleton for exactly one transition after loading ends.
  const [fading, setFading] = useState(false)
  const wasLoading = useRef(loading)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clear = () => {
      if (timer.current != null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }

    if (loading) {
      // Loading restarted. Any half finished fade is abandoned rather than
      // left to fire and remove a skeleton that is correct again.
      clear()
      setFading(false)
    } else if (wasLoading.current && !prefersReducedMotion()) {
      setFading(true)
      timer.current = setTimeout(() => {
        timer.current = null
        setFading(false)
      }, RESOLVE_MS)
    }

    wasLoading.current = loading
  }, [loading])

  // Unmounting mid fade must not leave a timer that calls setState afterwards.
  useEffect(() => () => {
    if (timer.current != null) clearTimeout(timer.current)
  }, [])

  if (loading) return <div className={className}>{skeleton}</div>

  return (
    <div className="ufwt-resolve">
      <div className={`ufwt-resolve-in ${className ?? ''}`}>{children}</div>
      {fading && (
        // aria-hidden because the content underneath already carries the real
        // words; announcing a decorative copy of them would be noise.
        <div className={`ufwt-resolve-out ${className ?? ''}`} aria-hidden="true">{skeleton}</div>
      )}
    </div>
  )
}
