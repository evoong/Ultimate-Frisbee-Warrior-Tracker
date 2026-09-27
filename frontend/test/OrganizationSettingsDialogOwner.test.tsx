import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import OrganizationSettingsDialog from '../components/OrganizationSettingsDialog'
import * as teamsHooks from '../hooks/backend/teams'

const mockUser = { id: 'u-1', email: 'owner@test.com' }
const mockRefreshSession = vi.fn()
const mockSwitchTeam = vi.fn()

let mockAuth = {
  user: mockUser,
  can: { record: true, manageTeam: true, manageRoles: true },
  role: 'captain' as const,
  currentTeamId: 1,
  teams: [{ id: 1, organization_id: 1, name: 'Storm', role: 'captain' as const, is_public: false }],
  refreshSession: mockRefreshSession,
  switchTeam: mockSwitchTeam,
}

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ upload: vi.fn() }) },
    rpc: vi.fn(),
  },
}))

vi.mock('../lib/analytics', () => ({
  track: vi.fn(),
}))

const mockTriggerMembers = vi.fn()
const mockTriggerInvites = vi.fn()
const mockTriggerPlayerLinks = vi.fn()
const mockTriggerRemoveMember = vi.fn()
const mockTriggerTransferCaptain = vi.fn()
const mockTriggerDeleteTeam = vi.fn()

describe('OrganizationSettingsDialog - Owner self-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(teamsHooks, 'useGetTeamMembers').mockReturnValue({
      data: [
        { id: 101, team_id: 1, user_id: 'u-1', email: 'owner@test.com', role: 'captain', player_id: null },
        { id: 102, team_id: 1, user_id: 'u-2', email: 'teammate@test.com', role: 'editor', player_id: null },
      ],
      loading: false,
      error: null,
      trigger: mockTriggerMembers as any,
    })
    vi.spyOn(teamsHooks, 'useGetTeamInvites').mockReturnValue({
      data: [],
      loading: false,
      error: null,
      trigger: mockTriggerInvites as any,
    })
    vi.spyOn(teamsHooks, 'useRemoveMember').mockReturnValue({
      data: true,
      loading: false,
      error: null,
      trigger: mockTriggerRemoveMember as any,
    })
    vi.spyOn(teamsHooks, 'useTransferCaptainship').mockReturnValue({
      data: true,
      loading: false,
      error: null,
      trigger: mockTriggerTransferCaptain as any,
    })
    vi.spyOn(teamsHooks, 'useDeleteTeam').mockReturnValue({
      data: true,
      loading: false,
      error: null,
      trigger: mockTriggerDeleteTeam as any,
    })
  })

  it('renders Danger Zone for captain with Delete team button', () => {
    render(<OrganizationSettingsDialog open={true} onOpenChange={vi.fn()} tier="free" />)
    expect(screen.getByText(/Danger zone/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete team/i })).toBeInTheDocument()
  })

  it('renders Leave team button for user row or in danger zone', () => {
    render(<OrganizationSettingsDialog open={true} onOpenChange={vi.fn()} tier="free" />)
    expect(screen.getByRole('button', { name: /Leave team/i })).toBeInTheDocument()
  })

  it('renders Make captain & step down button on eligible member rows for captain', () => {
    render(<OrganizationSettingsDialog open={true} onOpenChange={vi.fn()} tier="free" />)
    expect(screen.getByRole('button', { name: /Make owner.*teammate@test\.com/i })).toBeInTheDocument()
  })

  it('triggers transfer captainship when confirmed', async () => {
    mockTriggerTransferCaptain.mockResolvedValueOnce(true)
    render(<OrganizationSettingsDialog open={true} onOpenChange={vi.fn()} tier="free" />)
    const btn = screen.getByRole('button', { name: /Make owner.*teammate@test\.com/i })
    fireEvent.click(btn)

    // Confirm dialog / prompt should appear
    const confirmBtn = screen.getByRole('button', { name: /Confirm transfer/i })
    fireEvent.click(confirmBtn)

    await vi.waitFor(() => {
      expect(mockTriggerTransferCaptain).toHaveBeenCalledWith({
        teamId: 1,
        newCaptainUserId: 'u-2',
      })
    })
  })

  it('triggers team deletion after typing team name confirmation', async () => {
    mockTriggerDeleteTeam.mockResolvedValueOnce(true)
    const onOpenChange = vi.fn()
    render(<OrganizationSettingsDialog open={true} onOpenChange={onOpenChange} tier="free" />)
    
    fireEvent.click(screen.getByRole('button', { name: /Delete team/i }))

    const input = screen.getByPlaceholderText('Storm')
    fireEvent.change(input, { target: { value: 'Storm' } })

    const confirmBtn = screen.getByRole('button', { name: /Permanently delete team/i })
    expect(confirmBtn).not.toBeDisabled()
    fireEvent.click(confirmBtn)

    await vi.waitFor(() => {
      expect(mockTriggerDeleteTeam).toHaveBeenCalledWith({ teamId: 1 })
    })
  })
})
