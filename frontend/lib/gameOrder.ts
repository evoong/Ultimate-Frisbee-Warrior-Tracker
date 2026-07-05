export type GameLike = { game_date: string; game_time: string | null }

// A game counts as "past" once its actual start time has passed, not just
// its calendar date, so a game happening later today still shows as upcoming.
function gameStartsAt(g: GameLike): Date {
  return new Date(`${g.game_date}T${g.game_time || '00:00:00'}`)
}

// Next upcoming game first (soonest first), then past games most-recent-first
// so the last result is always the first thing you see in that group. Shared
// by Schedule (the canonical ordering) and anywhere else a game list should
// match it, e.g. the Strategy page's game-assignment picker.
export function sortGamesUpcomingFirst<T extends GameLike>(games: T[], now: Date = new Date()): T[] {
  const upcoming = games.filter(g => gameStartsAt(g) >= now).sort((a, b) => gameStartsAt(a).getTime() - gameStartsAt(b).getTime())
  const past = games.filter(g => gameStartsAt(g) < now).sort((a, b) => gameStartsAt(b).getTime() - gameStartsAt(a).getTime())
  return [...upcoming, ...past]
}
