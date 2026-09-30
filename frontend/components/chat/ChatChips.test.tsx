import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatChips } from './ChatChips'

describe('ChatChips', () => {
  it('shows read chips to a member and hides write chips', () => {
    const onSend = vi.fn()
    render(<ChatChips role="member" onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'View lineup' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved lineups' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Build lineup' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Log event' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo event' })).not.toBeInTheDocument()
  })

  it('shows every chip to an editor and sends preset messages', () => {
    const onSend = vi.fn()
    render(<ChatChips role="editor" onSend={onSend} />)
    fireEvent.click(screen.getByRole('button', { name: 'View lineup' }))
    expect(onSend).toHaveBeenCalledWith('Show me the current lineup')
    fireEvent.click(screen.getByRole('button', { name: 'Build lineup' }))
    expect(onSend).toHaveBeenCalledWith('Help me build a lineup for the next game')
    fireEvent.click(screen.getByRole('button', { name: 'Undo event' }))
    expect(onSend).toHaveBeenCalledWith('Undo the last event')
  })

  it('renders nothing when hidden or unauthenticated', () => {
    const { container } = render(<ChatChips role="editor" onSend={() => {}} hidden />)
    expect(container).toBeEmptyDOMElement()
    const { container: c2 } = render(<ChatChips role={null} onSend={() => {}} />)
    expect(c2).toBeEmptyDOMElement()
  })
})
