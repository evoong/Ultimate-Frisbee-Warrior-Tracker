import { describe, expect, it } from 'vitest'
import { authenticatedStorageUrl } from './storageUrl'

describe('authenticatedStorageUrl', () => {
  it('builds a domain-relative authenticated URL for a player photo object', () => {
    expect(authenticatedStorageUrl('player-photos', '7/42.jpg')).toBe(
      '/db/storage/v1/object/authenticated/player-photos/7/42.jpg'
    )
  })

  it('builds a domain-relative authenticated URL for a team photo object', () => {
    expect(authenticatedStorageUrl('team-photos', '1/logo.jpg')).toBe(
      '/db/storage/v1/object/authenticated/team-photos/1/logo.jpg'
    )
  })

  it('normalizes leading slashes from storage object paths', () => {
    expect(authenticatedStorageUrl('player-photos', '/7/42.jpg')).toBe(
      '/db/storage/v1/object/authenticated/player-photos/7/42.jpg'
    )
  })

  it('returns no URL for an empty storage object path', () => {
    expect(authenticatedStorageUrl('player-photos', '')).toBe('')
  })
})
