// Shapes the Stats presentation layer works in. These are deliberately not
// the Supabase row types: nothing under components/stats/ knows what a
// `players` row or an `outcome_override` is, the same boundary GameRow keeps
// against `games` — it is what lets these pieces be reused or restyled
// without a query changing underneath them.

export type SeriesKey = 'goals' | 'assists' | 'turnovers'

export type SeasonOption = {
  id: number
  name: string
  year: number
  organizer: string | null
}

export type GameOption = {
  id: number
  opponent: string
  game_date: string
  season_id: number | null
}

/** Scope of the whole page: every game ever, some seasons, or hand-picked games. */
export type FilterMode = 'all' | 'season' | 'games'

/** One player's line, already parsed out of the string-typed SQL aggregates. */
export type PlayerLine = {
  playerId: number
  name: string
  shortName: string
  photoUrl: string | null
  goals: number
  assists: number
  turnovers: number
  gamesPlayed: number
}

/** Team-level totals for the current filter. Every field is optional-by-null
 *  rather than zero, so "no games in range" renders as a dash instead of as a
 *  confident 0. */
export type TeamLine = {
  wins: number
  losses: number
  ties: number
  pointsFor: number
  pointsAgainst: number
  gamesPlayed: number
  avgGoals: number | null
  avgAssists: number | null
}

/** One assister -> scorer connection, already joined to both players' photos. */
export type ChemistryPair = {
  assisterId: number
  assisterName: string
  assisterPhotoUrl: string | null
  scorerId: number
  scorerName: string
  scorerPhotoUrl: string | null
  count: number
}

/** A directed assist edge. Direction is the whole point: `assisterId` threw
 *  it and `scorerId` caught it, and the matrix reads the same edge from both
 *  ends depending on which column it is filling. */
export type MatrixEdge = { assisterId: number; scorerId: number; count: number }

/** One line on the progression chart. Series are keyed by player id, never by
 *  display name — two players called "Sam" would otherwise collapse into one
 *  line and silently sum. */
export type ProgressionPlayer = { id: number; name: string }
export type ProgressionStat = 'ga' | 'goals' | 'assists' | 'turnovers'
/** Sentinel season id for "every game", so the picker can stay numeric
 *  instead of carrying a '__all__' string that every call site has to know. */
export const ALL_SEASONS = -1
export type ProgressionPoint = Record<string, string | number>

export function seasonLabel(s: SeasonOption): string {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

/** First name plus a last initial: enough to tell two Alexes apart in a chart
 *  tick without letting a long surname set the axis width. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/)
  if (parts.length < 2) return parts[0] ?? full
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`
}

/** One or two letters for the avatar fallback. A local copy of nav's
 *  `initials()` on purpose — see GameRow's crestInitials for the same call:
 *  this scope does not import from the nav shell. */
export function crestInitials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}
