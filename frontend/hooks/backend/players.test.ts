import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const upload = vi.fn().mockResolvedValue({ data: { path: '7/42.jpg' }, error: null })
const select = vi.fn().mockResolvedValue({ data: [{ photo_url: '' }], error: null })
const eq = vi.fn(() => ({ select }))
const update = vi.fn(() => ({ eq }))

vi.mock('../../lib/supabase', () => ({
  supabase: {
    storage: { from: vi.fn(() => ({ upload })) },
    from: vi.fn(() => ({ update })),
  },
}))

import { useUploadPlayerPhoto } from './players'

describe('useUploadPlayerPhoto', () => {
  it('stores an authenticated same-origin URL for a private player photo', async () => {
    const { result } = renderHook(() => useUploadPlayerPhoto())
    const file = new File(['photo'], 'portrait.jpg', { type: 'image/jpeg' })

    await act(async () => {
      await result.current.trigger({ teamId: 7, playerId: 42, file })
    })

    expect(update).toHaveBeenCalledWith({
      photo_url: '/db/storage/v1/object/authenticated/player-photos/7/42.jpg',
    })
  })
})
