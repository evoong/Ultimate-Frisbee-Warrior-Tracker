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
})
