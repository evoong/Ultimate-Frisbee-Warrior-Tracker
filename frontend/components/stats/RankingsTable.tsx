import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaretDown, CaretUp, CaretUpDown, Check, Plus, SlidersHorizontal, Trash } from '@phosphor-icons/react'
import { Popover, PopoverContent, PopoverTrigger } from '../../lib/shadcn/popover'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { SinglePicker } from './Picker'
import {
  COLUMN_WIDTHS_KEY, CUSTOM_COLUMNS_KEY, DEFAULT_COLUMNS, HIDDEN_COLUMNS_KEY,
  MIN_PLAYER_COLUMN_WIDTH, MIN_STAT_COLUMN_WIDTH, STAT_LABELS, VISIBLE_STAT_KEYS,
  compareByColumn, defaultWidthFor, formatColumnValue, getColumnValue, isColumnAvailable,
  type ColumnConfig, type ColumnTerm, type StatKey,
} from './columns'
import type { PlayerLine } from './types'
import './stats-theme.css'

// The rankings grid. It owns everything about how it is displayed — which
// columns are visible, how wide they are, how they are sorted, and any
// formula columns the user has built — because all of that is a per-device
// viewing preference stored in localStorage, not app state anyone else ever
// sees. Keeping it here took ~120 lines of state and handlers out of
// PlayerStatsView, which is about the stats, not about a table's chrome.

// Sentinels for the two sort choices that are not columns. Deliberately not
// -1: `allColumns.findIndex` returns -1 for a column that no longer exists,
// and a sentinel colliding with that would make a stale sort silently read
// back as "no sort" while the table stayed sorted.
const SORT_NONE = -100
const SORT_PLAYER = -101

export default function RankingsTable({ players, loading }: {
  players: PlayerLine[]
  loading: boolean
}) {
  const [customColumns, setCustomColumns] = useState<ColumnConfig[]>(() => {
    try { return JSON.parse(localStorage.getItem(CUSTOM_COLUMNS_KEY) ?? '[]') } catch { return [] }
  })
  const [hiddenColumnIds, setHiddenColumnIds] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_COLUMNS_KEY) ?? '[]')) } catch { return new Set() }
  })
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) ?? '{}') } catch { return {} }
  })

  // Primary sort also drives the header-click quick-sort; secondary is a
  // tiebreaker only, picked explicitly in this popover. Clicking a header
  // always targets primary, never secondary.
  const [sortColumnId, setSortColumnId] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [sortColumnId2, setSortColumnId2] = useState<string | null>(null)
  const [sortDir2, setSortDir2] = useState<'asc' | 'desc'>('desc')

  const [newColStatA, setNewColStatA] = useState<StatKey>('goals')
  const [newColOp, setNewColOp] = useState<'+' | '-'>('+')
  const [newColStatB, setNewColStatB] = useState<StatKey | null>(null)
  const [newColPerGame, setNewColPerGame] = useState(false)

  useEffect(() => { localStorage.setItem(CUSTOM_COLUMNS_KEY, JSON.stringify(customColumns)) }, [customColumns])
  useEffect(() => { localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hiddenColumnIds])) }, [hiddenColumnIds])
  useEffect(() => { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths)) }, [columnWidths])

  // Custom columns are filtered, not pruned: one built from a stat that is
  // currently gated off drops out of the table and out of the manage list,
  // and comes back untouched the day the stat does.
  const allColumns = useMemo(
    () => [...DEFAULT_COLUMNS, ...customColumns.filter(isColumnAvailable)],
    [customColumns],
  )
  const visibleColumns = allColumns.filter(c => !hiddenColumnIds.has(c.id))
  const widthOf = (id: string) => columnWidths[id] ?? defaultWidthFor(id, allColumns)

  const rows = useMemo(() => {
    const arr = [...players]
    if (!sortColumnId) return arr
    arr.sort((a, b) => {
      const primary = compareByColumn(sortColumnId, sortDir, allColumns, a, b)
      if (primary !== 0) return primary
      if (sortColumnId2 && sortColumnId2 !== sortColumnId) return compareByColumn(sortColumnId2, sortDir2, allColumns, a, b)
      return 0
    })
    return arr
  }, [players, sortColumnId, sortDir, sortColumnId2, sortDir2, allColumns])

  const handleSortClick = (colId: string) => {
    if (sortColumnId === colId) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortColumnId(colId); setSortDir('desc') }
  }

  const toggleColumnVisibility = (id: string) => setHiddenColumnIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const handleAddCustomColumn = () => {
    const terms: ColumnTerm[] = [{ stat: newColStatA, sign: 1 }]
    if (newColStatB) terms.push({ stat: newColStatB, sign: newColOp === '+' ? 1 : -1 })
    const label = terms.map((t, i) => (i > 0 ? (t.sign > 0 ? '+' : '-') : '') + STAT_LABELS[t.stat]).join('')
      + (newColPerGame ? '/gm' : '')
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setCustomColumns(cols => [...cols, { id, label, color: '', terms, perGame: newColPerGame }])
    setNewColStatB(null)
    setNewColPerGame(false)
  }

  const handleRemoveCustomColumn = (id: string) => {
    setCustomColumns(cols => cols.filter(c => c.id !== id))
    if (sortColumnId === id) setSortColumnId(null)
    if (sortColumnId2 === id) setSortColumnId2(null)
  }

  // Column resize. Start and end are fixed relative to the pointer's original
  // position rather than accumulated per move, so a fast drag cannot drift —
  // the same window-listener pattern the schedule's lineup reordering uses.
  const resizingRef = useRef<{ id: string; startX: number; startWidth: number } | null>(null)
  const handleResizeMove = useCallback((e: PointerEvent) => {
    const r = resizingRef.current
    if (!r) return
    const min = r.id === 'player_name' ? MIN_PLAYER_COLUMN_WIDTH : MIN_STAT_COLUMN_WIDTH
    setColumnWidths(w => ({ ...w, [r.id]: Math.max(min, r.startWidth + (e.clientX - r.startX)) }))
  }, [])
  const handleResizeEnd = useCallback(() => {
    resizingRef.current = null
    window.removeEventListener('pointermove', handleResizeMove)
    window.removeEventListener('pointerup', handleResizeEnd)
  }, [handleResizeMove])
  const handleResizeStart = (id: string, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizingRef.current = { id, startX: e.clientX, startWidth: widthOf(id) }
    window.addEventListener('pointermove', handleResizeMove)
    window.addEventListener('pointerup', handleResizeEnd)
  }

  const sortGlyph = (id: string) => sortColumnId === id
    ? (sortDir === 'asc' ? <CaretUp className="h-3 w-3" weight="bold" /> : <CaretDown className="h-3 w-3" weight="bold" />)
    : <CaretUpDown className="st-sort-idle h-3 w-3" weight="bold" />

  // The sort pickers speak in ids, but SinglePicker is numeric, so the two
  // non-column choices get sentinel ids rather than a parallel string API.
  const sortItems = (noneLabel: string) => [
    { id: SORT_NONE, label: noneLabel },
    { id: SORT_PLAYER, label: 'Player' },
    ...allColumns.map((c, i) => ({ id: i, label: c.label })),
  ]
  const sortIdFor = (colId: string | null) => {
    if (colId == null) return SORT_NONE
    if (colId === 'player_name') return SORT_PLAYER
    const i = allColumns.findIndex(c => c.id === colId)
    return i === -1 ? SORT_NONE : i
  }
  const colIdFor = (pickerId: number) =>
    pickerId === SORT_NONE ? null : pickerId === SORT_PLAYER ? 'player_name' : allColumns[pickerId]?.id ?? null

  return (
    <section className="st-panel">
      <div className="st-panel-head">
        <span className="st-overline">Player rankings</span>

        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="st-btn">
              <SlidersHorizontal className="h-3.5 w-3.5" weight="bold" />
              Columns
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="stats-scope w-[19rem] rounded-md border-0 bg-transparent p-0 shadow-none"
          >
            <div className="st-tip max-h-[26rem] space-y-3 overflow-y-auto p-2.5">
              <div className="space-y-0.5">
                <p className="st-overline px-1 pb-1">Show columns</p>
                {allColumns.map(col => {
                  const shown = !hiddenColumnIds.has(col.id)
                  return (
                    <div key={col.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        className="st-option flex-1"
                        data-checked={shown}
                        aria-pressed={shown}
                        onClick={() => toggleColumnVisibility(col.id)}
                      >
                        <span className="st-option-box">
                          <Check className="h-2.5 w-2.5" weight="bold" />
                        </span>
                        <span className={`min-w-0 flex-1 truncate ${col.color}`}>
                          <span className="st-series-ink">{col.label}</span>
                        </span>
                      </button>
                      {!col.builtin && (
                        <button
                          type="button"
                          className="st-btn st-btn--icon"
                          style={{ height: '1.75rem', width: '1.75rem' }}
                          onClick={() => handleRemoveCustomColumn(col.id)}
                          aria-label={`Delete the ${col.label} column`}
                          title={`Delete the ${col.label} column`}
                        >
                          <Trash className="h-3.5 w-3.5" weight="bold" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="space-y-2 border-t border-[hsl(var(--st-rule))] pt-2.5">
                <p className="st-overline px-1">Sort</p>
                <div className="flex items-center gap-1.5">
                  <SinglePicker
                    items={sortItems('Default order')}
                    selectedId={sortIdFor(sortColumnId)}
                    onChange={id => setSortColumnId(colIdFor(id))}
                    placeholder="Sort by"
                    emptyLabel="No columns"
                  />
                  <button
                    type="button"
                    className="st-btn st-btn--icon"
                    disabled={!sortColumnId}
                    onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
                    aria-label={sortDir === 'asc' ? 'Sort ascending' : 'Sort descending'}
                  >
                    {sortDir === 'asc' ? <CaretUp className="h-3.5 w-3.5" weight="bold" /> : <CaretDown className="h-3.5 w-3.5" weight="bold" />}
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <SinglePicker
                    items={sortItems('None')}
                    selectedId={sortIdFor(sortColumnId2)}
                    onChange={id => setSortColumnId2(colIdFor(id))}
                    placeholder="Then by"
                    emptyLabel="No columns"
                  />
                  <button
                    type="button"
                    className="st-btn st-btn--icon"
                    disabled={!sortColumnId || !sortColumnId2}
                    onClick={() => setSortDir2(d => (d === 'asc' ? 'desc' : 'asc'))}
                    aria-label={sortDir2 === 'asc' ? 'Then ascending' : 'Then descending'}
                  >
                    {sortDir2 === 'asc' ? <CaretUp className="h-3.5 w-3.5" weight="bold" /> : <CaretDown className="h-3.5 w-3.5" weight="bold" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2 border-t border-[hsl(var(--st-rule))] pt-2.5">
                <p className="st-overline px-1">Add a formula column</p>
                <div className="flex items-center gap-1.5">
                  <div className="st-seg">
                    {VISIBLE_STAT_KEYS.map(k => (
                      <button key={k} type="button" className="st-seg-btn" data-active={newColStatA === k} onClick={() => setNewColStatA(k)}>
                        {STAT_LABELS[k]}
                      </button>
                    ))}
                  </div>
                  <div className="st-seg">
                    {(['+', '-'] as const).map(op => (
                      <button key={op} type="button" className="st-seg-btn" data-active={newColOp === op} onClick={() => setNewColOp(op)}>
                        {op}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Three segmented controls instead of three <Select>s: with
                    a handful of options apiece, a dropdown hides the whole
                    choice behind a click to save no space at all. */}
                <div className="st-seg">
                  <button type="button" className="st-seg-btn" data-active={newColStatB === null} onClick={() => setNewColStatB(null)}>
                    None
                  </button>
                  {VISIBLE_STAT_KEYS.map(k => (
                    <button key={k} type="button" className="st-seg-btn" data-active={newColStatB === k} onClick={() => setNewColStatB(k)}>
                      {STAT_LABELS[k]}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="st-option flex-1"
                    data-checked={newColPerGame}
                    aria-pressed={newColPerGame}
                    onClick={() => setNewColPerGame(v => !v)}
                  >
                    <span className="st-option-box">
                      <Check className="h-2.5 w-2.5" weight="bold" />
                    </span>
                    <span className="flex-1">Per game</span>
                  </button>
                  <button type="button" className="st-btn st-btn--accent" onClick={handleAddCustomColumn}>
                    <Plus className="h-3.5 w-3.5" weight="bold" />
                    Add
                  </button>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {loading ? (
        <div className="space-y-2.5 p-4">
          {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-5" />)}
        </div>
      ) : players.length === 0 ? (
        <p className="st-meta p-8 text-center">No players in this range</p>
      ) : (
        <div className="st-scroll">
          <table className="st-table">
            <thead>
              <tr>
                {/* The rank gutter is row position, not a stored rank: sort by
                    turnovers and "1" has to mean the top of what is on screen,
                    or the column is lying about the order you just chose. */}
                <th className="st-th" style={{ width: 34 }}>#</th>
                <th className="st-th st-th--left relative" style={{ width: widthOf('player_name') }}>
                  <button type="button" className="st-sort" data-active={sortColumnId === 'player_name'} onClick={() => handleSortClick('player_name')}>
                    Player
                    {sortGlyph('player_name')}
                  </button>
                  <span className="st-resize" onPointerDown={e => handleResizeStart('player_name', e)} />
                </th>
                {visibleColumns.map(col => (
                  <th key={col.id} className={`st-th relative ${col.color}`} style={{ width: widthOf(col.id) }}>
                    <button type="button" className="st-sort" data-active={sortColumnId === col.id} onClick={() => handleSortClick(col.id)}>
                      {sortGlyph(col.id)}
                      {col.label}
                    </button>
                    <span className="st-resize" onPointerDown={e => handleResizeStart(col.id, e)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.playerId} className="st-tr">
                  <td className="st-td" style={{ color: 'hsl(var(--st-ink-faint))', fontWeight: 500, fontSize: '0.6875rem' }}>{i + 1}</td>
                  <td className="st-td st-td--left" style={{ width: widthOf('player_name'), overflow: 'hidden' }}>
                    <span className="st-name" title={p.name}>{p.name}</span>
                  </td>
                  {visibleColumns.map(col => (
                    <td key={col.id} className={`st-td ${col.color}`} style={{ width: widthOf(col.id) }}>
                      {formatColumnValue(col, getColumnValue(col, p))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
