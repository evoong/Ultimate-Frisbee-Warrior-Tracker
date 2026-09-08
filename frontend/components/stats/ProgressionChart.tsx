import { useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartLine } from '@phosphor-icons/react'
import { SHOW_TURNOVERS } from '../../lib/features'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { MultiPicker, SinglePicker } from './Picker'
import {
  ALL_SEASONS, seasonLabel, shortName,
  type ProgressionPlayer, type ProgressionPoint, type ProgressionStat, type SeasonOption,
} from './types'
import './stats-theme.css'

// Cumulative output over a season, one line per player.
//
// Eight lines in eight unrelated hues is spaghetti: no line is readable
// because every line is competing, and the twelve-colour palette it drew
// from meant the same player changed colour when the selection changed.
// Focus + dim fixes both at once — every line drops to a neutral at 16%,
// one line is the accent, and hovering the legend moves the emphasis. The
// dimmed lines still carry the shape of the pack, which is the context that
// makes one line worth following.
//
// The accent is the right colour for it: "the line you are looking at" is
// state, which is the only thing that colour is ever spent on in this app.

const ALL_STATS: { key: ProgressionStat; label: string }[] = [
  { key: 'ga', label: 'G+A' },
  { key: 'goals', label: 'Goals' },
  { key: 'assists', label: 'Assists' },
  { key: 'turnovers', label: 'TO' },
]

const STATS = ALL_STATS.filter(s => s.key !== 'turnovers' || SHOW_TURNOVERS)

const AXIS_TICK = {
  fontFamily: 'var(--st-mono)',
  fontSize: 10,
  fill: 'hsl(var(--st-ink-faint))',
} as const

function ProgressionTooltip({ active, payload, label, players, focusId }: any) {
  if (!active || !payload?.length) return null
  const point: ProgressionPoint | undefined = payload[0]?.payload
  if (!point) return null

  const rows = players
    .map((p: ProgressionPlayer) => ({ ...p, value: Number(point[String(p.id)] ?? 0) }))
    .sort((a: any, b: any) => b.value - a.value)

  return (
    <div className="st-tip">
      <p className="st-name">{label}</p>
      <p className="st-meta mb-1.5">{String(point.fullLabel ?? '')}</p>
      {rows.map((r: any) => (
        <div key={r.id} className="st-tip-row" style={r.id === focusId ? undefined : { opacity: 0.72 }}>
          <span
            className="st-tip-swatch"
            style={{
              background: r.id === focusId
                ? 'hsl(var(--st-accent))'
                : 'hsl(var(--st-ink-faint) / 0.4)',
            }}
          />
          <span className="truncate">{shortName(r.name)}</span>
          <span
            className="st-tip-value"
            style={r.id === focusId ? { color: 'hsl(var(--st-accent-ink))' } : { color: 'hsl(var(--st-ink))' }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function ProgressionChart({
  data, players, roster, selectedPlayerIds, onSelectedPlayerIdsChange,
  seasons, seasonId, onSeasonChange, stat, onStatChange, loading,
}: {
  data: ProgressionPoint[]
  /** The lines actually drawn — the explicit selection, or the top 8. */
  players: ProgressionPlayer[]
  /** Everyone selectable, ranked, for the player picker. */
  roster: { id: number; name: string; total: number }[]
  selectedPlayerIds: number[]
  onSelectedPlayerIdsChange: (ids: number[]) => void
  seasons: SeasonOption[]
  seasonId: number
  onSeasonChange: (id: number) => void
  stat: ProgressionStat
  onStatChange: (stat: ProgressionStat) => void
  loading: boolean
}) {
  const [pinnedId, setPinnedId] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<number | null>(null)

  // Derived rather than stored in an effect: when the selection changes, a
  // pinned id that is no longer on the chart simply stops matching and the
  // focus falls back to the leader. An effect resetting it would fight the
  // click that caused the change.
  const pinned = pinnedId != null && players.some(p => p.id === pinnedId) ? pinnedId : players[0]?.id ?? null
  const focusId = hoverId ?? pinned

  // Dimmed lines are painted first so the focused one lands on top. SVG has
  // no z-index; paint order is the only stacking there is.
  const ordered = useMemo(
    () => [...players].sort((a, b) => Number(a.id === focusId) - Number(b.id === focusId)),
    [players, focusId],
  )

  const last = data[data.length - 1]
  const seasonItems = [
    { id: ALL_SEASONS, label: 'All games' },
    ...seasons.map(s => ({ id: s.id, label: seasonLabel(s) })),
  ]

  return (
    <section className="st-panel">
      <div className="st-panel-head">
        <span className="st-overline">
          <ChartLine className="h-3.5 w-3.5" weight="bold" />
          Season progression
        </span>
        <SinglePicker
          items={seasonItems}
          selectedId={seasonId}
          onChange={onSeasonChange}
          placeholder="All games"
          emptyLabel="No seasons yet"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--st-rule))] px-3 py-2.5 sm:px-4">
        <div className="st-seg" role="group" aria-label="Progression stat">
          {STATS.map(t => (
            <button
              key={t.key}
              type="button"
              className="st-seg-btn"
              data-active={stat === t.key}
              aria-pressed={stat === t.key}
              onClick={() => onStatChange(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {roster.length > 0 && (
          <MultiPicker
            items={roster.map(p => ({ id: p.id, label: p.name, hint: String(p.total) }))}
            selectedIds={selectedPlayerIds}
            onChange={onSelectedPlayerIdsChange}
            placeholder="Top 8 players"
            emptyLabel="No players in this season"
            unit="players"
          />
        )}
      </div>

      <div className="p-3 sm:p-4">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="w-full" style={{ height: 220 }} />
            <div className="flex flex-wrap gap-2">
              {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-5 w-20" />)}
            </div>
          </div>
        ) : data.length === 0 || players.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center gap-3">
            <ChartLine className="h-8 w-8 opacity-25" weight="regular" />
            <p className="st-meta">No progression data yet</p>
            <p className="st-meta opacity-70">Pick a season with recorded games</p>
          </div>
        ) : (
          <>
            <div style={{ height: 224 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  {/* Horizontal hairlines only, at the same rule token every
                      seam in the scope uses. Not Recharts' stock dashed grey
                      grid — but a cumulative chart with no reference lines
                      is a shape you cannot read a value off. */}
                  <CartesianGrid
                    vertical={false}
                    stroke="hsl(var(--st-rule))"
                    strokeDasharray="0"
                  />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={8} tick={AXIS_TICK} />
                  <YAxis allowDecimals={false} width={38} axisLine={false} tickLine={false} tick={AXIS_TICK} />
                  <Tooltip
                    content={<ProgressionTooltip players={players} focusId={focusId} />}
                    cursor={{ stroke: 'hsl(var(--st-ink-faint) / 0.35)', strokeWidth: 1 }}
                  />
                  {ordered.map(p => {
                    const on = p.id === focusId
                    return (
                      <Line
                        key={p.id}
                        type="monotone"
                        dataKey={String(p.id)}
                        name={p.name}
                        stroke={on ? 'hsl(var(--st-accent))' : 'hsl(var(--st-ink) / 0.16)'}
                        strokeWidth={on ? 2.5 : 1.5}
                        dot={on ? { r: 2.5, strokeWidth: 0, fill: 'hsl(var(--st-accent))' } : false}
                        activeDot={on ? { r: 4, strokeWidth: 0 } : false}
                        isAnimationActive={false}
                      />
                    )
                  })}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* The legend is the focus control. Clicking pins a line, clicking
                it again releases back to the leader; hovering previews without
                committing, so scanning the pack costs no clicks. */}
            <div className="mt-3 flex flex-wrap gap-1" onMouseLeave={() => setHoverId(null)}>
              {players.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className="st-legend"
                  data-active={p.id === focusId}
                  aria-pressed={p.id === focusId}
                  onClick={() => setPinnedId(cur => (cur === p.id ? null : p.id))}
                  onMouseEnter={() => setHoverId(p.id)}
                  onFocus={() => setHoverId(p.id)}
                  onBlur={() => setHoverId(null)}
                >
                  <span
                    className="st-legend-swatch"
                    style={p.id === focusId ? { background: 'hsl(var(--st-accent))' } : undefined}
                  />
                  {shortName(p.name)}
                  <span className="opacity-60">{Number(last?.[String(p.id)] ?? 0)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
