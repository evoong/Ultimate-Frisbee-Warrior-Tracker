import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Dashboard, { addDaysIso, todayIso } from './Dashboard'

const adminGet = vi.hoisted(() => vi.fn())

vi.mock('../../lib/adminClient', async () => {
  const actual = await vi.importActual<typeof import('../../lib/adminClient')>('../../lib/adminClient')
  return { ...actual, adminGet }
})

const PAYLOAD = {
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/dashboard']}>
      <Routes>
        <Route path="/admin/dashboard" element={<Dashboard />} />
        <Route path="/admin/org/:id" element={<div>org detail stub</div>} />
      </Routes>
    </MemoryRouter>
  )
}

async function settled() {
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Usage' })).toBeInTheDocument())
  await waitFor(() => expect(adminGet).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByText('Game events')).toBeInTheDocument())
}

describe('Dashboard', () => {
  beforeEach(() => {
    localStorage.clear()
    adminGet.mockReset()
    adminGet.mockImplementation(() => Promise.resolve(PAYLOAD))
  })

  it('renders the four tabs with their payload sections', async () => {
    renderPage()
    await settled()

    // Usage tab is the default.
    expect(screen.getByText('512')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Billing & AI' }))
    expect(await screen.findByText('Active trials')).toBeInTheDocument()
    expect(screen.getByText('166')).toBeInTheDocument()
    // Controller ruling: the metric is labelled "chat messages", never
    // "billed AI messages" — chat_logs counts user+assistant rows.
    expect(screen.getByText(/chat messages/i)).toBeInTheDocument()
    expect(screen.queryByText(/billed/i)).not.toBeInTheDocument()
    expect(screen.getByText('500')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Engagement' }))
    expect(await screen.findByText('Dormant orgs')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Ops' }))
    expect(await screen.findByText('JAM')).toBeInTheDocument()
    expect(screen.getByText('Pending invites')).toBeInTheDocument()
  })

  it('refetches when grain changes', async () => {
    renderPage()
    await settled()
    expect(adminGet).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'week' }))
    await waitFor(() => expect(adminGet).toHaveBeenCalledTimes(2))
    expect(adminGet.mock.calls[1][0]).toMatch(/grain=week/)
  })

  it('refetches when the range changes', async () => {
    renderPage()
    await settled()
    expect(adminGet).toHaveBeenCalledTimes(1)

    const next = addDaysIso(todayIso(), -3)
    fireEvent.change(screen.getByLabelText('To'), { target: { value: next } })
    await waitFor(() => expect(adminGet).toHaveBeenCalledTimes(2))
    expect(adminGet.mock.calls[1][0]).toContain(`to=${next}`)
  })

  it('shows a validation message and does not fetch when the range exceeds 370 days', async () => {
    renderPage()
    await settled()
    expect(adminGet).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('From'), { target: { value: addDaysIso(todayIso(), -400) } })
    expect(await screen.findByText(/370 days or fewer/)).toBeInTheDocument()
    expect(adminGet).toHaveBeenCalledTimes(1)
  })

  it('falls back to defaults when the stored range has from after to', async () => {
    localStorage.setItem('ufwt_admin_dash_range', JSON.stringify({
      from: todayIso(), to: addDaysIso(todayIso(), -29), grain: 'day',
    }))
    renderPage()
    await settled()

    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe(addDaysIso(todayIso(), -29))
    expect(adminGet.mock.calls[0][0]).toContain(`to=${todayIso()}`)
    expect(adminGet).toHaveBeenCalledTimes(1)
  })

  it('falls back to defaults when the stored range exceeds 370 days', async () => {
    localStorage.setItem('ufwt_admin_dash_range', JSON.stringify({
      from: addDaysIso(todayIso(), -400), to: todayIso(), grain: 'day',
    }))
    renderPage()
    await settled()

    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe(addDaysIso(todayIso(), -29))
    expect(adminGet.mock.calls[0][0]).toContain(`from=${addDaysIso(todayIso(), -29)}`)
  })

  it('keeps controls visible and does not fetch or persist while the range is invalid', async () => {
    renderPage()
    await settled()
    expect(adminGet).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('From'), { target: { value: addDaysIso(todayIso(), -400) } })
    expect(await screen.findByText(/370 days or fewer/)).toBeInTheDocument()

    // Not stuck on the skeleton: loading cleared, inputs and grain visible.
    expect(screen.getByLabelText('From')).toBeInTheDocument()
    expect(screen.getByLabelText('To')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Grain' })).toBeInTheDocument()
    // No fetch fired for the invalid range, and it was not persisted.
    expect(adminGet).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem('ufwt_admin_dash_range')!).from).toBe(addDaysIso(todayIso(), -29))
  })

  it('restores grain from localStorage on mount', async () => {
    localStorage.setItem('ufwt_admin_dash_range', JSON.stringify({
      from: addDaysIso(todayIso(), -29), to: todayIso(), grain: 'week',
    }))
    renderPage()
    await settled()

    expect(adminGet.mock.calls[0][0]).toMatch(/grain=week/)
  })

  it('does not refetch when switching tabs', async () => {
    renderPage()
    await settled()
    expect(adminGet).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('tab', { name: 'Billing & AI' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Engagement' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Ops' }))
    await waitFor(() => expect(screen.getByText('JAM')).toBeInTheDocument())
    expect(adminGet).toHaveBeenCalledTimes(1)
  })

  it('navigates to the org detail page when a top org is clicked', async () => {
    renderPage()
    await settled()

    fireEvent.click(screen.getByRole('tab', { name: 'Ops' }))
    fireEvent.click(await screen.findByRole('button', { name: /JAM/ }))

    expect(await screen.findByText('org detail stub')).toBeInTheDocument()
  })

  it('shows an alert with retry when the fetch fails', async () => {
    adminGet.mockImplementation(() => Promise.reject(new Error('boom')))
    renderPage()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()

    adminGet.mockImplementation(() => Promise.resolve(PAYLOAD))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Game events')).toBeInTheDocument())
  })
})
