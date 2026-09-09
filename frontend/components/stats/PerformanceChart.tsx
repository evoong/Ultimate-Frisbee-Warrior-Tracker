import { useMemo, useState } from 'react'
import {
  Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ChartBar, TrendUp } from '@phosphor-icons/react'
import { SHOW_TURNOVERS } from '../../lib/features'
import { Skeleton } from '../../lib/shadcn/skeleton'
import Swap from './Swap'
import { useMediaQuery } from '../../lib/shadcn/use-media-query'
import type { PlayerLine, SeriesKey } from './types'
import './stats-theme.css'

// The performance chart, rebuilt as a leaderboard rather than a chart with a
// leaderboard's data in it.
//
// Two decisions carry it. First, there is no x-axis: a numeric axis under a
// ranked list is a ruler nobody reads, so the value is printed at the tip of
// its own bar instead and the row is legible without moving your eyes.
// Second, the four exclusive tabs (All Stats / Goals / Assists / Turnovers)
// became three legend swatches that toggle. Same control surface, but any
// combination is now reachable — goals against turnovers, say — and the
// legend stops being a second, redundant thing beside the tabs.

const ALL_SERIES: { key: SeriesKey; label: string; dataKey: string; token: string; cls: string }[] = [
  { key: 'goals', label: 'Goals', dataKey: 'goals', token: '--st-goals', cls: 'st-goals' },
  { key: 'assists', label: 'Assists', dataKey: 'assists', token: '--st-assists', cls: 'st-assists' },
  { key: 'turnovers', label: 'Turnovers', dataKey: 'turnovers', token: '--st-turnovers', cls: 'st-turnovers' },
]

// The legend, the bars and the tooltip all walk this one list, so a gated
// series leaves the chart in one step and takes its swatch with it.
const SERIES = ALL_SERIES.filter(s => s.key !== 'turnovers' || SHOW_TURNOVERS)

// The name column. Recharts wants a number, not a class, so this is the one
// piece of the chart's layout that has to come through JS. 104px is ~13% of
// the panel on a laptop but 36% of it on a 360px phone, where the bars are
// what is left over -- so the narrow value trades the rank column for plot
// width rather than shrinking everything evenly.
const AXIS_WIDE = 104
const AXIS_NARROW = 78

type Row = PlayerLine & { rank: number }

/**
 * The y-axis tick. Recharts hands back `{x, y, payload}` and expects SVG, so
 * this is two <text> nodes rather than a div: the rank in mono at the far
 * left, the name in Geist right-aligned against the plot. Names are already
 * shortened to "Alex R." upstream so a long surname cannot widen the axis
 * and squeeze the bars.
 *
 * The offsets below are measured from the axis's own right edge, which is
 * only where `x` lands because the YAxis sets tickSize and tickMargin to 0.
 * Left at their defaults, Recharts hands back `width - 6 - 2`, the rank sits
 * at -6, and single-digit ranks are clipped away entirely while double-digit
 * ones lose their leading 1 — which looks like a data bug and is not one.
 */
function NameTick({ x, y, payload, rows, width, showRank }: any) {
  const row: Row | undefined = rows[payload?.index ?? -1]
  if (!row) return null
  return (
    <g transform={`translate(${x},${y})`}>
      {showRank && (
        <text
          x={-width + 2}
          dy={4}
          textAnchor="start"
          fill="hsl(var(--st-ink-faint))"
          style={{ fontFamily: 'var(--st-mono)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
        >
          {row.rank}
        </text>
      )}
      <text
        x={-10}
        dy={4}
        textAnchor="end"
        fill="hsl(var(--st-ink))"
        style={{ fontSize: 11.5, fontWeight: 560, letterSpacing: '-0.012em' }}
      >
        {row.shortName}
      </text>
    </g>
  )
}

/**
 * The full breakdown, not just the hovered bar — the question a hover on a
 * leaderboard actually asks is "what is this player's whole line", and the
 * bar you happened to land on is an accident of pointer position. Every
 * series shows here whether or not it is currently drawn.
 */
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const row: Row | undefined = payload[0]?.payload
  if (!row) return null
  return (
    <div className="st-tip">
      <p className="st-name mb-1.5">{row.name}</p>
      {SERIES.map(s => (
        <div key={s.key} className={`st-tip-row ${s.cls}`}>
          <span className="st-tip-swatch" />
          <span>{s.label}</span>
          <span className="st-tip-value">{row[s.key]}</span>
        </div>
      ))}
      <div className="st-tip-row mt-1.5 border-t border-[hsl(var(--st-rule))] pt-1.5">
        <span />
        <span>Games</span>
        <span className="st-tip-value">{row.gamesPlayed}</span>
      </div>
    </div>
  )
}

export default function PerformanceChart({ players, loading, error, emptyLabel }: {
  players: PlayerLine[]
  loading: boolean
  error: string | null
  emptyLabel: string
}) {
  // A Set rather than one active key: the legend toggles, so any combination
  // is a valid state. The last-one-standing guard exists because an empty
  // chart is not a state anyone chooses on purpose.
  const wide = useMediaQuery('(min-width: 640px)')
  const axisWidth = wide ? AXIS_WIDE : AXIS_NARROW

  const [shown, setShown] = useState<Set<SeriesKey>>(() => new Set<SeriesKey>(SERIES.map(s => s.key)))
  const toggle = (key: SeriesKey) => setShown(prev => {
    if (prev.has(key) && prev.size === 1) return prev
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const rows: Row[] = useMemo(
    () => players.map((p, i) => ({ ...p, rank: i + 1 })),
    [players],
  )

  const active = SERIES.filter(s => shown.has(s.key))
  // Bars are a fixed 9px so a two-series view does not inflate into two fat
  // slabs; the row grows with how many are drawn instead.
  const rowHeight = 16 + active.length * 13
  const height = Math.max(200, rows.length * rowHeight + 8)

  // A panel that already has a leaderboard keeps it while the next range
  // loads and dims, rather than collapsing into six skeleton bars. The
  // skeleton here is ~150px and the chart is ~500px, so the swap and the
  // swap back are two full-page reflows for every click on the range filter.
  // The skeleton is for a cold panel: one that has nothing to show yet.
  const cold = loading && rows.length === 0
  const busy = loading && rows.length > 0

  return (
    <section className="st-panel">
      <div className="st-panel-head">
        <span className="st-overline">
          <ChartBar className="h-3.5 w-3.5" weight="bold" />
          Leaderboard
        </span>
        <div className="-mr-1 flex items-center gap-0.5">
          {SERIES.map(s => (
            <button
              key={s.key}
              type="button"
              className={`st-legend ${s.cls}`}
              data-active={shown.has(s.key)}
              aria-pressed={shown.has(s.key)}
              onClick={() => toggle(s.key)}
            >
              <span className="st-legend-swatch" />
              <span className="hidden sm:inline">{s.label}</span>
              <span className="sm:hidden">{s.label.slice(0, 1)}</span>
            </button>
          ))}
        </div>
      </div>

      <Swap busy={busy} className="p-3 sm:p-4">
        {cold ? (
          <div className="space-y-4 py-2">
            {[0.92, 0.78, 0.64, 0.51, 0.4, 0.29].map((w, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-3 w-16 shrink-0" />
                <Skeleton className="h-3.5" style={{ width: `${w * 100}%` }} />
              </div>
            ))}
          </div>
        ) : error ? (
          <p className="flex h-48 items-center justify-center text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-3">
            <TrendUp className="h-8 w-8 opacity-25" weight="regular" />
            <p className="st-meta">{emptyLabel}</p>
          </div>
        ) : (
          <div style={{ width: '100%', height }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 0, right: wide ? 34 : 26, left: 0, bottom: 0 }}
                barCategoryGap="26%"
                barGap={2}
              >
                {/* Present only to establish the numeric domain — the axis
                    itself is never drawn. The 12% headroom is what keeps the
                    value printed past the longest bar inside the plot. */}
                <XAxis type="number" hide domain={[0, (max: number) => Math.ceil(max * 1.12) || 1]} />
                <YAxis
                  type="category"
                  dataKey="shortName"
                  width={axisWidth}
                  axisLine={false}
                  tickLine={false}
                  tickSize={0}
                  tickMargin={0}
                  interval={0}
                  tick={<NameTick rows={rows} width={axisWidth} showRank={wide} />}
                />
                <Tooltip
                  content={<ChartTooltip />}
                  cursor={{ fill: 'hsl(0 0% 50% / 0.09)' }}
                  animationDuration={140}
                />
                {active.map(s => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={`hsl(var(${s.token}))`}
                    radius={[0, 3, 3, 0]}
                    barSize={9}
                    isAnimationActive={false}
                  >
                    <LabelList
                      dataKey={s.key}
                      position="right"
                      offset={7}
                      // Zero is drawn as nothing rather than as "0": a
                      // column of zeroes beside bars of no length is noise.
                      formatter={(v: unknown) => (Number(v) > 0 ? String(v) : '')}
                      style={{
                        fontFamily: 'var(--st-mono)',
                        fontSize: 10.5,
                        fontWeight: 600,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                      fill={`hsl(var(${s.token}))`}
                    />
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Swap>
    </section>
  )
}
