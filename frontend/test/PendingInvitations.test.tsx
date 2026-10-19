import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { InviteCards } from '../components/PendingInvitations'

const refreshSession = vi.fn()
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ refreshSession }) }))
vi.mock('../lib/analytics', () => ({ track: vi.fn() }))
const rpc = vi.fn().mockResolvedValue({ error: null })
vi.mock('../lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }))

const invite = { id: 4, team_id: 1, team_name: 'Disc-iples', role: 'member' as const, invited_by_email: 'cap@test.com', expires_at: '2027-01-01' }

describe('InviteCards', () => {
  it('shows who invited you and joins only on Accept', async () => {
    const onChanged = vi.fn()
    render(<InviteCards invites={[invite]} onChanged={onChanged} />)
    expect(screen.getByText('Disc-iples')).toBeInTheDocument()
    expect(screen.getByText(/Invited by cap@test.com/)).toBeInTheDocument()
    expect(rpc).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('accept_team_invite', { p_invite_id: 4 }))
    await waitFor(() => expect(refreshSession).toHaveBeenCalled())
  })

  it('declines through its own RPC and does not refresh the session', async () => {
    rpc.mockClear(); refreshSession.mockClear()
    render(<InviteCards invites={[invite]} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('decline_team_invite', { p_invite_id: 4 }))
    expect(refreshSession).not.toHaveBeenCalled()
  })
})
