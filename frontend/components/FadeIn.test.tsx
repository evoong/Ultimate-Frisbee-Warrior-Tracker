import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import FadeIn from './FadeIn'

describe('FadeIn', () => {
  it('fades without moving by default', () => {
    render(<FadeIn data-testid="f">x</FadeIn>)
    const el = screen.getByTestId('f')
    expect(el.className).toContain('fade-in')
    // The slide is the regression being prevented: with a skeleton already in
    // the box, an 8px rise is movement with no cause.
    expect(el.className).not.toContain('slide-in-from-bottom')
  })

  it('slides when a caller opts in', () => {
    render(<FadeIn slide data-testid="f">x</FadeIn>)
    expect(screen.getByTestId('f').className).toContain('slide-in-from-bottom-2')
  })

  it('never carries fill-mode-both', () => {
    // fill-mode: both leaves the animation owning opacity after it ends, so a
    // transition on the same element silently never runs.
    render(<FadeIn data-testid="f">x</FadeIn>)
    expect(screen.getByTestId('f').className).not.toContain('fill-mode-both')
  })

  it('still supports a stagger delay', () => {
    render(<FadeIn delay={120} data-testid="f">x</FadeIn>)
    expect(screen.getByTestId('f')).toHaveStyle({ animationDelay: '120ms' })
  })

  it('carries fill-mode-backwards when delayed, and never fill-mode-both', () => {
    // Regression: with no fill mode at all, a delayed element renders at its
    // natural opacity during the delay, then snaps to 0 when the animation
    // starts, then fades in -- Roster's staggered lists blinking after up to
    // 1.2s of being fully visible. `backwards` holds it at 0 through the
    // delay without retaining ownership of opacity afterward, so it must not
    // regress to `both` either.
    render(<FadeIn delay={80} data-testid="f">x</FadeIn>)
    const el = screen.getByTestId('f')
    expect(el.className).toContain('fill-mode-backwards')
    expect(el.className).not.toContain('fill-mode-both')
  })

  it('does not carry fill-mode-backwards with no delay', () => {
    render(<FadeIn data-testid="f">x</FadeIn>)
    expect(screen.getByTestId('f').className).not.toContain('fill-mode-backwards')
  })
})
