import { describe, it, expect } from 'vitest'

// Minimal sort and rank logic extracted from useGetPlayerStats for direct unit testing
function sortAndRankPlayers(stats: Array<{ id: string; points: number; goals: number; games_played: number }>, mode: 'row' | 'standard' | 'dense' = 'standard') {
  const result = stats.map(s => ({ ...s, ga_rank: 0 }))

  result.sort((a, b) => {
    const pointsDiff = b.points - a.points
    if (pointsDiff !== 0) return pointsDiff
    
    const goalsDiff = b.goals - a.goals
    if (goalsDiff !== 0) return goalsDiff
    
    const aRate = a.games_played > 0 ? a.points / a.games_played : 0
    const bRate = b.games_played > 0 ? b.points / b.games_played : 0
    return bRate - aRate
  })

  let rank = 0
  result.forEach((s, i) => {
    if (mode === 'row') {
      s.ga_rank = i + 1
    } else if (mode === 'standard') {
      if (i > 0 && s.points === result[i-1].points && s.goals === result[i-1].goals) {
        s.ga_rank = result[i-1].ga_rank
      } else {
        s.ga_rank = i + 1
      }
    } else {
      if (i === 0) rank = 1
      else if (s.points !== result[i-1].points || s.goals !== result[i-1].goals) {
        rank++
      }
      s.ga_rank = rank
    }
  })

  return result
}

describe('Player Ranking Sort Logic', () => {
  it('sorts by total points descending', () => {
    const players = [
      { id: 'p1', points: 1000, goals: 1, games_played: 1 },
      { id: 'p2', points: 2500, goals: 2, games_played: 1 },
      { id: 'p3', points: 1500, goals: 3, games_played: 1 },
    ]
    const ranked = sortAndRankPlayers(players)
    expect(ranked.map(p => p.id)).toEqual(['p2', 'p3', 'p1'])
    expect(ranked.map(p => p.ga_rank)).toEqual([1, 2, 3])
  })

  it('uses goals (SC) as tie-breaker when points are equal', () => {
    const players = [
      { id: 'p1', points: 1500, goals: 1, games_played: 1 }, // e.g. 1 Goal (500) + 2 Assists (1000) = 1500 pts
      { id: 'p2', points: 1500, goals: 3, games_played: 1 }, // e.g. 3 Goals (1500) = 1500 pts
      { id: 'p3', points: 1500, goals: 2, games_played: 1 }, // e.g. 2 Goals (1000) + 1 Assist (500) = 1500 pts
    ]
    const ranked = sortAndRankPlayers(players)
    expect(ranked.map(p => p.id)).toEqual(['p2', 'p3', 'p1'])
    expect(ranked.map(p => p.ga_rank)).toEqual([1, 2, 3])
  })

  it('assigns same rank when points and goals are tied in standard mode', () => {
    const players = [
      { id: 'p1', points: 2000, goals: 2, games_played: 1 },
      { id: 'p2', points: 1500, goals: 2, games_played: 1 },
      { id: 'p3', points: 1500, goals: 2, games_played: 1 },
      { id: 'p4', points: 1000, goals: 1, games_played: 1 },
    ]
    const ranked = sortAndRankPlayers(players, 'standard')
    expect(ranked.map(p => p.ga_rank)).toEqual([1, 2, 2, 4])
  })
})
