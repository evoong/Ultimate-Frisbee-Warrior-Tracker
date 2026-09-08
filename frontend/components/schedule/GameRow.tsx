import { ChevronRight, Trophy } from 'lucide-react'
import { Badge } from '../../lib/shadcn/badge'
import type { MatchData } from './types'
import './schedule-theme.css'

// One fixture, one row. The row owns no data fetching and no knowledge of
// `games` — hand it a MatchData and it renders. Keep it that way: it is the
// piece that has to survive a second sport being added.

function formatDayMonth(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00')
  return {
    month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: String(d.getDate()),
    weekday: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
    full: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase(),
  }
}

function formatClock(timeStr: string | null) {
  if (!timeStr) return null
  const [h, m] = timeStr.split(':')
  const hour = parseInt(h!, 10)
  if (Number.isNaN(hour)) return null
  const suffix = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${hour12}:${m ?? '00'} ${suffix}`
}

const CHIP_TONE: Record<string, string> = {
  win: 'sch-chip--win',
  loss: 'sch-chip--loss',
  tie: 'sch-chip--tie',
}

export type GameRowProps = {
  matchData: MatchData
  onSelect?: (id: MatchData['id']) => void
  /** Entrance stagger in ms; pass `index * 35` from a list. */
  delay?: number
  /** Pulls the row forward as the next fixture up. */
  featured?: boolean
  /** Overrides the featured row's leading chip text, e.g. "TOMORROW". */
  featuredNote?: string | null
}

export default function GameRow({ matchData, onSelect, delay = 0, featured = false, featuredNote }: GameRowProps) {
  const { opponent, date, time, status, ourScore, theirScore, outcome, outcomeLabel } = matchData
  const details = matchData.details ?? []
  const played = status === 'played'
  const when = formatDayMonth(date)
  const clock = formatClock(time)

  // Grid tracks are handed to CSS as custom properties rather than utility
  // classes so the desktop template can grow a track per detail field. A new
  // field is one entry in `details` — no wrapper divs, no nested flexbox.
  const detailTracks = details.map(() => 'minmax(0, 6.5rem)').join(' ')
  const style = {
    ['--sch-cols-sm' as string]: '5rem minmax(0, 1fr) auto',
    ['--sch-cols-md' as string]: `5.25rem minmax(0, 1fr) ${detailTracks ? detailTracks + ' ' : ''}auto 1rem`,
    animationDelay: delay ? `${delay}ms` : undefined,
  }

  const srSummary = played
    ? `${opponent}, ${ourScore}–${theirScore}${outcomeLabel ? `, ${outcomeLabel}` : ''}`
    : `${opponent}, ${when.full}${clock ? `, ${clock}` : ''}`

  return (
    <button
      type="button"
      onClick={() => onSelect?.(matchData.id)}
      aria-label={srSummary}
      // GameLedger finds its rail target by this attribute.
      data-sch-row=""
      style={style}
      className={[
        'sch-row animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-500',
        featured ? 'sch-row--featured' : '',
      ].join(' ')}
    >
      {/* 1 — outcome. It leads the row on purpose: a result you have to hunt
          for at the far end of a wide row is a result you read twice. The
          track is a fixed width in both layouts so the chips stack into a
          left-edge spine and a row without one still lines its name up. */}
      <span className="sch-stagger sch-stagger-1 justify-self-start">
        {played && outcome && outcomeLabel ? (
          <Badge className={`sch-chip sch-chip--outcome ${CHIP_TONE[outcome]} rounded-[3px] shadow-none hover:bg-inherit`}>
            {outcomeLabel}
            {matchData.outcomeOverridden && <span className="opacity-60">*</span>}
          </Badge>
        ) : featuredNote ? (
          <Badge className="sch-chip sch-chip--next rounded-[3px] shadow-none hover:bg-inherit">{featuredNote}</Badge>
        ) : null}
      </span>

      {/* 2 — identity */}
      <span className="sch-stagger sch-shift sch-stagger-1 min-w-0 block">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="sch-team truncate">{opponent}</span>
          {matchData.highlight && (
            <Trophy className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} style={{ color: 'hsl(var(--sch-accent-ink))' }} />
          )}
        </span>
        <span className="sch-meta mt-1.5 flex items-center gap-1.5 truncate">
          <span>{played ? when.full : when.weekday}</span>
          {clock && <><span className="sch-meta-sep">/</span><span>{clock}</span></>}
        </span>
      </span>

      {/* 3..n — drop-in fields (venue, duration, division…) */}
      {details.map(d => (
        <span key={d.label} className="sch-stagger sch-stagger-2 hidden md:block min-w-0">
          <span className="sch-label block">{d.label}</span>
          <span className="sch-meta mt-1.5 block truncate">{d.value}</span>
        </span>
      ))}

      {/* n+1 — score, or the date block for a fixture not yet played */}
      <span className="sch-stagger sch-stagger-2 justify-self-end">
        {played ? (
          <span className={`sch-score${outcome ? ` sch-score--${outcome}` : ''}`}>
            <span className="sch-score-our">{ourScore ?? '–'}</span>
            <span className="sch-score-dash">–</span>
            <span className="sch-score-them">{theirScore ?? '–'}</span>
          </span>
        ) : (
          <span className="sch-datemark">
            <span className="sch-datemark-month">{when.month}</span>
            <span className="sch-datemark-day">{when.day}</span>
          </span>
        )}
      </span>

      {/* n+2 — affordance, desktop only */}
      <ChevronRight className="sch-caret sch-stagger sch-stagger-3 hidden h-4 w-4 md:block" strokeWidth={1.75} />
    </button>
  )
}
