import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ActionCard, type ChatProposal } from './ActionCard'

const proposal: ChatProposal = {
  id: 'p1',
  tool_name: 'create_lineup',
  args: { groups: [{ name: 'O-Line', players: [{ playerName: 'Alice' }, { playerName: 'Bob', role: 'Cutter' }] }] },
  summary: "Set the lineup for the 2026-09-29 game vs Rival A: O-Line (Alice, Bob)",
}

describe('ActionCard', () => {
  it('pending shows the server summary, the args detail, and Confirm/Cancel', () => {
    render(<ActionCard proposal={proposal} status="pending" onConfirm={() => {}} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText(proposal.summary)).toBeInTheDocument()
    expect(screen.getByText('O-Line:')).toBeInTheDocument()
    // The detail line's exact player list — distinct from the summary text.
    expect(screen.getByText('Alice, Bob (Cutter)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument()
  })

  it('confirming disables the buttons', () => {
    render(<ActionCard proposal={proposal} status="confirming" onConfirm={() => {}} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled()
  })

  it('done shows the outcome and a Dismiss button, no Confirm', () => {
    render(<ActionCard proposal={proposal} status="done" outcome="Confirmed — the change has been applied." onConfirm={() => {}} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('Confirmed — the change has been applied.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  })

  it('error keeps Confirm enabled for a retry and shows the error', () => {
    const onConfirm = vi.fn()
    render(<ActionCard proposal={proposal} status="error" outcome="Failed to reach the server. Try again." onConfirm={onConfirm} onCancel={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('Failed to reach the server. Try again.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('cancel fires onCancel', () => {
    const onCancel = vi.fn()
    render(<ActionCard proposal={proposal} status="pending" onConfirm={() => {}} onCancel={onCancel} onDismiss={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
