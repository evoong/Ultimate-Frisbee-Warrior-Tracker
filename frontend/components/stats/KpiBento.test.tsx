import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { KpiRowSkeleton, MetricCardSkeleton } from './KpiBento'

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

  it('models the team card as the tallest of the three, not a third leader card', () => {
    // The real TeamCard has no crest and no meter, but a four cell strip that
    // wraps to two rows -- that is what makes it the tallest card in the row.
    // A skeleton built only from the leader shape stands a row short of the
    // real one and reintroduces a smaller version of the jolt this exists to
    // remove.
    const { container } = render(<KpiRowSkeleton />)
    const cards = container.querySelectorAll('.st-panel.st-kpi')
    expect(cards).toHaveLength(3)

    const [first, second, third] = Array.from(cards)
    expect(first.querySelector('.st-meter')).not.toBeNull()
    expect(second.querySelector('.st-meter')).not.toBeNull()
    expect(third.querySelector('.st-meter')).toBeNull()
    expect(third.querySelectorAll('.st-strip-cell')).toHaveLength(4)
  })
})

describe('MetricCardSkeleton', () => {
  it('renders one card per requested count', () => {
    const { container } = render(<MetricCardSkeleton count={4} />)
    expect(container.querySelectorAll('.st-panel.st-kpi')).toHaveLength(4)
  })

  it('tracks a different count for the turnovers-off row', () => {
    const { container } = render(<MetricCardSkeleton count={3} />)
    expect(container.querySelectorAll('.st-panel.st-kpi')).toHaveLength(3)
  })

  it('has no crest, no meter and no strip -- MetricCard has none of those', () => {
    // This is what keeps the skeleton from standing taller than the row it
    // stands in for. MetricCard is an overline and a figure, nothing else;
    // reusing the Overview row's skeleton here would reintroduce the jolt
    // this component exists to remove.
    const { container } = render(<MetricCardSkeleton count={3} />)
    expect(container.querySelector('.st-meter')).toBeNull()
    expect(container.querySelector('.st-strip')).toBeNull()
    expect(container.querySelector('.st-crest')).toBeNull()
  })
})
