import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { FlagsProvider, useFlags } from './useFlags'

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mockAuth(),
}))

describe('useFlags', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockReturnValue({
      user: { id: 'usr-1' },
      currentTeamId: 3,
      isGuest: false,
      loading: false,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function wrapper({ children }: { children: ReactNode }) {
    return <FlagsProvider>{children}</FlagsProvider>
  }

  it('resolves flags for current team from fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        flags: {
          3: { show_turnovers: true },
        },
      }),
    }) as any

    const { result } = renderHook(() => useFlags(), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.flags).toEqual({ show_turnovers: true })
    })
  })

  it('falls back to default false on fetch failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any

    const { result } = renderHook(() => useFlags(), { wrapper })

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.flags).toEqual({ show_turnovers: false })
    })
  })

  it('returns false defaults pre-fetch while auth is guest', async () => {
    mockAuth.mockReturnValue({
      user: null,
      currentTeamId: null,
      isGuest: true,
      loading: false,
    })

    const { result } = renderHook(() => useFlags(), { wrapper })

    expect(result.current.loading).toBe(false)
    expect(result.current.flags).toBeNull()
  })
})
