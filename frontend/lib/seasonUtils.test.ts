import { describe, it, expect } from 'vitest'
import { getDefaultSeasonForPlayer } from './seasonUtils'

describe('getDefaultSeasonForPlayer', () => {
  const seasons = [
    { id: 1, organizer: 'Jam', start_date: '2026-05-01', end_date: '2026-08-31' }, // ended
    { id: 2, organizer: 'Jam', start_date: '2026-09-01', end_date: '2026-12-31' }, // active
    { id: 3, organizer: 'Jam', start_date: '2027-01-01', end_date: '2027-04-30' }, // upcoming
    { id: 4, organizer: 'Other', start_date: '2026-09-01', end_date: '2026-12-31' }, // active other
  ]

  it('picks active season the player is part of', () => {
    // Player is in season 1 and 2
    const result = getDefaultSeasonForPlayer(seasons, [1, 2], 999)
    expect(result).toBe(2)
  })

  it('picks upcoming season if player has no active seasons but has upcoming', () => {
    // Player is in season 1 and 3
    const result = getDefaultSeasonForPlayer(seasons, [1, 3], 999)
    // Between ended 1 and upcoming 3, active > upcoming > ended
    expect(result).toBe(3)
  })

  it('picks most recently ended season if player only has ended seasons', () => {
    const pastSeasons = [
      { id: 10, organizer: 'Jam', start_date: '2025-01-01', end_date: '2025-04-30' },
      { id: 11, organizer: 'Jam', start_date: '2025-05-01', end_date: '2025-08-31' },
    ]
    const result = getDefaultSeasonForPlayer([...seasons, ...pastSeasons], [10, 11], 999)
    expect(result).toBe(11)
  })

  it('ignores seasons outside player roster', () => {
    expect(getDefaultSeasonForPlayer(seasons, [1], 999)).toBe(1)
  })

  it('falls back to default jam season if player has no seasons or empty array', () => {
    const result = getDefaultSeasonForPlayer(seasons, [], 999)
    // Season 2 is active Jam season
    expect(result).toBe(2)
  })

  it('falls back to default jam season if playerSeasonIds is null or undefined', () => {
    expect(getDefaultSeasonForPlayer(seasons, null, 999)).toBe(2)
    expect(getDefaultSeasonForPlayer(seasons, undefined, 999)).toBe(2)
  })

  it('picks active non-Jam season over player upcoming Jam season', () => {
    expect(getDefaultSeasonForPlayer(seasons, [1, 3, 4], 999)).toBe(4)
  })
})
