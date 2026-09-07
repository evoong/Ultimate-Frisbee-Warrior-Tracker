// The shape a schedule row renders. Deliberately decoupled from the `games`
// table row: a row knows about a match, not about our database, so the same
// component can render a different sport's fixture as soon as something can
// map that sport onto this type.

export type MatchOutcome = 'win' | 'loss' | 'tie'

/**
 * An extra field dropped into the row's grid. Each one becomes its own
 * column track on desktop (see GameRow's `--sch-cols-md`) and is hidden on
 * narrow screens, so adding venue, duration, division or referee is a
 * one-line change at the call site with no layout surgery.
 */
export type MatchDetail = {
  label: string
  value: string
}

export type MatchData = {
  id: string | number
  opponent: string
  /** ISO `yyyy-mm-dd`, local. */
  date: string
  /** `HH:mm[:ss]`, or null when the start time is unknown. */
  time: string | null
  status: 'played' | 'upcoming'
  ourScore: number | null
  theirScore: number | null
  /** Null for an upcoming match. */
  outcome: MatchOutcome | null
  /**
   * What the chip says. Usually 'Win' / 'Loss' / 'Tie', but carries wordier
   * recorded results such as 'Default Win' or 'Forfeit' when one is set.
   */
  outcomeLabel: string | null
  /** True when outcomeLabel was entered by hand and overrides the score. */
  outcomeOverridden?: boolean
  /** Marks a playoff/knockout fixture. */
  highlight?: boolean
  details?: MatchDetail[]
}
