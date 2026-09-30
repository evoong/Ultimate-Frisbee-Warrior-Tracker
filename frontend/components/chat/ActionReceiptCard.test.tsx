import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ActionReceiptCard from './ActionReceiptCard'

const APPLIED = { id: '1', description: 'Created Goal', status: 'applied' }

describe('ActionReceiptCard', () => {
  it('renders description and Undo button when applied', () => {
    const onUndo = vi.fn()
    render(<ActionReceiptCard action={APPLIED} canUndo onUndo={onUndo} />)
    expect(screen.getByText('Created Goal')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument()
  })

  it('renders Undone label without button when status is undone', () => {
    render(<ActionReceiptCard action={{ id: '1', description: 'Created Goal', status: 'undone' }} canUndo onUndo={() => {}} />)
    expect(screen.getByText(/undone/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument()
  })

  it('hides the Undo button when canUndo is false', () => {
    render(<ActionReceiptCard action={APPLIED} canUndo={false} onUndo={() => {}} />)
    expect(screen.getByText('Created Goal')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /undo/i })).not.toBeInTheDocument()
  })

  it('disables the button and shows a spinner while pending', () => {
    render(<ActionReceiptCard action={APPLIED} canUndo pending onUndo={() => {}} />)
    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button.querySelector('.animate-spin')).not.toBeNull()
  })

  it('renders the error text inside the card', () => {
    render(<ActionReceiptCard action={APPLIED} canUndo error="This change can't be undone" onUndo={() => {}} />)
    expect(screen.getByText("This change can't be undone")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument()
  })

  it('calls onUndo with the action id on click', () => {
    const onUndo = vi.fn()
    render(<ActionReceiptCard action={APPLIED} canUndo onUndo={onUndo} />)
    screen.getByRole('button', { name: /undo/i }).click()
    expect(onUndo).toHaveBeenCalledWith('1')
  })
})
