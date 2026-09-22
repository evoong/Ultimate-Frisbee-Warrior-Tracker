import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AdBanner } from './AdBanner'

describe('AdBanner', () => {
  it('renders only for free tier', () => {
    const { rerender } = render(<AdBanner tier="free" />)

    expect(screen.getByText('Support Ultimate Frisbee Warrior Tracker with ads.')).toBeInTheDocument()

    rerender(<AdBanner tier="plus" />)
    expect(screen.queryByText('Support Ultimate Frisbee Warrior Tracker with ads.')).not.toBeInTheDocument()
  })
})