import type { PlayerLine } from './types'

// The rankings table's column system. Every non-name column -- the six
// built-ins and anything the user adds -- is a signed combination of the
// three raw stats, optionally divided by games played. That is what makes
// "G+A", "G-TO/gm" and the rest reachable from a three-dropdown picker
// instead of needing a formula language.
//
// It moved out of pages/Stats.tsx and onto PlayerLine on the way: it used to
// read `PlayerStat`, whose fields are the strings Postgres returns from a
// SUM(), and so every column evaluation ran its own parseInt. The parsing
// happens once now, where the rest of the page already does it.

export type StatKey = 'goals' | 'assists' | 'turnovers'
export type ColumnTerm = { stat: StatKey; sign: 1 | -1 }

export type ColumnConfig = {
  id: string
  label: string
  /** A Tailwind text colour. Built-ins bind the series tokens so a column
   *  and the bar for the same stat on the leaderboard cannot drift apart. */
  color: string
  builtin?: boolean
  /** Omitted for the one column (GP) that is a raw field, not a combination. */
  terms?: ColumnTerm[]
  perGame?: boolean
}

export const STAT_LABELS: Record<StatKey, string> = { goals: 'G', assists: 'A', turnovers: 'TO' }

export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: 'goals', label: 'G', color: 'st-goals', builtin: true, terms: [{ stat: 'goals', sign: 1 }] },
  { id: 'assists', label: 'A', color: 'st-assists', builtin: true, terms: [{ stat: 'assists', sign: 1 }] },
  { id: 'turnovers', label: 'TO', color: 'st-turnovers', builtin: true, terms: [{ stat: 'turnovers', sign: 1 }] },
  { id: 'games_played', label: 'GP', color: '', builtin: true },
  { id: 'avgG', label: 'G/gm', color: 'st-goals', builtin: true, terms: [{ stat: 'goals', sign: 1 }], perGame: true },
  { id: 'avgA', label: 'A/gm', color: 'st-assists', builtin: true, terms: [{ stat: 'assists', sign: 1 }], perGame: true },
]

export const CUSTOM_COLUMNS_KEY = 'ufwt_stats_custom_columns'
export const HIDDEN_COLUMNS_KEY = 'ufwt_stats_hidden_columns'
export const COLUMN_WIDTHS_KEY = 'ufwt_stats_column_widths'

export const DEFAULT_PLAYER_COLUMN_WIDTH = 150
export const DEFAULT_STAT_COLUMN_WIDTH = 46
export const MIN_PLAYER_COLUMN_WIDTH = 72
export const MIN_STAT_COLUMN_WIDTH = 34

export function getColumnValue(col: ColumnConfig, p: PlayerLine): number | null {
  if (col.id === 'games_played') return p.gamesPlayed
  if (col.perGame && p.gamesPlayed === 0) return null
  const raw = (col.terms ?? []).reduce((sum, t) => sum + t.sign * p[t.stat], 0)
  return col.perGame ? raw / p.gamesPlayed : raw
}

export function formatColumnValue(col: ColumnConfig, value: number | null): string {
  if (value == null) return '—'
  return col.perGame ? value.toFixed(1) : String(value)
}

/**
 * Shared by the header-click quick-sort and the popover's explicit
 * primary/secondary pickers, so "Player" (alphabetical) and every stat or
 * formula column (numeric, via getColumnValue) compare the same way
 * regardless of which control triggered the sort.
 */
export function compareByColumn(
  colId: string, dir: 'asc' | 'desc', columns: ColumnConfig[], a: PlayerLine, b: PlayerLine,
): number {
  let cmp: number
  if (colId === 'player_name') {
    cmp = a.name.localeCompare(b.name)
  } else {
    const col = columns.find(c => c.id === colId)
    if (!col) return 0
    cmp = (getColumnValue(col, a) ?? -Infinity) - (getColumnValue(col, b) ?? -Infinity)
  }
  return dir === 'asc' ? cmp : -cmp
}

/** Formula columns can carry longer labels than the 2-3 character built-ins
 *  ("G+A/gm"), so their default width is sized to the label rather than to a
 *  flat number — otherwise a long label overlaps its right-aligned neighbour
 *  before anyone has touched a resize handle. */
export function defaultWidthFor(id: string, columns: ColumnConfig[]): number {
  if (id === 'player_name') return DEFAULT_PLAYER_COLUMN_WIDTH
  const label = columns.find(c => c.id === id)?.label ?? ''
  return Math.max(DEFAULT_STAT_COLUMN_WIDTH, label.length * 8 + 26)
}
