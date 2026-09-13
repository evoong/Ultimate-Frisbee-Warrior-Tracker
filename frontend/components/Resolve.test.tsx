import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import Resolve, { RESOLVE_MS } from './Resolve'
import { setReducedMotion } from '../test/setup'

function Fixture({ loading }: { loading: boolean }) {
  return (
    <Resolve loading={loading} skeleton={<p>skeleton</p>}>
      <p>content</p>
    </Resolve>
  )
}

describe('Resolve', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows only the skeleton while loading', () => {
    render(<Fixture loading />)
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()
  })

  it('keeps the skeleton mounted alongside the content for one transition', () => {
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)

    // Both on screen: this is the cross fade. The outgoing copy is hidden from
    // assistive technology, because the same words are already present in the
    // content underneath it.
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.getByText('skeleton').closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('drops the skeleton once the transition is over', () => {
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)
    act(() => { vi.advanceTimersByTime(RESOLVE_MS) })

    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.queryByText('skeleton')).not.toBeInTheDocument()
  })

  it('restores the skeleton immediately if loading restarts mid transition', () => {
    // A range change landing inside 180ms of the previous one is ordinary on
    // Stats, so the half finished fade has to be abandoned rather than left to
    // fire its timer and drop the skeleton that is now correct again.
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)
    act(() => { vi.advanceTimersByTime(RESOLVE_MS / 2) })
    rerender(<Fixture loading />)

    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()

    // The abandoned timer must not fire later and disturb anything.
    act(() => { vi.advanceTimersByTime(RESOLVE_MS * 2) })
    expect(screen.getByText('skeleton')).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()
  })

  it('never mounts the overlay under reduced motion', () => {
    setReducedMotion(true)
    const { rerender } = render(<Fixture loading />)
    rerender(<Fixture loading={false} />)

    // Not merely a zero length transition: mounting an overlay at all would
    // stack two copies of the content for a frame, for no benefit.
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.queryByText('skeleton')).not.toBeInTheDocument()
  })
})
