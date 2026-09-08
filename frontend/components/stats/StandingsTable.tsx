import { CaretDown, CaretUp, CaretUpDown } from '@phosphor-icons/react'
import { Skeleton } from '../../lib/shadcn/skeleton'
import './stats-theme.css'

// The league table. Same table primitives as the rankings grid — hairlines,
// mono tabular numbers, a sort glyph that is always present so a column does
// not resize the moment it becomes the sorted one — with two things that are
// specific to standings: our own row is tinted, and each team carries a form
// guide of one dot per decided game.

export type StandingsSortKey =
  | 'rank' | 'team' | 'games_played' | 'wins'
  | 'points_for' | 'points_against' | 'point_diff' | 'points'

export type StandingsRow = {
  teamId: number
  teamName: string
  isUs: boolean
  rank: number
  gamesPlayed: number
  wins: number
  losses: number
  ties: number
  pointsFor: number
  pointsAgainst: number
  pointDiff: number
  points: number
  form: ('W' | 'L' | 'T')[]
}

const COLUMNS: { key: StandingsSortKey; label: string }[] = [
  { key: 'games_played', label: 'GP' },
  { key: 'wins', label: 'W-L-T' },
  { key: 'points_for', label: 'GF' },
  { key: 'points_against', label: 'GA' },
  { key: 'point_diff', label: '+/-' },
  { key: 'points', label: 'PTS' },
]

const FORM_SERIES: Record<'W' | 'L' | 'T', string> = { W: 'st-up', L: 'st-down', T: 'st-tie' }

export default function StandingsTable({ rows, sortKey, sortDir, onSort, onSelect, loading, emptyLabel }: {
  rows: StandingsRow[]
  sortKey: StandingsSortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: StandingsSortKey) => void
  onSelect: (teamId: number) => void
  loading: boolean
  emptyLabel: string
}) {
  const glyph = (key: StandingsSortKey) => sortKey === key
    ? (sortDir === 'asc' ? <CaretUp className="h-3 w-3" weight="bold" /> : <CaretDown className="h-3 w-3" weight="bold" />)
    : <CaretUpDown className="st-sort-idle h-3 w-3" weight="bold" />

  const header = (key: StandingsSortKey, label: string) => (
    <button type="button" className="st-sort" data-active={sortKey === key} onClick={() => onSort(key)}>
      {label}
      {glyph(key)}
    </button>
  )

  if (loading) {
    return (
      <section className="st-panel">
        <div className="space-y-2.5 p-4">
          {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-6" />)}
        </div>
      </section>
    )
  }

  if (rows.length === 0) {
    return (
      <section className="st-panel">
        <p className="st-meta p-8 text-center">{emptyLabel}</p>
      </section>
    )
  }

  return (
    <section className="st-panel">
      <div className="st-scroll">
        <table className="st-table">
          <thead>
            <tr>
              <th className="st-th" style={{ width: 40 }}>{header('rank', '#')}</th>
              <th className="st-th st-th--left">{header('team', 'Team')}</th>
              {COLUMNS.map(c => <th key={c.key} className="st-th">{header(c.key, c.label)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr
                key={r.teamId}
                className="st-tr cursor-pointer"
                data-us={r.isUs || undefined}
                onClick={() => onSelect(r.teamId)}
              >
                <td className="st-td" style={{ color: 'hsl(var(--st-ink-faint))', fontWeight: 500, fontSize: '0.6875rem' }}>
                  {r.rank}
                </td>
                <td className="st-td st-td--left" style={{ minWidth: '9rem' }}>
                  <span className="st-name" title={r.teamName}>{r.teamName}</span>
                  {r.form.length > 0 && (
                    <span className="mt-1.5 flex max-w-[10rem] flex-wrap gap-1">
                      {r.form.map((o, i) => <span key={i} className={`st-dot ${FORM_SERIES[o]}`} title={o} />)}
                    </span>
                  )}
                </td>
                <td className="st-td">{r.gamesPlayed}</td>
                <td className="st-td">{r.wins}-{r.losses}-{r.ties}</td>
                <td className="st-td">{r.pointsFor}</td>
                <td className="st-td">{r.pointsAgainst}</td>
                {/* The only tinted number in the table. A signed differential
                    is the same claim a win is, so it takes the same tokens. */}
                <td className={`st-td ${r.pointDiff > 0 ? 'st-up' : r.pointDiff < 0 ? 'st-down' : ''}`}>
                  {r.pointDiff > 0 ? `+${r.pointDiff}` : r.pointDiff}
                </td>
                <td className="st-td" style={{ fontWeight: 700 }}>{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
