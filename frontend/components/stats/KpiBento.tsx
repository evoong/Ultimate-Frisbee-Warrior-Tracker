import type { ReactNode } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '../../lib/shadcn/avatar'
import { crestInitials, type PlayerLine, type SeriesKey, type TeamLine } from './types'
import './stats-theme.css'

// The three cards that open the page. They replaced four boxes: two
// "Top Scorer / Top Assister" cards that showed a name and a number, and two
// tinted banners that showed a team average and nothing else — four surfaces
// carrying six numbers between them.
//
// Every card is the same object: an overline, an identity, one hero figure,
// and a hairline-separated strip of supporting numbers along the bottom. The
// series colour is bound once on the card (`.st-goals`) and the figure, the
// glyph, the chip and the meter all read it from there, so a card cannot end
// up with a green number over an amber bar.

const SERIES_CLASS: Record<SeriesKey, string> = {
  goals: 'st-goals',
  assists: 'st-assists',
  turnovers: 'st-turnovers',
}

function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(digits)
}

/**
 * One column of the strip that closes each card. Neutral unless it is handed
 * a series of its own: the strip sits inside a card that has already bound
 * one, and inheriting it would paint the team card's "Allowed" in the same
 * green as a positive differential.
 */
function Cell({ label, series, children }: { label: string; series?: SeriesKey; children: ReactNode }) {
  return (
    <div className={`st-strip-cell ${series ? SERIES_CLASS[series] : ''}`}>
      <span className="st-unit truncate">{label}</span>
      <span className="st-figure st-figure--sm">{children}</span>
    </div>
  )
}

/**
 * Top finisher / top playmaker. `share` is what makes this more than a
 * leaderboard entry: 24 goals means nothing until you know whether the team
 * scored 60 or 300, and the meter is the cheapest way to say it.
 */
export function LeaderCard({ overline, icon, series, player, value, unit, teamTotal, secondary }: {
  overline: string
  icon: ReactNode
  series: SeriesKey
  player: PlayerLine | null
  value: number
  unit: string
  teamTotal: number
  /** This player's other numbers, so the card is their whole line rather
   *  than the one stat that got them onto it. Same strip, same anatomy, as
   *  the team card beside it. A cell with no series of its own stays
   *  neutral, the way the team card's "Scored" does -- a combined figure
   *  like G+A belongs to no one series and must not borrow one. */
  secondary: { label: string; series?: SeriesKey; value: number }[]
}) {
  const perGame = player && player.gamesPlayed > 0 ? value / player.gamesPlayed : null
  const share = teamTotal > 0 ? Math.round((value / teamTotal) * 100) : null

  return (
    <div className={`st-panel st-kpi ${SERIES_CLASS[series]}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="st-overline">
          <span className="st-series-ink flex">{icon}</span>
          {overline}
        </span>
        {perGame != null && <span className="st-chip">{perGame.toFixed(1)} /gm</span>}
      </div>

      {player ? (
        <div className="flex items-center gap-2.5">
          <Avatar className="st-crest">
            {player.photoUrl && <AvatarImage src={player.photoUrl} alt="" />}
            <AvatarFallback className="st-crest-text">{crestInitials(player.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="st-name" title={player.name}>{player.name}</p>
            <p className="st-meta">{player.gamesPlayed} {player.gamesPlayed === 1 ? 'game' : 'games'}</p>
          </div>
          <span className="st-figure shrink-0">{value}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <Avatar className="st-crest">
            <AvatarFallback className="st-crest-text">—</AvatarFallback>
          </Avatar>
          <p className="st-meta flex-1">No player data in range</p>
        </div>
      )}

      <div className="space-y-1.5 pt-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="st-unit">{unit}</span>
          <span className="st-meta">{share == null ? '—' : `${share}% of team`}</span>
        </div>
        <div className="st-meter">
          <div className="st-meter-fill" style={{ width: `${share ?? 0}%` }} />
        </div>
      </div>

      <div className="st-strip">
        {secondary.map(c => (
          <Cell key={c.label} label={c.label} series={c.series}>{player ? c.value : '—'}</Cell>
        ))}
      </div>
    </div>
  )
}

/**
 * The team's own line. Point differential is the hero because it is the one
 * number that answers "are we winning" without needing a second one beside
 * it; scored, allowed and the two per-game rates sit under it as the working.
 */
export function TeamCard({ icon, team }: { icon: ReactNode; team: TeamLine }) {
  const diff = team.pointsFor - team.pointsAgainst
  const played = team.gamesPlayed > 0
  // The differential is the only signed number on the card, so the tone binds
  // to that figure alone. On the card it would leak down into the strip and
  // colour "Allowed" the same as a positive diff.
  const tone = !played ? '' : diff > 0 ? 'st-up' : diff < 0 ? 'st-down' : ''
  const record = `${team.wins}-${team.losses}${team.ties > 0 ? `-${team.ties}` : ''}`

  return (
    <div className="st-panel st-kpi">
      <div className="flex items-center justify-between gap-2">
        <span className="st-overline">
          <span className="st-series-ink flex">{icon}</span>
          Team
        </span>
        {played && <span className="st-chip">{record}</span>}
      </div>

      <div className="flex items-end gap-2.5">
        <span className={`st-figure ${tone}`}>{played ? `${diff > 0 ? '+' : ''}${diff}` : '—'}</span>
        <span className="st-unit pb-1">Point diff</span>
        <span className="st-meta ml-auto pb-1">
          {played ? `${team.gamesPlayed} ${team.gamesPlayed === 1 ? 'game' : 'games'}` : 'No games in range'}
        </span>
      </div>

      <div className="st-strip">
        <Cell label="Scored">{played ? team.pointsFor : '—'}</Cell>
        <Cell label="Allowed">{played ? team.pointsAgainst : '—'}</Cell>
        <Cell label="G / gm">{fmt(team.avgGoals, 1)}</Cell>
        <Cell label="A / gm">{fmt(team.avgAssists, 1)}</Cell>
      </div>
    </div>
  )
}

/**
 * The compact variant, used for the "Me" tab's own four numbers. Same
 * overline/figure/unit skeleton as the cards above, minus the identity row —
 * on that tab the player is the page, so repeating their crest four times
 * says nothing.
 */
export function MetricCard({ label, value, series, hint }: {
  label: string
  value: string | number
  series?: SeriesKey
  hint?: string
}) {
  return (
    <div className={`st-panel st-kpi gap-2 ${series ? SERIES_CLASS[series] : ''}`}>
      <span className="st-overline">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="st-figure">{value}</span>
        {hint && <span className="st-meta">{hint}</span>}
      </div>
    </div>
  )
}
