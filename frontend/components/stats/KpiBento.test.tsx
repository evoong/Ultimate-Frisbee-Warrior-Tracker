import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { KpiRowSkeleton } from './KpiBento'

describe('KpiRowSkeleton', () => {
  it('renders one card per real card', () => {
    const { container } = render(<KpiRowSkeleton />)
    expect(container.querySelectorAll('.st-panel.st-kpi')).toHaveLength(3)
  })

  it('reuses the real card classes rather than approximating them', () => {
    // This is what keeps the skeleton the same height as the card it stands in
    // for. A hand picked height drifts the moment the card's padding changes.
    const { container } = render(<KpiRowSkeleton />)
    const card = container.querySelector('.st-panel.st-kpi')!
    expect(card.querySelector('.st-strip')).not.toBeNull()
    expect(card.querySelector('.st-meter')).not.toBeNull()
  })

  it('can size itself for a different card count', () => {
    const { container } = render(<KpiRowSkeleton count={4} />)
    expect(container.querySelectorAll('.st-panel.st-kpi')).toHaveLength(4)
  })
})
