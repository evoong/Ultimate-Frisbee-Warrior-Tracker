type RosterPlayer = { id: number; is_sub: boolean }

export function orderRosterPlayers<T extends RosterPlayer>(players: T[], linkedPlayerId: number | null | undefined) {
  return [...players].sort((a, b) => {
    if (a.id === linkedPlayerId) return -1
    if (b.id === linkedPlayerId) return 1
    return Number(a.is_sub) - Number(b.is_sub)
  })
}
