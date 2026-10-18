import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import UserMenu from '../components/nav/UserMenu'
import * as teamsHooks from '../hooks/backend/teams'

let mockAuth = { can: { manageTeam: true }, currentTeamId: 1 }
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => mockAuth }))
vi.mock('../lib/supabase', () => ({ supabase: {} }))

const props = { email: 'cap@test.com', role: 'captain' as const, isGuest: false, logout: vi.fn(), openSettings: vi.fn(), openFeedback: vi.fn() }

describe('UserMenu join-request badge', () => {
  it('flags waiting requests on the avatar and on Team settings', () => {
    const spy = vi.spyOn(teamsHooks, 'usePendingJoinRequestCount').mockReturnValue(2)
    render(<UserMenu {...props} />)
    expect(screen.getByLabelText('2 pending join requests')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Account/ }))
    expect(screen.getByText('2 waiting')).toBeInTheDocument()
    // Only managers query at all.
    expect(spy).toHaveBeenCalledWith(1, true, expect.anything())
  })

  it('shows nothing when there are none', () => {
    vi.spyOn(teamsHooks, 'usePendingJoinRequestCount').mockReturnValue(0)
    render(<UserMenu {...props} />)
    expect(screen.queryByLabelText(/pending join request/)).toBeNull()
  })
})
