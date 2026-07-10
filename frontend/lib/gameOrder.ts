import { todayLocalStr } from './seasonUtils'

export type GameLike = { game_date: string; game_time: string | null }

// Ordering within a day (soonest first for upcoming, most-recent first for
// past) still uses the actual start time; only the upcoming/past split
// below is date-only.
function gameStartsAt(g: GameLike): Date {
  return new Date(`${g.game_date}T${g.game_time || '00:00:00'}`)
}

// A game counts as "past" only once its calendar date has passed, not the
// moment its start time does — otherwise a game in progress right now
// (start time reached, not yet over) slides into "Played" mid-game, and
// the next upcoming game silently becomes the one you're about to score
// against instead. Whole-day granularity is deliberately coarse: it's
// wrong for a handful of hours right after a game ends, but that's far
// safer than moving a live game out from under you.
export function isPastGame(g: GameLike, today: string = todayLocalStr()): boolean {
  return g.game_date < today
}

// Next upcoming game first (soonest first), then past games most-recent-first
// so the last result is always the first thing you see in that group. Shared
// by Schedule (the canonical ordering) and anywhere else a game list should
// match it, e.g. the Strategy page's game-assignment picker.
export function sortGamesUpcomingFirst<T extends GameLike>(games: T[], today: string = todayLocalStr()): T[] {
  const upcoming = games.filter(g => !isPastGame(g, today)).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime())
  const past = games.filter(g => isPastGame(g, today)).sort((a, b) => gameStartsAt(b).getTime() - gameStartsAt(a).getTime())
  return [...upcoming, ...past]
}
