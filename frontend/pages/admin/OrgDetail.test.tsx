import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import OrgDetail from './OrgDetail'

const adminGet = vi.hoisted(() => vi.fn())
const adminOp = vi.hoisted(() => vi.fn())
const useAdminRole = vi.hoisted(() => vi.fn(() => ({ role: 'superadmin', loading: false })))

vi.mock('../../lib/adminClient', async () => {
  const actual = await vi.importActual<typeof import('../../lib/adminClient')>('../../lib/adminClient')
  return { ...actual, adminGet, adminOp, useAdminRole }
})

const ORG = { id: 5, name: 'Test Org', is_public: true, created_at: '2026-01-01T00:00:00Z' }
const DATA = {
  organization: ORG,
  members: [{ user_id: 'u1', email: 'owner@test.com', role: 'captain' }],
  teams: [{ id: 10, name: 'Team A' }],
  counts: { games: 10, players: 20, seasons: 2 },
  pending_invites: [],
  legacy_organization_members: [],
  metrics: {
    chat_messages: 50,
    game_events: 100,
    strategy_plays: 10,
    attendance: 40,
    last_activity: '2026-09-23T12:00:00Z',
  },
  feature_flags: [
    { key: 'show_turnovers', description: 'Show turnovers', default_on: false, override: true, effective: true },
  ],
}

function renderPage(orgId = '5') {
  return render(
    <MemoryRouter initialEntries={[`/admin/orgs/${orgId}`]}>
      <Routes>
        <Route path="/admin/orgs/:orgId" element={<OrgDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('OrgDetail', () => {
  beforeEach(() => {
    adminGet.mockReset()
    adminOp.mockReset()
    useAdminRole.mockReturnValue({ role: 'superadmin', loading: false })
  })

  it('renders org info and metrics strip', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    renderPage()
    await waitFor(() => screen.getByText('Test Org'))
    expect(screen.getByText(/Org #5/)).toBeInTheDocument()
    
    // Check counts
    expect(screen.getByText('Players')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
    expect(screen.getByText('AI messages')).toBeInTheDocument()
    expect(screen.getByText('50')).toBeInTheDocument()
    expect(screen.getByText('Last activity')).toBeInTheDocument()
    expect(screen.getByText(/2026/)).toBeInTheDocument()
  })

  it('renders feature flags with override status', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    renderPage()
    await waitFor(() => screen.getByText('show_turnovers'))
    expect(screen.getByText('Override (On)')).toBeInTheDocument()
    expect(screen.getByText(/Effective: On/)).toBeInTheDocument()
    expect(screen.getByText(/Default: Off/)).toBeInTheDocument()
  })

  it('opens set_flag operation dialog on toggle click', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    adminOp.mockResolvedValue({ preview: { ok: true } })
    renderPage()
    await waitFor(() => screen.getByText('show_turnovers'))
    
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }))
    await waitFor(() => screen.getByText(/Toggle Feature Flag: show_turnovers/))
    
    expect(adminOp).toHaveBeenCalledWith('set_flag', expect.objectContaining({
      key: 'show_turnovers',
      org_id: 5,
      enabled: false
    }), 'preview')
  })

  it('disables toggle for non-superadmin', async () => {
    useAdminRole.mockReturnValue({ role: 'support', loading: false })
    adminGet.mockResolvedValueOnce(DATA)
    renderPage()
    await waitFor(() => screen.getByText('show_turnovers'))
    
    const btn = screen.getByRole('button', { name: /turn off/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Requires superadmin role')
  })
})
