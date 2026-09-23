import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'

const mockUseAuth = vi.hoisted(() => vi.fn())

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../hooks/useEffectiveTier', () => ({
  useEffectiveTier: () => ({ tier: 'free', isEmployeeGranted: false, trialEndsAt: null, refresh: () => {} }),
}))

const SIGNED_IN_VIEWER = {
  user: { id: 'admin-1', email: 'admin@test.com' },
  teams: [{ organization_id: 1, role: 'viewer', name: 'Disc-iples' }],
  currentTeamId: 1,
  role: 'viewer',
  can: { record: false, manageTeam: false, manageRoles: false },
  isGuest: false,
  loading: false,
  logout: vi.fn(),
  switchTeam: vi.fn(),
  createTeam: vi.fn(),
  refreshSession: vi.fn(),
  login: vi.fn(),
  signup: vi.fn(),
  loginWithGoogle: vi.fn(),
  loginWithPasskey: vi.fn(),
  loginAsGuest: vi.fn(),
  forgotPassword: vi.fn(),
}

describe('readOnlyNotice suppression on admin paths', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUseAuth.mockReturnValue(SIGNED_IN_VIEWER)
  })

  it('shows the permission notice on /schedule', () => {
    render(
      <MemoryRouter initialEntries={['/schedule']}>
        <App />
      </MemoryRouter>
    )
    expect(screen.getByText(/you don't have permission to change this team's data/i)).toBeInTheDocument()
  })

  it('does not show the notice on /admin', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <App />
      </MemoryRouter>
    )
    expect(screen.queryByText(/you don't have permission to change this team's data/i)).not.toBeInTheDocument()
  })

  it('does not show the notice on /admin/audit', () => {
    render(
      <MemoryRouter initialEntries={['/admin/audit']}>
        <App />
      </MemoryRouter>
    )
    expect(screen.queryByText(/you don't have permission to change this team's data/i)).not.toBeInTheDocument()
  })
})
