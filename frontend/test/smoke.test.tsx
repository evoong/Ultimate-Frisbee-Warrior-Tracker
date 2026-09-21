import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

describe('test harness', () => {
  it('renders a React 19 component into jsdom', () => {
    render(<p>hello</p>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('answers the reduced-motion query', () => {
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false)
  })
})
