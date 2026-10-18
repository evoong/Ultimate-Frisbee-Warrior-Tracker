import { describe, it, expect } from 'vitest'
import { calculatePoints, GOAL_POINTS, ASSIST_POINTS, SECOND_ASSIST_POINTS, DEFENSE_POINTS } from './scoring'

describe('scoring point calculation', () => {
  it('correctly values events according to spec', () => {
    expect(GOAL_POINTS).toBe(500)
    expect(ASSIST_POINTS).toBe(500)
    expect(SECOND_ASSIST_POINTS).toBe(250)
    expect(DEFENSE_POINTS).toBe(500)
  })

  it('calculates total points for a mix of events', () => {
    // 2 goals (1000) + 1 assist (500) + 2 2nd assists (500) + 1 block (500) = 2500
    const points = calculatePoints({
      goals: 2,
      assists: 1,
      secondAssists: 2,
      blocks: 1,
    })
    expect(points).toBe(2500)
  })

  it('handles empty / zero events', () => {
    expect(calculatePoints({ goals: 0, assists: 0 })).toBe(0)
  })
})
