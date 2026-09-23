import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AdBanner } from './AdBanner'

describe('AdBanner', () => {
  it('shows Free tier banner with neutral tokens', () => {
    const { container } = render(<AdBanner tier="free" />)

    expect(screen.getByText('Support Ultimate Frisbee Warrior Tracker with ads.')).toBeInTheDocument()
    expect(screen.getByText('Upgrade to remove ads.')).toHaveClass('text-foreground')
    expect(container.firstChild).toHaveClass('bg-muted', 'border-border', 'text-muted-foreground')
  })

  it('hides until tier resolves and for paid tiers', () => {
    const { rerender } = render(<AdBanner tier={null} />)

    expect(screen.queryByText('Support Ultimate Frisbee Warrior Tracker with ads.')).not.toBeInTheDocument()

    rerender(<AdBanner tier="free" />)
    expect(screen.getByText('Support Ultimate Frisbee Warrior Tracker with ads.')).toBeInTheDocument()

    rerender(<AdBanner tier="plus" />)
    expect(screen.queryByText('Support Ultimate Frisbee Warrior Tracker with ads.')).not.toBeInTheDocument()
  })
})