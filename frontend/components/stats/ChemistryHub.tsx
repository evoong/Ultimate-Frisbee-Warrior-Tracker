import { CaretDoubleRight, Users } from '@phosphor-icons/react'
import { Avatar, AvatarFallback, AvatarImage } from '../../lib/shadcn/avatar'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { crestInitials, shortName, type ChemistryPair } from './types'
import './stats-theme.css'

// Who actually connects with whom. This was a horizontal bar chart whose
// y-axis was the string "Devin ← Marisol" at 11px, repeated ten times — a
// chart doing the work of a list, and doing it worse: the labels were the
// content, the bars only re-stated a number that was already short enough to
// read, and 140px of the panel was spent on text set sideways to itself.
//
// A list of people wants faces and a direction. The two crests overlap
// because a pairing is one thing, not two, and the caret says which way the
// disc went — the old "←" was pointing at the scorer from the assister,
// which is backwards from how anyone says it out loud.

/** The count a pairing has to reach to be called lethal. Below this the
 *  leader is just whoever happened to play together most, which is not a
 *  claim worth making on the page. */
const LETHAL_MIN = 3

export default function ChemistryHub({ pairs, loading, error, emptyLabel }: {
  pairs: ChemistryPair[]
  loading: boolean
  error: string | null
  emptyLabel: string
}) {
  // The list arrives sorted by count descending, but the badge is a
  // property of the count, not of the row index: three pairings on 3 are
  // three lethal pairings, and giving the badge to whichever of them the
  // sort happened to put first says the other two are something lesser.
  // Reduced rather than read off pairs[0] so the rule survives a caller
  // that hands over an unsorted slice.
  const top = pairs.reduce((m, p) => Math.max(m, p.count), 0)
  const lethal = top >= LETHAL_MIN

  return (
    <section className="st-panel">
      <div className="st-panel-head">
        <span className="st-overline">
          <Users className="h-3.5 w-3.5" weight="bold" />
          Chemistry
        </span>
        <span className="st-meta">Assister → scorer</span>
      </div>

      {loading ? (
        <div className="space-y-3 p-4">
          {[0, 1, 2, 3, 4].map(i => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-7 w-12 shrink-0 rounded-full" />
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3.5 w-8 shrink-0" />
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="flex h-40 items-center justify-center text-sm text-destructive">{error}</p>
      ) : pairs.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3">
          <Users className="h-8 w-8 opacity-25" weight="regular" />
          <p className="st-meta">{emptyLabel}</p>
        </div>
      ) : (
        <div className="st-list st-assists">
          {pairs.map((p, i) => (
            <div key={`${p.assisterId}:${p.scorerId}`} className="st-row">
              <span className="st-rank">{i + 1}</span>

              <span className="st-duo">
                <Avatar className="st-crest st-crest--sm">
                  {p.assisterPhotoUrl && <AvatarImage src={p.assisterPhotoUrl} alt="" />}
                  <AvatarFallback className="st-crest-text">{crestInitials(p.assisterName)}</AvatarFallback>
                </Avatar>
                <Avatar className="st-crest st-crest--sm">
                  {p.scorerPhotoUrl && <AvatarImage src={p.scorerPhotoUrl} alt="" />}
                  <AvatarFallback className="st-crest-text">{crestInitials(p.scorerName)}</AvatarFallback>
                </Avatar>
              </span>

              <p
                className="flex min-w-0 flex-1 items-center gap-1 truncate"
                title={`${p.assisterName} to ${p.scorerName}`}
              >
                <span className="st-name">{shortName(p.assisterName)}</span>
                <CaretDoubleRight
                  className="h-3 w-3 shrink-0 text-[hsl(var(--st-ink-faint))]"
                  weight="bold"
                  aria-label="to"
                />
                <span className="st-name">{shortName(p.scorerName)}</span>
              </p>

              {lethal && p.count === top && (
                <span className="st-chip hidden shrink-0 sm:inline-flex">Lethal</span>
              )}

              {/* Relative to the top pairing, so the list has a shape without
                  being a chart: it answers "how far ahead is first" at a
                  glance, which the bare counts do not. */}
              <span className="st-track st-track--optional">
                <span className="st-meter block">
                  <span className="st-meter-fill block" style={{ width: `${top > 0 ? (p.count / top) * 100 : 0}%` }} />
                </span>
              </span>

              {/* No per-row unit: every number in this panel is an assist
                  count, the head says so, and "9 ASTS" eight times is the
                  same word repeated in the loudest type on the row. */}
              <span className="st-figure st-figure--sm shrink-0">{p.count}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
