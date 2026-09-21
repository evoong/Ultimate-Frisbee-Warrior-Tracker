import { isPastGame } from './gameOrder'

export type BestGameStat = {
  game_id: number
  opponent: string
  game_date: string
  game_time: string | null
  game_type: string
  season_id: number | null
  in: boolean
  goals: string
  assists: string
  turnovers: string
}

export function bestGame(stats: BestGameStat[]): BestGameStat | null {
  const pastGames = stats.filter(g => g.in && isPastGame(g))
  if (pastGames.length === 0) return null

  return pastGames.reduce((best, current) => {
    const currentGoals = parseInt(current.goals)
    const bestGoals = parseInt(best.goals)
    const currentPoints = currentGoals + parseInt(current.assists)
    const bestPoints = bestGoals + parseInt(best.assists)

    if (currentGoals > bestGoals) return current
    if (currentGoals === bestGoals && currentPoints > bestPoints) return current
    if (currentGoals === bestGoals && currentPoints === bestPoints) {
      return new Date(current.game_date) > new Date(best.game_date) ? current : best
    }
    return best
  })
}
