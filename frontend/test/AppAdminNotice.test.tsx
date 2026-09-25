import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'

const mockUseAuth = vi.hoisted(() => vi.fn())
const adminGet = vi.hoisted(() => vi.fn())

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../hooks/useEffectiveTier', () => ({
  useEffectiveTier: () => ({ tier: 'free', isEmployeeGranted: false, trialEndsAt: null, refresh: () => {} }),
}))

// The admin shell gates on useAdminRole() and every admin page fetches via
// adminGet. adminGet's export is mocked for the pages; useAdminRole is mocked
// statically because its whoami fetch happens *inside* adminClient, past the
// mocked export binding.
vi.mock('../lib/adminClient', async () => {
  const actual = await vi.importActual<typeof import('../lib/adminClient')>('../lib/adminClient')
  return {
    ...actual,
    adminGet,
    useAdminRole: () => ({ role: 'superadmin', loading: false }),
  }
})

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

const DASH_PAYLOAD = {
  range: { from: '2026-08-27', to: '2026-09-25', grain: 'day' },
  usage: {
    totals: { orgs: 3, members: 12, players: 25, games: 34, game_events: 512 },
    series: {
      new_orgs: [{ bucket: '2026-09-01', count: 0 }],
      new_games: [{ bucket: '2026-09-01', count: 2 }],
      new_events: [{ bucket: '2026-09-01', count: 40 }],
    },
  },
  billing: {
    tier_mix: { free: 1, plus: 1, premium: 1, employee_granted: 0 },
    active_trials: 2,
    ai_messages_in_range: 166,
    ai_cap_by_tier: { free: 5, plus: 100, premium: 500 },
  },
  engagement: {
    sign_ins: [{ bucket: '2026-09-01', count: 3 }],
    active_orgs_in_range: 2,
    dormant_orgs: 1,
  },
  ops: {
    top_orgs_by_events: [{ id: 3, name: 'JAM', game_events: 512 }],
    pending_invites: 4,
    unclaimed_player_links: 7,
    audit_events_in_range: 9,
  },
}

const NAV_TABS: [string, string][] = [
  ['Search', '/admin/search'],
  ['Dashboard', '/admin/dashboard'],
  ['Organizations', '/admin/orgs'],
  ['Audit log', '/admin/audit'],
  ['Feature flags', '/admin/flags'],
]

// Different user id from the suite above: adminClient's whoamiCache is keyed
// by user, and the notice tests above already resolved id 'admin-1' to a
// non-admin (their unmocked fetch rejects). A fresh id gets a fresh whoami.
const ADMIN_SUPERADMIN = {
  ...SIGNED_IN_VIEWER,
  user: { id: 'admin-2', email: 'admin@test.com' },
}

describe('admin route wiring', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
    mockUseAuth.mockReturnValue(ADMIN_SUPERADMIN)
    localStorage.clear()
    adminGet.mockReset()
    adminGet.mockImplementation((path: string) => {
      if (path.startsWith('/dashboard')) return Promise.resolve(DASH_PAYLOAD)
      if (path.startsWith('/audit')) return Promise.resolve({ rows: [], next_cursor: null })
      if (path.startsWith('/flags')) return Promise.resolve({ registry: [], overrides: [] })
      return Promise.resolve({})
    })
  })

  it('lands /admin on the Dashboard', async () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <App />
      </MemoryRouter>
    )
    expect(await screen.findByRole('heading', { name: 'Dashboard' }, { timeout: 10000 })).toBeInTheDocument()
    expect(await screen.findByText('Game events')).toBeInTheDocument()
  })

  it('renders Search at /admin/search', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/search']}>
        <App />
      </MemoryRouter>
    )
    expect(await screen.findByRole('heading', { name: 'Support search' }, { timeout: 10000 })).toBeInTheDocument()
  })

  it('still resolves /admin/audit', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/audit']}>
        <App />
      </MemoryRouter>
    )
    expect(await screen.findByText('No entries yet.', {}, { timeout: 10000 })).toBeInTheDocument()
  })

  it('still resolves /admin/flags', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/flags']}>
        <App />
      </MemoryRouter>
    )
    expect(await screen.findByRole('heading', { name: 'Feature flags' }, { timeout: 10000 })).toBeInTheDocument()
  })

  it('shows five admin nav tabs with the right hrefs', async () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <App />
      </MemoryRouter>
    )
    await screen.findByRole('heading', { name: 'Dashboard' }, { timeout: 10000 })
    for (const [label, href] of NAV_TABS) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href)
    }
  })
})
