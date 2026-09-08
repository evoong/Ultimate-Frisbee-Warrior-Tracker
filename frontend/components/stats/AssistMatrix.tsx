import { useMemo } from 'react'
import { ArrowsLeftRight, Check } from '@phosphor-icons/react'
import { Avatar, AvatarFallback, AvatarImage } from '../../lib/shadcn/avatar'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { SinglePicker } from './Picker'
import { crestInitials, shortName, type MatrixEdge, type PlayerLine } from './types'
import './stats-theme.css'

// One player's connections, both directions, as two lists.
//
// This replaced a pair of 320px circular force-ish graphs: every player on
// the ring, every pairing a curved line across the middle with a number
// floating on it. At a real roster size that is a hairball — the lines cross
// each other and the labels, the node positions carry no meaning (they came
// out of a greedy farthest-point placement whose only job was to keep the
// busiest nodes from overlapping), and the only question it could answer was
// the one you got by tapping a node to dim everything else. That question is
// "who does this player connect with", and it is a list.
//
// Two graphs collapsed into one view, too: the old "Assists" and "Goals"
// rings drew the exact same edges and differed only in which end of an edge
// counted as the selected player's own. That is what the two columns are.

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

  return (
    <section className="st-panel">
      <div className="st-panel-head">
        <span className="st-overline">
          <ArrowsLeftRight className="h-3.5 w-3.5" weight="bold" />
          Assist matrix
        </span>
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
      </div>

      {loading ? (
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

          <div className="st-matrix border-t border-[hsl(var(--st-rule))]">
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
        </>
      )}
    </section>
  )
}
