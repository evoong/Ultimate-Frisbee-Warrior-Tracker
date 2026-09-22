import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import LiveBadge from './LiveBadge'

describe('LiveBadge', () => {
  it('renders the live status when polling is active', () => {
    render(<LiveBadge />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('LIVE')
    expect(badge).toHaveAttribute('aria-label', 'Score updates live while this game is in progress')
  })

  it('renders nothing when polling is inactive', () => {
    const { container } = render(<LiveBadge active={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('marks the pulse dot decorative so screen readers hear one status', () => {
    vi.useFakeTimers()
    render(<LiveBadge />)
    expect(screen.getByRole('status')).not.toHaveAttribute('aria-live')
    vi.useRealTimers()
  })
})
