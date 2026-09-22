import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PricingCards } from './PricingCards'

describe('PricingCards', () => {
  it('renders plans and selects an available tier', () => {
    const onSelectTier = vi.fn()

    render(<PricingCards currentTier="free" onSelectTier={onSelectTier} />)

    expect(screen.getByRole('heading', { name: 'Free' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Plus' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Premium' })).toBeInTheDocument()
    expect(screen.getByText('Most Popular')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Current Plan' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Select Plus' }))

    expect(onSelectTier).toHaveBeenCalledWith('plus')
  })
})
