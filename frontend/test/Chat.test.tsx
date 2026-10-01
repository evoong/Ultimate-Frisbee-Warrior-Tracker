import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Chat from '../pages/Chat'

const mockAuth = vi.hoisted(() => ({
  can: { record: true, manageTeam: true, manageRoles: false },
  currentTeamId: 1,
  role: 'editor' as string | null,
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
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('flips a card to Undone after a successful undo POST', async () => {
    await renderChat({ messages: [{ role: 'assistant', content: 'Goal added' }], actions: [ACTION] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument())

    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ action_id: 'act-1', organization_id: 1 })
      return Promise.resolve(jsonResponse(200, { ok: true, action: { id: 'act-1', status: 'undone' } }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    await waitFor(() => expect(screen.getByText(/undone/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('keeps an applied card and shows the server error on a 409 conflict', async () => {
    await renderChat({ messages: [{ role: 'assistant', content: 'Goal added' }], actions: [ACTION] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument())

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(409, { error: 'action cannot be undone: the affected data has changed' }))
    )
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    await waitFor(() => expect(screen.getByText('action cannot be undone: the affected data has changed')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('shows a generic error on other undo failures', async () => {
    await renderChat({ messages: [{ role: 'assistant', content: 'Goal added' }], actions: [ACTION] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument())

    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse(403, { error: 'forbidden' })))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    await waitFor(() => expect(screen.getByText(/undone/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.getByText(/undone/i)).toBeInTheDocument())
  })
})

describe('Chat inline proposal cards', () => {
  const PROPOSAL = {
    id: 'prop-1',
    tool_name: 'add_to_lineup',
    args: { playerName: 'Maya', lineupGroupName: 'Line 1' },
    summary: 'Place Maya in Line 1 for the game',
  }
  const RECEIPT = { id: 'act-9', request_id: 'req-9', description: 'Added Maya to Line 1 lineup', status: 'applied' }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    localStorage.clear()
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => vi.unstubAllGlobals())

  async function renderEmptyChat() {
    fetchMock.mockImplementation(historyReply({ messages: [], actions: [] }))
    const view = render(<Chat />)
    await waitFor(() => expect(screen.getByText(/Ask me anything about the team/i)).toBeInTheDocument())
    return view
  }

  function sendProposalReply() {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(200, { reply: 'Wah gwaan — mi can put Maya pon Line 1.', proposal: PROPOSAL }))
    )
    const box = screen.getByPlaceholderText('Ask about stats, players, games…')
    fireEvent.change(box, { target: { value: 'put maya on line 1' } })
    fireEvent.keyDown(box, { key: 'Enter' })
  }

  it('attaches the proposal card inline with the assistant reply, not above the input', async () => {
    const view = await renderEmptyChat()
    sendProposalReply()

    await waitFor(() => expect(screen.getByText(PROPOSAL.summary)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument()
    // Inline placement: the card lives inside the scrollable message list,
    // not in the input block below it.
    const card = screen.getByText(PROPOSAL.summary).closest('[class*="overflow-y-auto"]')
    expect(card).not.toBeNull()
  })

  it('Approve posts to /api/chat/confirm and settles with the receipt surfaced', async () => {
    await renderEmptyChat()
    sendProposalReply()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument())

    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      expect(url).toBe('/api/chat/confirm')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body))
      expect(body.proposal_id).toBe('prop-1')
      expect(body.organization_id).toBe(1)
      return Promise.resolve(jsonResponse(200, { result: { ok: true }, receipt: RECEIPT }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(screen.getByText('Confirmed — the change has been applied.')).toBeInTheDocument())
    expect(screen.getByText(RECEIPT.description)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('Decline settles the card without any confirm request', async () => {
    await renderEmptyChat()
    sendProposalReply()
    await waitFor(() => expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument())

    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /decline/i }))

    await waitFor(() => expect(screen.getByText('Declined — nothing was changed.')).toBeInTheDocument())
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })

  it('settles with the server error on a terminal confirm failure (410 expired)', async () => {
    await renderEmptyChat()
    sendProposalReply()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument())

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(410, { error: 'this proposal expired — ask the assistant again' }))
    )
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(screen.getByText('this proposal expired — ask the assistant again')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('discards pending proposal cards when the team changes', async () => {
    const view = await renderEmptyChat()
    sendProposalReply()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument())

    mockAuth.currentTeamId = 2
    view.rerender(<Chat />)

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument())
    expect(screen.queryByText(PROPOSAL.summary)).not.toBeInTheDocument()
    // The switch also refetches the new team's history (empty here), so the
    // prior team's reply goes with its card — nothing lingers cross-team.
    await waitFor(() => expect(screen.getByText(/Ask me anything about the team/i)).toBeInTheDocument())
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('organization_id=2'))).toBe(true)
  })
})


describe('Chat auto-approve toggle', () => {
  const PROPOSAL = {
    id: 'prop-auto-1',
    tool_name: 'add_to_lineup',
    args: { playerName: 'Maya', lineupGroupName: 'Line 1' },
    summary: 'Place Maya in Line 1 for the game',
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    localStorage.clear()
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => vi.unstubAllGlobals())

  async function renderEmptyChat() {
    fetchMock.mockImplementation(historyReply({ messages: [], actions: [] }))
    const view = render(<Chat />)
    await waitFor(() => expect(screen.getByText(/Ask me anything about the team/i)).toBeInTheDocument())
    return view
  }

  function sendProposalReply() {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(jsonResponse(200, { reply: 'Mi put Maya pon Line 1 now.', proposal: PROPOSAL }))
    )
    const box = screen.getByPlaceholderText('Ask about stats, players, games…')
    fireEvent.change(box, { target: { value: 'put maya on line 1' } })
    fireEvent.keyDown(box, { key: 'Enter' })
  }

  it('shows the toggle to an editor and reflects the persisted choice', async () => {
    localStorage.setItem('ufwt_chat_auto_approve', '1')
    await renderEmptyChat()
    const toggle = screen.getByRole('button', { name: /auto-approve/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem('ufwt_chat_auto_approve')).toBe('0')
  })

  it('hides the toggle from members', async () => {
    mockAuth.role = 'member'
    try {
      await renderEmptyChat()
      expect(screen.queryByRole('button', { name: /auto-approve/i })).not.toBeInTheDocument()
    } finally {
      mockAuth.role = 'editor'
    }
  })

  it('confirms an arriving proposal automatically when the toggle is on', async () => {
    localStorage.setItem('ufwt_chat_auto_approve', '1')
    await renderEmptyChat()
    sendProposalReply()

    fetchMock.mockImplementationOnce((url: string, init?: RequestInit) => {
      expect(url).toBe('/api/chat/confirm')
      expect(JSON.parse(String(init?.body)).proposal_id).toBe('prop-auto-1')
      return Promise.resolve(jsonResponse(200, { result: { ok: true }, receipt: null }))
    })

    await waitFor(() => expect(screen.getByText('Confirmed — the change has been applied.')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('waits for a manual Approve when the toggle is off (default)', async () => {
    await renderEmptyChat()
    sendProposalReply()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument())
    // No confirm request fired yet — the fetches so far are history + chat only.
    const confirmCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/chat/confirm'))
    expect(confirmCalls).toHaveLength(0)
  })

  it('a freshly-toggled-on switch does not confirm a card that already settled as declined', async () => {
    await renderEmptyChat()
    sendProposalReply()
    await waitFor(() => expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /decline/i }))
    await waitFor(() => expect(screen.getByText('Declined — nothing was changed.')).toBeInTheDocument())

    const toggle = screen.getByRole('button', { name: /auto-approve/i })
    fireEvent.click(toggle) // turn on after the fact

    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('Declined — nothing was changed.')).toBeInTheDocument()
    const confirmCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/chat/confirm'))
    expect(confirmCalls).toHaveLength(0)
  })
})
