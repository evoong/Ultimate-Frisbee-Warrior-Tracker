import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import OrgDetail from '../pages/admin/OrgDetail'

const mockAdminGet = vi.hoisted(() => vi.fn())
const mockAdminOp = vi.hoisted(() => vi.fn())

vi.mock('../lib/adminClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/adminClient')>()
  return {
    ...actual,
    adminGet: (...args: unknown[]) => mockAdminGet(...args),
    adminOp: (...args: unknown[]) => mockAdminOp(...args),
    useAdminRole: () => ({ role: 'superadmin', loading: false }),
  }
})

const ORG = {
  organization: { id: 1, name: 'Warriors', is_public: true, created_at: '2026-01-01T00:00:00Z' },
  members: [
    { user_id: 'u1', email: 'capt@test.com', role: 'captain' },
    { user_id: 'u2', email: 'editor@test.com', role: 'editor' },
    { user_id: 'u3', email: 'member@test.com', role: 'member' },
  ],
  teams: [{ id: 1, name: 'Warriors' }],
  counts: { games: 0, players: 0, seasons: 0 },
  pending_invites: [],
  legacy_organization_members: [],
}

describe('admin org detail page', () => {
  beforeEach(() => {
    mockAdminGet.mockReset()
    mockAdminOp.mockReset()
  })

  it('renders org header with name, id, visibility, and member count', async () => {
    mockAdminGet.mockResolvedValueOnce(ORG)
    render(
      <MemoryRouter>
        <OrgDetail orgId="1" />
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByText('Warriors')).toBeInTheDocument()
      expect(screen.getByText(/Org #1/)).toBeInTheDocument()
      expect(screen.getByText(/\bPublic\b/)).toBeInTheDocument()
      expect(screen.getByText(/3 members/)).toBeInTheDocument()
    })
  })

  it('lists members with roles and action buttons', async () => {
    mockAdminGet.mockResolvedValueOnce(ORG)
    render(
      <MemoryRouter>
        <OrgDetail orgId="1" />
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /change role.*capt@test\.com/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /remove.*capt@test\.com/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /make captain.*editor@test\.com/i })).toBeInTheDocument()
    })
  })

  it('changes member role through audited operation via preview dialog', async () => {
    mockAdminGet.mockResolvedValueOnce(ORG)
    mockAdminOp
      .mockResolvedValueOnce({ preview: { current: ORG.members[1], next: { role: 'editor' } } })
      .mockResolvedValueOnce({ ok: true })
    render(<MemoryRouter><OrgDetail orgId="1" /></MemoryRouter>)
    await waitFor(() => fireEvent.click(screen.getByRole('button', { name: /change role.*editor@test\.com/i })))
    await waitFor(() => screen.getByText(/operation/i))
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => {
      expect(mockAdminOp).toHaveBeenCalledWith('set_member_role', { team_id: 1, user_id: 'u2', role: 'editor' }, 'apply')
    })
  })

  it('removes a member through audited operation via preview dialog', async () => {
    mockAdminGet.mockResolvedValueOnce(ORG)
    mockAdminOp
      .mockResolvedValueOnce({ preview: { current: ORG.members[2] } })
      .mockResolvedValueOnce({ ok: true })
    render(<MemoryRouter><OrgDetail orgId="1" /></MemoryRouter>)
    await waitFor(() => fireEvent.click(screen.getByRole('button', { name: /remove.*member@test\.com/i })))
    await waitFor(() => screen.getByText(/operation/i))
    fireEvent.change(screen.getByPlaceholderText('remove'), { target: { value: 'remove' } })
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => {
      expect(mockAdminOp).toHaveBeenCalledWith('remove_member', { team_id: 1, user_id: 'u3' }, 'apply')
    })
  })

  it('shows invite form and creates invite link on submit via preview dialog', async () => {
    mockAdminGet.mockResolvedValueOnce(ORG)
    mockAdminOp
      .mockResolvedValueOnce({ preview: { invite: { email: 'new@test.com', role: 'editor' } } })
      .mockResolvedValueOnce({ ok: true })
    render(
      <MemoryRouter>
        <OrgDetail orgId="1" />
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByLabelText('Email')).toBeInTheDocument()
      expect(screen.getByLabelText('Role')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@test.com' } })
    fireEvent.click(screen.getByRole('button', { name: /create invite/i }))
    await waitFor(() => screen.getByText(/operation/i))
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => {
      expect(mockAdminOp).toHaveBeenCalledWith('create_invite_link', { org_id: 1, email: 'new@test.com', role: 'editor' }, 'apply')
    })
  })

  it('transfers captainship via modal and calls adminOp via preview dialog', async () => {
    mockAdminGet.mockResolvedValueOnce(ORG)
    mockAdminOp
      .mockResolvedValueOnce({ preview: { target: 'u2', demoted: ['u1'] } })
      .mockResolvedValueOnce({ ok: true })
    render(
      <MemoryRouter>
        <OrgDetail orgId="1" />
      </MemoryRouter>
    )
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /make captain.*editor@test\.com/i }))
    })
    await waitFor(() => {
      expect(screen.getByText(/operation/i)).toBeInTheDocument()
      expect(screen.getByText(/transfer captainship/i)).toBeInTheDocument()
    })
    fireEvent.change(screen.getByPlaceholderText('transfer'), { target: { value: 'transfer' } })
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => {
      expect(mockAdminOp).toHaveBeenCalledWith('transfer_captainship', { org_id: 1, new_captain_user_id: 'u2', reason: 'Admin transfer' }, 'apply')
    })
  })
})
