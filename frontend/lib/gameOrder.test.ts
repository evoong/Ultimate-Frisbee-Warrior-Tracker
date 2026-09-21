import { describe, expect, it } from 'vitest'
import { isWithinLivePollWindow } from './gameOrder'

describe('isWithinLivePollWindow', () => {
  it('polls for an upcoming game', () => {
    const game = { game_date: '2026-09-21', game_time: '19:00:00' }
    const now = new Date('2026-09-21T18:00:00').getTime()
    expect(isWithinLivePollWindow(game, now)).toBe(true)
  })

  it('polls during the game and up to 5 hours after start', () => {
    const game = { game_date: '2026-09-21', game_time: '19:00:00' }
    const during = new Date('2026-09-21T20:30:00').getTime()
    const after = new Date('2026-09-21T23:59:00').getTime()
    expect(isWithinLivePollWindow(game, during)).toBe(true)
    expect(isWithinLivePollWindow(game, after)).toBe(true)
  })

  it('stops polling past 5 hours after start', () => {
    const game = { game_date: '2026-09-21', game_time: '19:00:00' }
    const past = new Date('2026-09-22T01:00:01').getTime()
    expect(isWithinLivePollWindow(game, past)).toBe(false)
  })
})
