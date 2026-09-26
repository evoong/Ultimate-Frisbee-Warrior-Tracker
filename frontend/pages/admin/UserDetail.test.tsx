import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import UserDetail from './UserDetail'

const adminGet = vi.hoisted(() => vi.fn())
const adminOp = vi.hoisted(() => vi.fn())
vi.mock('../../lib/adminClient', async () => {
  const actual = await vi.importActual<typeof import('../../lib/adminClient')>('../../lib/adminClient')
  return { ...actual, adminGet, adminOp }
})

const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'player@test.com',
  created_at: '2026-01-01T00:00:00Z',
  last_sign_in_at: '2026-09-01T00:00:00Z',
}

const MEMBERSHIPS = [
  { organization_id: 1, name: 'Warriors', role: 'member', since: '2026-01-02' },
  { organization_id: 2, name: 'Storm', role: 'captain', since: '2026-02-02' },
]

const LINKS = [
  { link_id: 10, organization_id: 1, player_id: 5, display_name: 'Test Player', status: 'pending' },
]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/admin/users/${USER.id}`]}>
      <Routes>
        <Route path="/admin/users/:userId" element={<UserDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('UserDetail', () => {
  beforeEach(() => {
    adminGet.mockReset()
    adminOp.mockReset()
  })

  it('renders user email, memberships and pending links', async () => {
    adminGet.mockResolvedValueOnce({ user: USER, memberships: MEMBERSHIPS, player_links: LINKS })
    renderPage()
    await waitFor(() => screen.getByText(USER.email))
    expect(screen.getByText('Warriors')).toBeInTheDocument()
    expect(screen.getByText('Storm')).toBeInTheDocument()
    expect(screen.getByText('Test Player')).toBeInTheDocument()
  })

  it('queues a set_member_role mutation through preview dialog', async () => {
    adminGet.mockResolvedValueOnce({ user: USER, memberships: MEMBERSHIPS, player_links: [] })
    adminOp
      .mockResolvedValueOnce({ preview: { current: MEMBERSHIPS[0], next: { role: 'editor' } } })
      .mockResolvedValueOnce({ ok: true })
    renderPage()
    await waitFor(() => screen.getByText('Warriors'))
    fireEvent.click(screen.getAllByRole('button', { name: /change role/i })[0])
    // The dialog opens with 'editor' as the target role in the input
    await waitFor(() => screen.getByText(/operation/i))
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => {
      expect(adminOp).toHaveBeenCalledWith('set_member_role', expect.anything(), 'apply')
    })
  })

  it('approves a pending player link through preview then apply', async () => {
    adminGet.mockResolvedValueOnce({ user: USER, memberships: [], player_links: LINKS })
    adminOp
      .mockResolvedValueOnce({ preview: { current: LINKS[0] } })
      .mockResolvedValueOnce({ ok: true })
    renderPage()
    await waitFor(() => screen.getByText('Test Player'))
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => screen.getByText(/operation/i))
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => {
      expect(adminOp).toHaveBeenCalledWith('approve_player_link', expect.anything(), 'apply')
    })
  })

  it('shows a friendly error when the user id is invalid', async () => {
    adminGet.mockRejectedValueOnce(Object.assign(new Error('bad id'), { status: 400 }))
    renderPage()
    await waitFor(() => screen.getByText(/could not load/i))
  })

  it('renders the usage metrics strip when the payload carries metrics', async () => {
    adminGet.mockResolvedValueOnce({
      user: USER,
      memberships: MEMBERSHIPS,
      player_links: [],
      feedback_report_count: 2,
      metrics: { events_recorded: 34, chat_messages: 12, last_event_at: '2026-09-20T00:00:00Z' },
    })
    renderPage()
    await waitFor(() => screen.getByText('Usage'))
    expect(screen.getByText('34')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/9\/20\/2026/)).toBeInTheDocument()
  })

  it('omits the usage strip entirely when metrics are absent (older payload)', async () => {
    adminGet.mockResolvedValueOnce({ user: USER, memberships: MEMBERSHIPS, player_links: [] })
    renderPage()
    await waitFor(() => screen.getByText(USER.email))
    expect(screen.queryByText('Usage')).not.toBeInTheDocument()
  })

  it('shows the join date on each membership row', async () => {
    adminGet.mockResolvedValueOnce({ user: USER, memberships: MEMBERSHIPS, player_links: [] })
    renderPage()
    await waitFor(() => screen.getByText('Warriors'))
    expect(screen.getByText(/joined 1\/2\/2026/)).toBeInTheDocument()
  })
})
