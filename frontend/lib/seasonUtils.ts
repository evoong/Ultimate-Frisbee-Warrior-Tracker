type SeasonLike = { id: number; organizer: string | null; start_date: string | null; end_date: string | null }

// `game_date`/`start_date`/`end_date` are plain calendar dates with no
// timezone, meant to represent the local day. `new Date().toISOString()`
// gives the UTC date, which can already be tomorrow while it's still today
// locally (e.g. evenings in North America) — that skew was misclassifying
// a game that hasn't happened yet as "already played".
export function todayLocalStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Returns the id of the most relevant Jam season:
 * 1. Currently active (today within start_date..end_date; null end_date = open-ended)
 * 2. Next upcoming (earliest future start_date)
 * 3. Most recently ended (latest past end_date)
 * Falls back to `fallbackId` if no Jam seasons exist.
 */
export function getDefaultJamSeasonId(allSeasons: SeasonLike[], fallbackId?: number): number | undefined {
  const today = todayLocalStr()
  const jam = allSeasons.filter(s => s.organizer === 'Jam')
  const active = jam.find(s => s.start_date && s.start_date <= today && (s.end_date == null || today <= s.end_date))
  const upcoming = jam.filter(s => s.start_date && s.start_date > today).sort((a, b) => a.start_date!.localeCompare(b.start_date!))[0]
  const ended = jam.filter(s => s.end_date && s.end_date < today).sort((a, b) => b.end_date!.localeCompare(a.end_date!))[0]
  return (active ?? upcoming ?? ended)?.id ?? fallbackId
}

type GameLike = { season_id: number | null; game_date: string }

/**
 * Returns the id of the most recent Jam season that has at least one game
 * with a game_date on or before today (i.e. a game that's actually been
 * played, not just scheduled). Used where showing a season with zero
 * results yet (e.g. one that just started) would be a confusing default.
 * Falls back to `fallbackId` if no Jam season has a played game.
 */
export function getLatestJamSeasonWithPlayedGame(
  allSeasons: SeasonLike[],
  games: GameLike[],
  fallbackId?: number
): number | undefined {
  const today = todayLocalStr()
  const playedSeasonIds = new Set(
    games.filter(g => g.season_id != null && g.game_date <= today).map(g => g.season_id as number)
  )
  const jamWithPlayedGames = allSeasons.filter(s => s.organizer === 'Jam' && playedSeasonIds.has(s.id))
  const latest = jamWithPlayedGames.sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))[0]
  return latest?.id ?? fallbackId
}
