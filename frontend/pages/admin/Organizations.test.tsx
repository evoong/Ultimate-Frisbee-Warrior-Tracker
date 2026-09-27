import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom'
import Organizations from './Organizations'

const adminGet = vi.hoisted(() => vi.fn())

vi.mock('../../lib/adminClient', async () => {
  const actual = await vi.importActual<typeof import('../../lib/adminClient')>('../../lib/adminClient')
  return { ...actual, adminGet }
})

const ROW = {
  id: 7,
  name: 'Jam City',
  is_public: true,
  tier: 'pro',
  members: 12,
  created_at: '2026-01-15T10:00:00Z',
  last_activity: '2026-09-01T10:00:00Z',
}
const ROW2 = {
  id: 8,
  name: 'Quiet Club',
  is_public: false,
  tier: 'free',
  members: 3,
  created_at: '2026-02-20T10:00:00Z',
  last_activity: null,
}
const DATA = { rows: [ROW, ROW2], total: 2 }

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <div data-testid="location">{`${location.pathname}${location.search}`}</div>
      <button type="button" onClick={() => navigate(-1)}>back</button>
    </>
  )
}

function renderPage(initial = '/admin/orgs') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <LocationProbe />
      <Routes>
        <Route path="/admin/orgs" element={<Organizations />} />
        <Route path="/admin/org/:id" element={<div>org detail page</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('Organizations', () => {
  beforeEach(() => {
    adminGet.mockReset()
    adminGet.mockResolvedValue(DATA)
  })

  it('fetches with default sort and renders rows', async () => {
    renderPage()
    await waitFor(() => screen.getByText('Jam City'))

    expect(adminGet).toHaveBeenCalledWith('/orgs?sort=name&dir=asc&limit=50&offset=0')
    expect(screen.getByText('Quiet Club')).toBeInTheDocument()
    expect(screen.getByText('Public')).toBeInTheDocument()
    expect(screen.getByText('Private')).toBeInTheDocument()
    expect(screen.getByText(new Date(ROW.created_at).toLocaleDateString())).toBeInTheDocument()
    expect(screen.getByText(new Date(ROW.last_activity!).toLocaleDateString())).toBeInTheDocument()
    // null last_activity renders an em dash, not "Invalid Date"
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('Invalid Date')).not.toBeInTheDocument()
  })

  it('debounces the search input into the q param', async () => {
    renderPage()
    await waitFor(() => expect(adminGet).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText(/search/i), { target: { value: 'Jam' } })
    // Well inside the 300ms window: no second fetch yet.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(adminGet).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(adminGet).toHaveBeenCalledTimes(2), { timeout: 1000 })
    expect(adminGet).toHaveBeenLastCalledWith('/orgs?q=Jam&sort=name&dir=asc&limit=50&offset=0')
    expect(screen.getByTestId('location')).toHaveTextContent('q=Jam')
  })

  it('flips dir when the sorted column header is clicked again', async () => {
    renderPage()
    await waitFor(() => screen.getByText('Jam City'))

    fireEvent.click(screen.getByRole('button', { name: 'Tier' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('sort=tier&dir=asc'))

    fireEvent.click(screen.getByRole('button', { name: 'Tier' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('sort=tier&dir=desc'))
    expect(adminGet).toHaveBeenLastCalledWith('/orgs?sort=tier&dir=desc&limit=50&offset=0')
  })

  it('resets to asc when a new column is sorted', async () => {
    renderPage('/admin/orgs?sort=tier&dir=desc&page=2')
    await waitFor(() => screen.getByText('Jam City'))

    fireEvent.click(screen.getByRole('button', { name: 'Members' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('sort=members&dir=asc&page=1'))
  })

  it('navigates to org detail on row click', async () => {
    renderPage()
    await waitFor(() => screen.getByText('Jam City'))

    fireEvent.click(screen.getByText('Jam City'))
    await waitFor(() => screen.getByText('org detail page'))
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/org/7')
  })

  it('restores params on back navigation', async () => {
    renderPage('/admin/orgs?sort=name&dir=asc')
    await waitFor(() => screen.getByText('Jam City'))

    fireEvent.click(screen.getByRole('button', { name: 'Tier' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('sort=tier'))

    fireEvent.click(screen.getByRole('button', { name: 'back' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('sort=name&dir=asc'))
  })

  it('shows an error with retry when the fetch fails', async () => {
    adminGet.mockRejectedValue(new Error('Failed to load organizations.'))
    renderPage()
    await waitFor(() => screen.getByRole('alert'))

    expect(screen.getByText('Failed to load organizations.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    adminGet.mockResolvedValue(DATA)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => screen.getByText('Jam City'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
