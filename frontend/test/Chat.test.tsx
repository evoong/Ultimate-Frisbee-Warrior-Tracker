import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Chat from '../pages/Chat'

const mockAuth = vi.hoisted(() => ({
  can: { record: true, manageTeam: true, manageRoles: false },
  currentTeamId: 1,
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockAuth,
}))

const fetchMock = vi.hoisted(() => vi.fn())

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

function historyReply(body: unknown) {
  return (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return Promise.resolve(jsonResponse(200, { ok: true }))
    return Promise.resolve(jsonResponse(200, body))
  }
}

const ACTION = { id: 'act-1', request_id: 'req-1', description: 'Created Goal for Maya', status: 'applied' }

async function renderChat(history: unknown) {
  fetchMock.mockImplementation(historyReply(history))
  render(<Chat />)
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
}

describe('Chat action receipts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    localStorage.clear()
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('renders messages from the legacy bare-array history shape', async () => {
    await renderChat([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello there' }])
    await waitFor(() => expect(screen.getByText('hello there')).toBeInTheDocument())
    expect(screen.queryByText('Recent actions')).not.toBeInTheDocument()
  })

  it('renders messages and action cards from the new object history shape', async () => {
    await renderChat({ messages: [{ role: 'assistant', content: 'Goal added' }], actions: [ACTION] })
    await waitFor(() => {
      expect(screen.getByText('Goal added')).toBeInTheDocument()
      expect(screen.getByText('Created Goal for Maya')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument()
  })

  it('flips a card to Undone after a successful undo POST', async () => {
    await renderChat({ messages: [{ role: 'assistant', content: 'Goal added' }], actions: [ACTION] })
    await waitFor(() => expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument())

    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ action_id: 'act-1', organization_id: 1 })
      return Promise.resolve(jsonResponse(200, { ok: true, action: { id: 'act-1', status: 'undone' } }))
    })
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))

    await waitFor(() => expect(screen.getByText(/undone/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument()
  })

  it('keeps an applied card and shows the server error on a 409 conflict', async () => {
    await renderChat({ messages: [{ role: 'assistant', content: 'Goal added' }], actions: [ACTION] })
    await waitFor(() => expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument())

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(409, { error: 'action cannot be undone: the affected data has changed' }))
    )
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))

    await waitFor(() => expect(screen.getByText('action cannot be undone: the affected data has changed')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument()
  })

  it('shows a generic error on other undo failures', async () => {
    await renderChat({ messages: [{ role: 'assistant', content: 'Goal added' }], actions: [ACTION] })
    await waitFor(() => expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument())

    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(403, { error: 'forbidden' })))
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))

    await waitFor(() => expect(screen.getByText('Undo failed — try again.')).toBeInTheDocument())
  })

  it('renders the recovery section with a working Undo when history is cleared but receipts remain', async () => {
    await renderChat({ messages: [], actions: [ACTION] })
    await waitFor(() => {
      expect(screen.getByText('Recent actions')).toBeInTheDocument()
      expect(screen.getByText('Created Goal for Maya')).toBeInTheDocument()
    })
    expect(screen.getByText(/Ask me anything about the team/i)).toBeInTheDocument()

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(200, { ok: true, action: { id: 'act-1', status: 'undone' } }))
    )
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))

    await waitFor(() => expect(screen.getByText(/undone/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument()
  })

  it('keeps message-attached receipts undoable after clearing history', async () => {
    await renderChat({ messages: [], actions: [] })
    await waitFor(() => expect(screen.getByText(/Ask me anything about the team/i)).toBeInTheDocument())

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(200, {
        reply: 'Goal added',
        actions: [{ id: 'act-2', request_id: 'req-2', description: 'Created Goal for Sam', status: 'applied' }],
      }))
    )
    const box = screen.getByPlaceholderText('Ask about stats, players, games…')
    fireEvent.change(box, { target: { value: 'add a goal' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => expect(screen.getByText('Created Goal for Sam')).toBeInTheDocument())

    fetchMock.mockImplementation(historyReply({ messages: [], actions: [] }))
    fireEvent.click(screen.getByRole('button', { name: /clear chat/i }))
    await waitFor(() => expect(screen.getByText('Clear chat history')).toBeInTheDocument())
    const clearButtons = screen.getAllByRole('button', { name: 'Clear chat' })
    fireEvent.click(clearButtons[clearButtons.length - 1])

    await waitFor(() => expect(screen.getByText('Recent actions')).toBeInTheDocument())
    expect(screen.getByText('Created Goal for Sam')).toBeInTheDocument()

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(200, { ok: true, action: { id: 'act-2', status: 'undone' } }))
    )
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))
    await waitFor(() => expect(screen.getByText(/undone/i)).toBeInTheDocument())
  })
})
