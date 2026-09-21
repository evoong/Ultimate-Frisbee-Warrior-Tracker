import { describe, expect, it } from 'vitest'
import { bestGame, type BestGameStat } from './bestGame'

const mk = (over: Partial<BestGameStat>): BestGameStat => ({
  game_id: 1,
  opponent: 'Rivals',
  game_date: '2026-09-10',
  game_time: null,
  game_type: 'Regular',
  season_id: 1,
  in: true,
  goals: '0',
  assists: '0',
  turnovers: '0',
  ...over,
})

describe('bestGame', () => {
  it('returns the game with the most goals', () => {
    const best = bestGame([mk({ game_id: 1, goals: '2', assists: '3' }), mk({ game_id: 2, goals: '5', assists: '0' })])
    expect(best?.game_id).toBe(2)
  })

  it('breaks a goals tie by total points (goals + assists)', () => {
    const best = bestGame([mk({ game_id: 1, goals: '3', assists: '1' }), mk({ game_id: 2, goals: '3', assists: '4' })])
    expect(best?.game_id).toBe(2)
  })

  it('breaks a full tie by the most recent game', () => {
    const best = bestGame([
      mk({ game_id: 1, goals: '3', assists: '2', game_date: '2026-09-01' }),
      mk({ game_id: 2, goals: '3', assists: '2', game_date: '2026-09-15' }),
    ])
    expect(best?.game_id).toBe(2)
  })

  it('ignores games the player was not in a lineup for', () => {
    expect(bestGame([mk({ in: false, goals: '9' })])).toBeNull()
  })

  it('ignores upcoming games', () => {
    const future = new Date()
    future.setDate(future.getDate() + 7)
    const iso = future.toISOString().slice(0, 10)
    expect(bestGame([mk({ game_date: iso, goals: '9' })])).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(bestGame([])).toBeNull()
  })
})
