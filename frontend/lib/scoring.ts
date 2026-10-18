export const GOAL_POINTS = 500
export const ASSIST_POINTS = 500
export const SECOND_ASSIST_POINTS = 250
export const DEFENSE_POINTS = 500

export type PlayerStatCounts = {
  goals: number
  assists: number
  secondAssists?: number
  blocks?: number
}

/**
 * Calculates total points for a player or team given event counts.
 * SC: Goal (+500)
 * AS: Assist (+500)
 * 2ND: Second Assist (+250)
 * DEF: Block/Defensive play (+500)
 */
export function calculatePoints(stats: PlayerStatCounts): number {
  const goalsPts = (stats.goals || 0) * GOAL_POINTS
  const assistsPts = (stats.assists || 0) * ASSIST_POINTS
  const secondAssistsPts = (stats.secondAssists || 0) * SECOND_ASSIST_POINTS
  const blocksPts = (stats.blocks || 0) * DEFENSE_POINTS
  return goalsPts + assistsPts + secondAssistsPts + blocksPts
}
