import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Flags from './Flags'

const adminGet = vi.hoisted(() => vi.fn())
const adminOp = vi.hoisted(() => vi.fn())
const useAdminRole = vi.hoisted(() => vi.fn(() => ({ role: 'superadmin', loading: false })))

vi.mock('../../lib/adminClient', async () => {
  const actual = await vi.importActual<typeof import('../../lib/adminClient')>('../../lib/adminClient')
  return { ...actual, adminGet, adminOp, useAdminRole }
})

const DATA = {
  registry: [
    { key: 'show_turnovers', description: 'Show turnover stats throughout the app', default_on: false },
    { key: 'ai_coach', description: 'Enable AI coach suggestions', default_on: true },
  ],
  overrides: [
    {
      org_id: 5,
      org_name: 'Test Org',
      flag_key: 'show_turnovers',
      enabled: true,
      updated_by: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      updated_at: '2026-09-24T12:00:00Z',
    },
  ],
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Flags />
    </MemoryRouter>
  )
}

describe('Flags', () => {
  beforeEach(() => {
    adminGet.mockReset()
    adminOp.mockReset()
    useAdminRole.mockReturnValue({ role: 'superadmin', loading: false })
  })

  it('renders registry table with key and description', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    renderPage()
    await waitFor(() => screen.getByText('ai_coach'))

    expect(screen.getByText('Enable AI coach suggestions')).toBeInTheDocument()
    // Default: On appears in the registry card
    expect(screen.getByText('Default: On')).toBeInTheDocument()
  })

  it('renders overrides table with org and flag', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    renderPage()
    await waitFor(() => screen.getByText('Test Org'))

    const table = screen.getByRole('table')
    expect(table).toHaveTextContent('Test Org')
    expect(table).toHaveTextContent('show_turnovers')
  })

  it('renders updated_by in overrides table', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    renderPage()
    await waitFor(() => screen.getByText('Test Org'))

    const table = screen.getByRole('table')
    expect(screen.getByText('Updated by')).toBeInTheDocument()
    expect(table).toHaveTextContent('aaaaaaaa')
  })

  it('renders error message in place of tables when load fails', async () => {
    adminGet.mockRejectedValueOnce(new Error('Failed to load feature flags.'))
    renderPage()
    await waitFor(() => screen.getByRole('alert'))

    expect(screen.getByText('Failed to load feature flags.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('Global registry')).not.toBeInTheDocument()
  })

  it('opens set_flag dialog on registry toggle click', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    adminOp.mockResolvedValue({ preview: { ok: true } })
    renderPage()
    await waitFor(() => screen.getByText('ai_coach'))

    fireEvent.click(screen.getByRole('button', { name: /turn off ai_coach/i }))
    await waitFor(() => screen.getByText(/Feature flag: ai_coach/))

    expect(adminOp).toHaveBeenCalledWith('set_flag', expect.objectContaining({
      key: 'ai_coach',
      org_id: null,
      enabled: false,
    }), 'preview')
  })

  it('opens set_flag dialog with org id on override toggle click', async () => {
    adminGet.mockResolvedValueOnce(DATA)
    adminOp.mockResolvedValue({ preview: { ok: true } })
    renderPage()
    await waitFor(() => screen.getByText('Test Org'))

    fireEvent.click(screen.getByRole('button', { name: /turn off show_turnovers for test org/i }))
    await waitFor(() => screen.getByText(/Feature flag: show_turnovers/))

    expect(adminOp).toHaveBeenCalledWith('set_flag', expect.objectContaining({
      key: 'show_turnovers',
      org_id: 5,
      enabled: false,
    }), 'preview')
  })

  it('disables toggles for readonly role', async () => {
    useAdminRole.mockReturnValue({ role: 'readonly', loading: false })
    adminGet.mockResolvedValueOnce(DATA)
    renderPage()
    await waitFor(() => screen.getByText('ai_coach'))

    const btn = screen.getByRole('button', { name: /turn off ai_coach/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Requires superadmin role')
  })
})
