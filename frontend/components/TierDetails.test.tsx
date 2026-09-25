import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TierDetails } from './OrganizationSettingsDialog'
import { FreeTierBanner, ArchivedBoxScoreNotice } from './TierNotices'

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
    const past = new Date(Date.now() - 86400000).toISOString()
    render(<TierDetails tier="premium" planSource="trial" trialStartedAt={past} trialEndsAt={future} />)

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

  it('shows Change plan button when captain', () => {
    render(<TierDetails tier="free" role="captain" currentTeamId={1} onPlanChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Change plan' })).toBeInTheDocument()
  })

  it('hides Change plan button when canManageTeam is false', () => {
    render(<TierDetails tier="free" role="editor" currentTeamId={1} />)

    expect(screen.queryByRole('button', { name: 'Change plan' })).not.toBeInTheDocument()
  })

  it('opens plan selector dialog when Change plan clicked', async () => {
    const onPlanChange = vi.fn()
    render(<TierDetails tier="free" role="captain" currentTeamId={1} onPlanChange={onPlanChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Free')).toBeInTheDocument()
    expect(screen.getByText('Plus')).toBeInTheDocument()
    expect(screen.getByText('Premium')).toBeInTheDocument()
  })

  it('calls onPlanChange when tier selected in dialog', async () => {
    const onPlanChange = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://checkout.stripe.com/test' }), { status: 200 })
    )
    const assignSpy = vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign: vi.fn() } as unknown as Location)
    Object.defineProperty(window, 'location', { value: assignSpy, writable: true })

    render(<TierDetails tier="free" role="captain" currentTeamId={1} onPlanChange={onPlanChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Change plan' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Plus' }))

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fetchMock.mockRestore()
  })

  it('shows Manage billing button for paid captain', () => {
    render(<TierDetails tier="plus" role="captain" currentTeamId={1} onPlanChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeInTheDocument()
  })

  it('renders stats history archive notice on Free tier', () => {
    render(<FreeTierBanner tier="free" />)
    expect(screen.getByText('Free tier: stats reflect the last 30 days. Upgrade for complete history.')).toBeInTheDocument()
  })

  it('hides stats history archive notice on non-Free tier', () => {
    const { container } = render(<FreeTierBanner tier="premium" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders archived notice in box score for old games on Free tier', () => {
    render(<ArchivedBoxScoreNotice tier="free" gameDate="2020-01-01" />)
    expect(screen.getByText('Detailed stats for this game are archived on the Free plan. Upgrade to view box scores.')).toBeInTheDocument()
  })

  it('hides archived notice for recent games on Free tier', () => {
    const today = new Date().toISOString().slice(0, 10)
    const { container } = render(<ArchivedBoxScoreNotice tier="free" gameDate={today} />)
    expect(container.firstChild).toBeNull()
  })

  it('hides archived notice for old games on paid tier', () => {
    const { container } = render(<ArchivedBoxScoreNotice tier="plus" gameDate="2020-01-01" />)
    expect(container.firstChild).toBeNull()
  })
})