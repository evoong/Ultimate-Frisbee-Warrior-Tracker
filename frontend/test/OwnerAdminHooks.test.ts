import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTransferCaptainship, useDeleteTeam } from '../hooks/backend/teams'

const mockRpc = vi.fn()
const mockFrom = vi.fn()

vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: any[]) => mockRpc(...args),
    from: (...args: any[]) => mockFrom(...args),
  },
}))

describe('Owner admin hooks', () => {
  it('useTransferCaptainship calls transfer_captainship RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null })
    const { result } = renderHook(() => useTransferCaptainship())

    let res
    await act(async () => {
      res = await result.current.trigger({ teamId: 42, newCaptainUserId: 'u-123' })
    })

    expect(mockRpc).toHaveBeenCalledWith('transfer_captainship', {
      p_team_id: 42,
      p_new_captain_id: 'u-123',
    })
    expect(res).toBe(true)
  })

  it('useDeleteTeam calls supabase DELETE on organizations', async () => {
    const mockDelete = vi.fn().mockReturnThis()
    const mockEq = vi.fn().mockResolvedValueOnce({ error: null })
    mockFrom.mockReturnValueOnce({
      delete: mockDelete,
    })
    mockDelete.mockReturnValueOnce({
      eq: mockEq,
    })

    const { result } = renderHook(() => useDeleteTeam())

    let res
    await act(async () => {
      res = await result.current.trigger({ teamId: 42 })
    })

    expect(mockFrom).toHaveBeenCalledWith('organizations')
    expect(mockDelete).toHaveBeenCalled()
    expect(mockEq).toHaveBeenCalledWith('id', 42)
    expect(res).toBe(true)
  })
})
