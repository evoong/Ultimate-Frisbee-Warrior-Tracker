import { CaretRight, Trophy } from '@phosphor-icons/react'
import { Avatar, AvatarFallback, AvatarImage } from '../../lib/shadcn/avatar'
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
    weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
    full: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
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

/**
 * One or two letters for the crest. Split on the separators team names
 * actually use so "Disc Jockeys" gives "DJ" and "Huck" gives "HU".
 *
 * Deliberately a local copy of the same idea in components/nav/identity.ts
 * rather than an import: this component's whole contract is that it depends
 * on MatchData and nothing else in the app, and reaching into the nav shell
 * for a three-line string helper is exactly how that contract erodes.
 */
function crestInitials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return (words[0] ?? name).slice(0, 2).toUpperCase()
}

const CHIP_TONE: Record<string, string> = {
  win: 'sch-chip--win',
  loss: 'sch-chip--loss',
  tie: 'sch-chip--tie',
}

// Below `md` the verdict track is 68px and `outcomeLabel` can be as long as
// "Default Win", so the chip falls back to the bare outcome. Nothing is lost:
// the asterisk beside it already says the result was entered by hand, the
// full wording is one tap away on the game, and the row's aria-label carries
// it verbatim for screen readers at every width. Truncating to "DEFAULT W…"
// instead would have been three characters of noise where a word fits.
const CHIP_SHORT: Record<string, string> = { win: 'Win', loss: 'Loss', tie: 'Tie' }

export type GameRowProps = {
  matchData: MatchData
  onSelect?: (id: MatchData['id']) => void
  /** Entrance stagger in ms; pass `index * 35` from a list. */
  delay?: number
  /** Pulls the row forward as the next fixture up. */
  featured?: boolean
  /** Overrides the featured row's trailing chip text, e.g. "TOMORROW". */
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
  // Supabase column is one entry in `details` — no wrapper divs, no nested
  // flexbox, and no touching this component.
  //
  // The order is the F-pattern: crest, identity, drop-in fields, score,
  // verdict. Reading runs left to right and ends on the result, which is
  // where a row's answer belongs — you arrive at it, rather than being told
  // it before you know who played.
  const detailTracks = details.map(() => 'minmax(0, 6.5rem)').join(' ')
  const style = {
    ['--sch-cols-sm' as string]: '2.125rem minmax(0, 1fr) auto 4.25rem',
    ['--sch-cols-md' as string]: `2.25rem minmax(0, 1fr) ${detailTracks ? detailTracks + ' ' : ''}auto 5.75rem 1rem`,
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
      {/* 1 — crest. A real <Avatar>, not a styled span: the day a team logo
          lands in the database it drops into <AvatarImage> and the grid does
          not move. Until then the monogram is the fallback, which is exactly
          what the primitive is for. */}
      <Avatar className="sch-crest sch-stagger sch-stagger-1">
        {matchData.crestUrl && <AvatarImage src={matchData.crestUrl} alt="" />}
        <AvatarFallback className="sch-crest-text">{crestInitials(opponent)}</AvatarFallback>
      </Avatar>

      {/* 2 — identity */}
      <span className="sch-stagger sch-shift sch-stagger-1 min-w-0 block">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="sch-team truncate">{opponent}</span>
          {matchData.highlight && (
            <Trophy className="h-3.5 w-3.5 shrink-0" weight="fill" style={{ color: 'hsl(var(--sch-accent-ink))' }} />
          )}
        </span>
        <span className="sch-meta mt-[7px] flex items-center gap-1.5 truncate">
          <span>{played ? when.full : `${when.weekday}, ${when.full}`}</span>
          {clock && <><span className="sch-meta-sep">·</span><span>{clock}</span></>}
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

      {/* n+2 — the verdict, closing the row. A fixed-width track in both
          layouts, so WIN / LOSS / TIE stamp the same tile down a right-edge
          spine and a row without one still keeps its score where the others
          put theirs. */}
      {/* `justify-self-stretch`, not `-end`: the chip's `width: 100%` has to
          resolve against the fixed track, and a content-width cell would give
          it the chip's own width instead — which is the bug the fixed track
          exists to prevent, reintroduced one level down. */}
      <span className="sch-stagger sch-stagger-3 justify-self-stretch min-w-0">
        {played && outcome && outcomeLabel ? (
          <Badge
            title={outcomeLabel}
            className={`sch-chip sch-chip--outcome ${CHIP_TONE[outcome]} shadow-none hover:bg-inherit`}
          >
            <span className="md:hidden">{CHIP_SHORT[outcome]}</span>
            <span className="hidden md:inline">{outcomeLabel}</span>
            {matchData.outcomeOverridden && <span className="opacity-60">*</span>}
          </Badge>
        ) : featuredNote ? (
          <Badge className="sch-chip sch-chip--outcome sch-chip--next shadow-none hover:bg-inherit">{featuredNote}</Badge>
        ) : null}
      </span>

      {/* n+3 — affordance, desktop only */}
      <CaretRight className="sch-caret sch-stagger sch-stagger-3 hidden h-4 w-4 md:block" weight="bold" />
    </button>
  )
}
