import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import AuditLog from './AuditLog'

const adminGet = vi.hoisted(() => vi.fn())
vi.mock('../../lib/adminClient', async () => {
  const actual = await vi.importActual<typeof import('../../lib/adminClient')>('../../lib/adminClient')
  return { ...actual, adminGet }
})

const ROW = {
  id: 1,
  at: '2026-09-23T00:00:00Z',
  admin_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  admin_role: 'superadmin',
  operation: 'set_member_role',
  target: { team_id: 1 },
  before: { role: 'member' },
  after: { role: 'editor' },
  result: 'ok' as const,
  error: null,
  request_id: 'req-1',
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuditLog />
    </MemoryRouter>
  )
}

describe('AuditLog', () => {
  beforeEach(() => {
    adminGet.mockReset()
  })

  it('renders audit rows with operation and result', async () => {
    adminGet.mockResolvedValueOnce({ rows: [ROW], next_cursor: null })
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('set_member_role')).toHaveLength(2)
      expect(screen.getByText('ok')).toBeInTheDocument()
    })
  })

  it('shows error and request id in details when expanded', async () => {
    adminGet.mockResolvedValueOnce({
      rows: [{ ...ROW, result: 'denied', error: 'not a member' }],
      next_cursor: null,
    })
    renderPage()
    await waitFor(() => screen.getByText('denied'))
    fireEvent.click(screen.getByRole('button', { name: /details/i }))
    expect(screen.getByText(/not a member/)).toBeInTheDocument()
    expect(screen.getByText(/req-1/)).toBeInTheDocument()
  })

  it('shows empty state when no rows', async () => {
    adminGet.mockResolvedValueOnce({ rows: [], next_cursor: null })
    renderPage()
    await waitFor(() => screen.getByText(/no entries/i))
  })

  // Regression (CI-only red, first seen after #156, x64 runners 3/3): the
  // empty state used to render on the FIRST paint because busy started
  // false — while the mount effect's fetch was in flight. On the real route
  // the page lazy-mounts OUTSIDE act (the admin chunk resolves after the
  // test's render() returns), so that first paint is observable:
  // AppAdminNotice's findByText latched the transient node, then busy=true
  // detached it and the assert failed with "element could not be found in
  // the document". Siblings (Organizations, Flags) initialize their loading
  // state true for exactly this reason — a fetch is in flight from mount.
  // This test lazy-mounts the same way, so the transient is visible to a
  // plain query: absent after the fix, present on any revert.
  it('does not flash the empty state while the first load is in flight', async () => {
    adminGet.mockImplementationOnce(() => new Promise(() => {}))
    const LazyAuditLog = lazy(() => Promise.resolve({ default: AuditLog }))
    render(
      <MemoryRouter>
        <Suspense fallback={<div>loading…</div>}>
          <LazyAuditLog />
        </Suspense>
      </MemoryRouter>
    )
    await screen.findByLabelText(/filter by operation/i)
    expect(screen.queryByText(/no entries/i)).not.toBeInTheDocument()
  })

  it('loads more appends rows using cursor', async () => {
    const second = { ...ROW, id: 2, operation: 'remove_member' }
    adminGet
      .mockResolvedValueOnce({ rows: [ROW], next_cursor: '1' })
      .mockResolvedValueOnce({ rows: [second], next_cursor: null })
    renderPage()
    await waitFor(() => screen.getByText('set_member_role'))
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    await waitFor(() => screen.getByText('remove_member'))
    expect(adminGet).toHaveBeenCalledTimes(2)
  })

  it('filtering resets the list instead of appending', async () => {
    const second = { ...ROW, id: 2, operation: 'remove_member' }
    adminGet
      .mockResolvedValueOnce({ rows: [ROW, second], next_cursor: null })
      .mockResolvedValueOnce({ rows: [second], next_cursor: null })
    renderPage()
    await waitFor(() => screen.getByText('remove_member'))
    fireEvent.change(screen.getByLabelText(/filter by operation/i), {
      target: { value: 'remove_member' },
    })
    await waitFor(() => {
      const list = screen.getByRole('list')
      expect(within(list).queryByText('set_member_role')).not.toBeInTheDocument()
      expect(within(list).getByText('remove_member')).toBeInTheDocument()
    })
  })

  it('surfaces a fetch error', async () => {
    adminGet.mockRejectedValueOnce(new Error('admin request failed (500)'))
    renderPage()
    await waitFor(() => screen.getByText(/failed/i))
  })
})
