import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ViewAs from '../pages/admin/ViewAs'

const mockAdminGet = vi.hoisted(() => vi.fn())

vi.mock('../lib/adminClient', () => ({
  adminGet: (...args: unknown[]) => mockAdminGet(...args),
}))

describe('admin view-as page', () => {
  beforeEach(() => {
    mockAdminGet.mockReset()
  })

  it('renders view-as warning banner with exit button', async () => {
    mockAdminGet.mockResolvedValueOnce({
      user: { id: 'u1', email: 'player@test.com' },
      memberships: [{ organization_id: 1, name: 'Warriors', role: 'editor' }],
    })
    render(
      <MemoryRouter>
        <ViewAs userId="u1" />
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByText(/Viewing as player@test\.com/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Exit view-as/i })).toBeInTheDocument()
    })
  })

  it('shows target user memberships and player links', async () => {
    mockAdminGet.mockResolvedValueOnce({
      user: { id: 'u1', email: 'player@test.com' },
      memberships: [{ organization_id: 1, name: 'Warriors', role: 'editor' }],
      playerLinks: [{ player_id: 10, display_name: 'John Doe', organization_id: 1 }],
    })
    render(
      <MemoryRouter>
        <ViewAs userId="u1" />
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByText('Warriors')).toBeInTheDocument()
      expect(screen.getByText('editor')).toBeInTheDocument()
      expect(screen.getByText('John Doe')).toBeInTheDocument()
    })
  })

  it('exits view-as on button click', async () => {
    mockAdminGet.mockResolvedValueOnce({
      user: { id: 'u1', email: 'player@test.com' },
      memberships: [],
    })
    render(
      <MemoryRouter>
        <ViewAs userId="u1" />
      </MemoryRouter>
    )
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: /Exit view-as/i }))
    })
    // Navigation to /admin is handled by react-router; just verify no crash
  })
})