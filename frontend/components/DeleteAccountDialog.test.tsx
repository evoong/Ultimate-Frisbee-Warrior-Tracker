import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DeleteAccountDialog } from './DeleteAccountDialog'

const mockUseAuth = vi.hoisted(() => vi.fn())

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

function blockersResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      deletable: true,
      isPlatformAdmin: false,
      soleCaptainTeams: [],
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

describe('DeleteAccountDialog', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let logout: ReturnType<typeof vi.fn>
  let assign: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(blockersResponse())
    vi.stubGlobal('fetch', fetchMock)
    logout = vi.fn().mockResolvedValue(undefined)
    assign = vi.fn()
    mockUseAuth.mockReset()
    mockUseAuth.mockReturnValue({ logout })
    vi
      .spyOn(window, 'location', 'get')
      .mockReturnValue({ ...window.location, assign } as unknown as Location)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders blockers and hides submit when not deletable', async () => {
    fetchMock.mockResolvedValue(
      blockersResponse({
        deletable: false,
        isPlatformAdmin: true,
        soleCaptainTeams: [{ team_id: 1, name: 'Team Alpha' }],
      })
    )

    render(<DeleteAccountDialog open onOpenChange={() => {}} email="test@test.com" />)

    expect(await screen.findByText(/cannot be deleted yet/i)).toBeInTheDocument()
    expect(screen.getByText('Team Alpha')).toBeInTheDocument()
    expect(screen.getByText(/platform administrator/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete account/i })).not.toBeInTheDocument()
  })

  it('lists every sole-captain team', async () => {
    fetchMock.mockResolvedValue(
      blockersResponse({
        deletable: false,
        soleCaptainTeams: [
          { team_id: 1, name: 'Team Alpha' },
          { team_id: 2, name: 'Team Beta' },
        ],
      })
    )

    render(<DeleteAccountDialog open onOpenChange={() => {}} email="test@test.com" />)

    expect(await screen.findByText('Team Alpha')).toBeInTheDocument()
    expect(screen.getByText('Team Beta')).toBeInTheDocument()
  })

  it('enables submit only on exact email match', async () => {
    render(<DeleteAccountDialog open onOpenChange={() => {}} email="test@test.com" />)

    const submit = await screen.findByRole('button', { name: /delete account/i })
    expect(submit).toBeDisabled()

    const input = screen.getByPlaceholderText('test@test.com')
    fireEvent.change(input, { target: { value: 'wrong@test.com' } })
    expect(screen.getByRole('button', { name: /delete account/i })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'test@test.com' } })
    expect(screen.getByRole('button', { name: /delete account/i })).not.toBeDisabled()
  })

  it('submits deletion, logs out and navigates on success', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/account/delete/blockers') return Promise.resolve(blockersResponse())
      return Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    const onOpenChange = vi.fn()
    render(<DeleteAccountDialog open onOpenChange={onOpenChange} email="test@test.com" />)

    fireEvent.change(await screen.findByPlaceholderText('test@test.com'), {
      target: { value: 'test@test.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /delete account/i }))

    await waitFor(() => expect(logout).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ confirmationEmail: 'test@test.com' }),
    })
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'))
  })

  it('shows the error and stays open on failure', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/account/delete/blockers') return Promise.resolve(blockersResponse())
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'account deletion is incomplete, try again' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    const onOpenChange = vi.fn()
    render(<DeleteAccountDialog open onOpenChange={onOpenChange} email="test@test.com" />)

    fireEvent.change(await screen.findByPlaceholderText('test@test.com'), {
      target: { value: 'test@test.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /delete account/i }))

    expect(await screen.findByText(/try again/i)).toBeInTheDocument()
    expect(logout).not.toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('shows a load error when the blockers check fails', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401 })
    )

    render(<DeleteAccountDialog open onOpenChange={() => {}} email="test@test.com" />)

    expect(await screen.findByText(/not authenticated/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete account/i })).not.toBeInTheDocument()
  })
})
