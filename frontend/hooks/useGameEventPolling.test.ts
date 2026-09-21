import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGameEventPolling } from './useGameEventPolling'

describe('useGameEventPolling', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('refreshes active game events every two seconds while visible', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()

    renderHook(() => useGameEventPolling(81, refresh))

    act(() => vi.advanceTimersByTime(2_000))

    expect(refresh).toHaveBeenCalledExactlyOnceWith({ gameId: 81 })
  })

  it('skips refreshes while document is hidden', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)

    renderHook(() => useGameEventPolling(81, refresh))

    act(() => vi.advanceTimersByTime(2_000))

    expect(refresh).not.toHaveBeenCalled()
  })

  it('stops when game detail closes', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const { rerender } = renderHook(({ gameId }) => useGameEventPolling(gameId, refresh), {
      initialProps: { gameId: 81 as number | null },
    })

    rerender({ gameId: null })
    act(() => vi.advanceTimersByTime(2_000))

    expect(refresh).not.toHaveBeenCalled()
  })
})
