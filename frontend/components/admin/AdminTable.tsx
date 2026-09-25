import type { KeyboardEvent, ReactNode } from 'react'
import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '../../lib/shadcn/button'
import { Skeleton } from '../../lib/shadcn/skeleton'
import { cn } from '../../lib/shadcn/utils'

export type AdminTableColumn<T> = {
  key: string
  header: string
  sortable?: boolean
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
}

export type AdminTableProps<T> = {
  columns: AdminTableColumn<T>[]
  rows: T[]
  total: number
  page: number
  pageSize: number
  onPageChange: (p: number) => void
  sortKey: string
  sortDir: 'asc' | 'desc'
  onSortChange: (key: string) => void
  loading: boolean
  onRowClick?: (row: T) => void
  ariaLabel: string
}

const SKELETON_ROWS = 8

export default function AdminTable<T extends { id: string | number }>({
  columns,
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  sortKey,
  sortDir,
  onSortChange,
  loading,
  onRowClick,
  ariaLabel,
}: AdminTableProps<T>) {
  const first = (page - 1) * pageSize + 1
  const last = first - 1 + rows.length
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const range = rows.length === 0 ? `0 of ${total}` : `${first}–${last} of ${total}`

  const rowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onRowClick?.(row)
  }

  return (
    <div className="rounded border">
      <table className="w-full text-sm" aria-label={ariaLabel}>
        <thead>
          <tr className="border-b bg-muted/50 text-left">
            {columns.map((col) => {
              const sorted = col.key === sortKey
              const ariaSort = !col.sortable || !sorted ? 'none' : sortDir === 'asc' ? 'ascending' : 'descending'
              const SortIcon = !col.sortable ? null : !sorted ? ArrowUpDown : sortDir === 'asc' ? ChevronUp : ChevronDown
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn('p-3', col.align === 'right' && 'text-right')}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                      onClick={() => onSortChange(col.key)}
                    >
                      {col.header}
                      {SortIcon && <SortIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: Math.min(pageSize, SKELETON_ROWS) }, (_, i) => (
                <tr key={i} className="border-b">
                  {columns.map((col) => (
                    <td key={col.key} className={cn('p-3', col.align === 'right' && 'text-right')}>
                      <Skeleton data-skeleton className="h-4 w-full max-w-24" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn('border-b', onRowClick && 'cursor-pointer hover:bg-muted/50')}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => rowKeyDown(e, row) : undefined}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn('p-3', col.align === 'right' && 'text-right')}>
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between border-t p-3">
        <span className="text-xs text-muted-foreground">{range}</span>
        <div className="space-x-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page >= lastPage} onClick={() => onPageChange(page + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
