import { describe, expect, it } from 'vitest'
import { shouldShowEventsLoading } from './eventLoading'

describe('shouldShowEventsLoading', () => {
  it('keeps loaded events visible during a background refresh', () => {
    expect(shouldShowEventsLoading(true, [{ id: 1 }])).toBe(false)
  })

  it('shows loading only before first event response', () => {
    expect(shouldShowEventsLoading(true, undefined)).toBe(true)
  })
})
