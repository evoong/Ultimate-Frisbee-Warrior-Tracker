import { useEffect, useMemo, useState } from 'react'
import { ArrowsLeftRight, Check } from '@phosphor-icons/react'
import { Avatar, AvatarFallback, AvatarImage } from '../../lib/shadcn/avatar'
import { Skeleton } from '../../lib/shadcn/skeleton'
import Segmented, { type SegmentOption } from './Segmented'
import AssistWeb from './AssistWeb'
import { SinglePicker } from './Picker'
import { crestInitials, shortName, type MatrixEdge, type PlayerLine } from './types'
import './stats-theme.css'

// One player's connections, both directions, two ways of looking at them.
//
// The web (AssistWeb, the default) is the shape of the team: who is wired to
// whom, with the focused player's lines lit and the rest of the pack dimmed
// behind them. The table is the same edges as two ranked lists, which is the
// view that answers "how many" without being read off a curve.
//
// Both read one selection and one edge set, so switching view never changes
// what is on screen, only how it is drawn -- and both are two directions of
// the same fact, which is why the old pair of rings ("Assists" and "Goals")
// collapsed into one of each: they drew identical edges and differed only in
// which end counted as the selected player's own. Here that difference is
// the table's two columns and the web's two line colours.

/** Web or table, per device. Which of two drawings of the same data somebody
 *  prefers is a viewing preference nobody else ever sees, so it lives here
 *  rather than in the page -- the same reasoning as RankingsTable's columns. */
const VIEW_KEY = 'ufwt:stats:assistView'
type MatrixView = 'web' | 'table'

// Two drawings of one data set, so a segmented control rather than a pair of
// icon buttons: the choice is exclusive and both options have to be readable
// at once.
const VIEWS: SegmentOption<MatrixView>[] = [
  { key: 'web', label: 'Web' },
  { key: 'table', label: 'Table' },
]

function Column({ title, total, rows, series, emptyLabel }: {
  title: string
  total: number
  rows: { id: number; name: string; photoUrl: string | null; count: number }[]
  series: 'goals' | 'assists'
  emptyLabel: string
}) {
  const max = rows[0]?.count ?? 0
  return (
    <div className={series === 'goals' ? 'st-goals' : 'st-assists'}>
      <div className="st-col-head">
        <span className="st-overline">{title}</span>
        <span className="st-figure st-figure--sm">{total}</span>
      </div>
      {rows.length === 0 ? (
        <p className="st-meta px-4 py-6 text-center">{emptyLabel}</p>
      ) : (
        <div className="st-list">
          {rows.map(r => (
            <div key={r.id} className="st-row">
              <Avatar className="st-crest st-crest--sm">
                {r.photoUrl && <AvatarImage src={r.photoUrl} alt="" />}
                <AvatarFallback className="st-crest-text">{crestInitials(r.name)}</AvatarFallback>
              </Avatar>
              <p className="st-name min-w-0 flex-1" title={r.name}>{shortName(r.name)}</p>
              <span className="st-track">
                <span className="st-meter block">
                  <span className="st-meter-fill block" style={{ width: `${max > 0 ? (r.count / max) * 100 : 0}%` }} />
                </span>
              </span>
              <span className="st-figure st-figure--sm shrink-0">{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AssistMatrix({
  players, edges, selectedId, onSelect, includeSubs, onIncludeSubsChange,
  loading, error, emptyLabel,
}: {
  players: PlayerLine[]
  edges: MatrixEdge[]
  selectedId: number | null
  onSelect: (id: number) => void
  includeSubs: boolean
  onIncludeSubsChange: (next: boolean) => void
  loading: boolean
  error: string | null
  emptyLabel: string
}) {
  const [view, setView] = useState<MatrixView>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'web' } catch { return 'web' }
  })
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view) } catch { /* private mode */ } }, [view])

  const byId = useMemo(() => new Map(players.map(p => [p.playerId, p])), [players])
  const selected = selectedId == null ? undefined : byId.get(selectedId)

  // Both columns read the same directed edges from opposite ends. "Assisted
  // by" is the set of edges that ended on this player, so the count is that
  // player's own goals; "assisted to" is the set that started with them, so
  // the count is their assists. That is why the two columns take different
  // series colours rather than one shared "connection" colour.
  const { fed, threw } = useMemo(() => {
    const collect = (pick: (e: MatrixEdge) => number, match: (e: MatrixEdge) => number) =>
      edges
        .filter(e => selectedId != null && match(e) === selectedId && byId.has(pick(e)))
        .map(e => {
          const other = byId.get(pick(e))!
          return { id: other.playerId, name: other.name, photoUrl: other.photoUrl, count: e.count }
        })
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

    return {
      fed: collect(e => e.assisterId, e => e.scorerId),
      threw: collect(e => e.scorerId, e => e.assisterId),
    }
  }, [edges, selectedId, byId])

  const fedTotal = fed.reduce((s, r) => s + r.count, 0)
  const threwTotal = threw.reduce((s, r) => s + r.count, 0)

  // See PerformanceChart: the web (or the table) stays and dims while the
  // next range loads. The skeleton is only for a panel with nothing yet.
  const drawable = players.length > 0 && edges.length > 0
  const cold = loading && !drawable
  const busy = loading && drawable

  return (
    <section className="st-panel">
      <div className="st-panel-head">
        <span className="st-overline">
          <ArrowsLeftRight className="h-3.5 w-3.5" weight="bold" />
          Assist matrix
        </span>
        <div className="flex items-center gap-1">
          {/* The subs toggle kept its behaviour and lost its raw checkbox. It
              is the same button shape as the leaderboard's legend, because it
              is the same kind of control: one thing in the panel switched on
              and off. */}
          <button
            type="button"
            className="st-legend"
            data-active={includeSubs}
            aria-pressed={includeSubs}
            onClick={() => onIncludeSubsChange(!includeSubs)}
          >
            <Check className="h-3 w-3" weight="bold" />
            Subs
          </button>

          {/* Two drawings of one data set, so a segmented control rather than
              a pair of icon buttons: the choice is exclusive and both options
              have to be readable at once. Neutral raised surface for the
              active side, never the accent -- picking a view is not "you are
              here". */}
          <Segmented
            options={VIEWS}
            value={view}
            onChange={setView}
            ariaLabel="Assist matrix view"
          />
        </div>
      </div>

      <div className="st-swap" data-busy={busy}>
        {cold ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-8 w-52" />
            <div className="grid gap-3 md:grid-cols-2">
              {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-9" />)}
            </div>
          </div>
        ) : error ? (
          <p className="flex h-40 items-center justify-center text-sm text-destructive">{error}</p>
        ) : players.length === 0 || edges.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3">
            <ArrowsLeftRight className="h-8 w-8 opacity-25" weight="regular" />
            <p className="st-meta">{emptyLabel}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
              <SinglePicker
                items={players.map(p => ({
                  id: p.playerId,
                  label: p.name,
                  photoUrl: p.photoUrl,
                  hint: `${p.goals}G ${p.assists}A`,
                }))}
                selectedId={selectedId}
                onChange={onSelect}
                placeholder="Pick a player"
                emptyLabel="No players in range"
                showCrests
              />
              {selected && (
                <span className="st-meta">
                  {selected.goals} goals · {selected.assists} assists · {selected.gamesPlayed} games
                </span>
              )}
            </div>

            <div className="border-t border-[hsl(var(--st-rule))]">
              {view === 'web' ? (
                <AssistWeb
                  players={players}
                  edges={edges}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              ) : (
                <div className="st-matrix">
                  <Column
                    title="Assisted by"
                    total={fedTotal}
                    rows={fed}
                    series="goals"
                    emptyLabel="Nobody has assisted them in this range"
                  />
                  <Column
                    title="Assisted to"
                    total={threwTotal}
                    rows={threw}
                    series="assists"
                    emptyLabel="They have not assisted anybody in this range"
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
