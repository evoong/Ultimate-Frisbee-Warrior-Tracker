import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TierDetails } from './OrganizationSettingsDialog'

describe('TierDetails', () => {
  it('renders tier badge and limits for free tier', () => {
    render(<TierDetails tier="free" />)

    expect(screen.getByText('Tier')).toBeInTheDocument()
    expect(screen.getByText('free')).toBeInTheDocument()
    expect(screen.getByText('15 members')).toBeInTheDocument()
    expect(screen.getByText('30-day history')).toBeInTheDocument()
    expect(screen.getByText('3 strategies')).toBeInTheDocument()
    expect(screen.getByText('5 AI messages/month')).toBeInTheDocument()
  })

  it('shows trial end date when trial active', () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    render(<TierDetails tier="free" trialEndsAt={future} />)

    expect(screen.getByText(/Free trial ends/)).toBeInTheDocument()
  })

  it('shows employee grant when active', () => {
    render(<TierDetails tier="plus" isEmployeeGranted />)

    expect(screen.getByText('Employee grant active')).toBeInTheDocument()
  })

  it('returns null for unknown tier', () => {
    const { container } = render(<TierDetails tier={"unknown" as any} />)
    expect(container.firstChild).toBeNull()
  })
})