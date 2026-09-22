import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Search from '../pages/admin/Search'

const mockAdminGet = vi.hoisted(() => vi.fn())

vi.mock('../lib/adminClient', () => ({
  adminGet: (...args: unknown[]) => mockAdminGet(...args),
}))

const RESULTS = {
  organizations: [{ id: 1, name: 'Warriors', is_public: true }],
  users: [{ id: 'u1', email: 'capt@test.com', last_sign_in_at: '2026-01-01T00:00:00Z' }],
  players: [{ id: 10, display_name: 'John Doe', organization_id: 1 }],
}

describe('admin search page', () => {
  beforeEach(() => {
    mockAdminGet.mockReset()
  })

  it('renders an empty prompt before a query, not a result set', () => {
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    )
    expect(screen.getByText('Search organizations, users, or players.')).toBeInTheDocument()
    expect(screen.queryByText('Warriors')).not.toBeInTheDocument()
  })

  it('renders categorized results for a query with clickable links', async () => {
    mockAdminGet.mockResolvedValueOnce(RESULTS)
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'warrior' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => {
      expect(mockAdminGet).toHaveBeenCalledWith('/search?q=warrior')
      expect(screen.getByRole('link', { name: /warriors/i })).toHaveAttribute('href', '/admin/org/1')
      expect(screen.getByRole('link', { name: /capt@test\.com/i })).toHaveAttribute('href', '/admin/user/u1')
      expect(screen.getByRole('link', { name: /john doe/i })).toHaveAttribute('href', '/admin/org/1')
    })
  })

  it('shows a minimum-length error without firing a request', async () => {
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'w' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => {
      expect(screen.getByText('Query must be at least 2 characters.')).toBeInTheDocument()
    })
    expect(mockAdminGet).not.toHaveBeenCalled()
  })

  it('shows an empty state when a query returns nothing', async () => {
    mockAdminGet.mockResolvedValueOnce({
      organizations: [],
      users: [],
      players: [],
    })
    render(
      <MemoryRouter>
        <Search />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzzzz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => {
      expect(screen.getByText('No matches for “zzzzz”.')).toBeInTheDocument()
    })
  })
})
