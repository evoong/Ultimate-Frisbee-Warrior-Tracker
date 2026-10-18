import { isPastGame } from './gameOrder'

export type BestGameStat = {
  game_id: number
  opponent: string
  game_date: string
  game_time: string | null
  game_type: string
  season_id: number | null
  in: boolean
  points?: number
  goals: string
  assists: string
  secondAssists?: number
  blocks?: number
}

export function bestGame(stats: BestGameStat[]): BestGameStat | null {
  const pastGames = stats.filter(g => g.in && isPastGame(g))
  if (pastGames.length === 0) return null

  return pastGames.reduce((best, current) => {
    const currentWarriorPts = current.points ?? (parseInt(current.goals) * 500 + parseInt(current.assists) * 500 + (current.secondAssists ?? 0) * 250 + (current.blocks ?? 0) * 500)
    const bestWarriorPts = best.points ?? (parseInt(best.goals) * 500 + parseInt(best.assists) * 500 + (best.secondAssists ?? 0) * 250 + (best.blocks ?? 0) * 500)

    if (currentWarriorPts > bestWarriorPts) return current
    if (currentWarriorPts === bestWarriorPts) {
      const currentGoals = parseInt(current.goals)
      const bestGoals = parseInt(best.goals)
      if (currentGoals > bestGoals) return current
      if (currentGoals === bestGoals) {
        return new Date(current.game_date) > new Date(best.game_date) ? current : best
      }
    }
    return best
  })
}
