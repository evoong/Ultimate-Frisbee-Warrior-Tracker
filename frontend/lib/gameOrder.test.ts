import { describe, expect, it } from 'vitest'
import { isWithinLivePollWindow, isActualGame } from './gameOrder'

describe('isActualGame', () => {
  it('returns true during the actual game window (kickoff - 5m to +90m)', () => {
    const game = { game_date: '2026-09-21', game_time: '19:00:00' }
    const justBefore = new Date('2026-09-21T18:56:00').getTime()
    const midGame = new Date('2026-09-21T19:45:00').getTime()
    const nearEnd = new Date('2026-09-21T20:29:00').getTime()

    expect(isActualGame(game, justBefore)).toBe(true)
    expect(isActualGame(game, midGame)).toBe(true)
    expect(isActualGame(game, nearEnd)).toBe(true)
  })

  it('returns false well before game start', () => {
    const game = { game_date: '2026-09-21', game_time: '19:00:00' }
    const hoursBefore = new Date('2026-09-21T15:00:00').getTime()
    expect(isActualGame(game, hoursBefore)).toBe(false)
  })

  it('returns false after game has concluded (>90m)', () => {
    const game = { game_date: '2026-09-21', game_time: '19:00:00' }
    const hoursAfter = new Date('2026-09-21T20:31:00').getTime()
    expect(isActualGame(game, hoursAfter)).toBe(false)
  })
})

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
