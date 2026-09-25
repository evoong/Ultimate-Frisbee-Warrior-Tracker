import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import AdminTable, { type AdminTableColumn } from './AdminTable'

type Row = { id: number; name: string; count: number }

const columns: AdminTableColumn<Row>[] = [
  { key: 'name', header: 'Name', sortable: true, render: (r) => r.name },
  { key: 'count', header: 'Count', sortable: true, align: 'right', render: (r) => r.count },
  { key: 'fixed', header: 'Fixed', render: () => 'x' },
]

const rows: Row[] = [
  { id: 1, name: 'Alpha', count: 5 },
  { id: 2, name: 'Beta', count: 3 },
]

function setup(overrides: Partial<Parameters<typeof AdminTable<Row>>[0]> = {}) {
  const onSortChange = vi.fn()
  const onPageChange = vi.fn()
  const onRowClick = vi.fn()
  const props = {
    columns,
    rows,
    total: 120,
    page: 1,
    pageSize: 50,
    onPageChange,
    sortKey: 'name',
    sortDir: 'asc' as const,
    onSortChange,
    loading: false,
    onRowClick,
    ariaLabel: 'Organizations',
    ...overrides,
  }
  const utils = render(<AdminTable {...props} />)
  return { ...utils, props, onSortChange, onPageChange, onRowClick }
}

describe('AdminTable', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders headers and row cells', () => {
    setup()
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByRole('table', { name: 'Organizations' })).toBeTruthy()
  })

  it('emits aria-sort from sortKey/sortDir props', () => {
    const { props, rerender } = setup()
    const name = screen.getByRole('columnheader', { name: 'Name' })
    expect(name.getAttribute('aria-sort')).toBe('ascending')

    rerender(<AdminTable {...props} sortDir="desc" />)
    expect(screen.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort')).toBe('descending')
    expect(screen.getByRole('columnheader', { name: 'Count' }).getAttribute('aria-sort')).toBe('none')
    expect(screen.getByRole('columnheader', { name: 'Fixed' }).getAttribute('aria-sort')).toBe('none')
  })

  it('clicking a sortable header calls onSortChange with its key', () => {
    const { onSortChange } = setup()
    fireEvent.click(screen.getByRole('button', { name: /count/i }))
    expect(onSortChange).toHaveBeenCalledWith('count')
  })

  it('non-sortable headers render no button', () => {
    setup()
    expect(screen.queryByRole('button', { name: /fixed/i })).toBeNull()
  })

  it('footer shows range and prev/next bounds', () => {
    setup()
    expect(screen.getByText('1–2 of 120')).toBeTruthy()
    expect(screen.getByRole('button', { name: /previous/i }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByRole('button', { name: /next/i }).hasAttribute('disabled')).toBe(false)
  })

  it('next disabled on last page; prev calls onPageChange', () => {
    const page3 = Array.from({ length: 20 }, (_, i) => ({ id: i + 101, name: `Org ${i + 101}`, count: i }))
    const { onPageChange } = setup({ page: 3, rows: page3 })
    expect(screen.getByText('101–120 of 120')).toBeTruthy()
    expect(screen.getByRole('button', { name: /next/i }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /previous/i }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('loading renders skeleton rows instead of data', () => {
    setup({ loading: true })
    expect(screen.queryByText('Alpha')).toBeNull()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(8)
    expect(document.querySelector('tbody [data-skeleton]')).toBeTruthy()
  })

  it('row click (mouse) calls onRowClick with row', () => {
    const { onRowClick } = setup()
    fireEvent.click(screen.getByText('Beta'))
    expect(onRowClick).toHaveBeenCalledWith({ id: 2, name: 'Beta', count: 3 })
  })

  it('row is keyboard-activatable via Enter and Space', () => {
    const { onRowClick } = setup()
    const tr = screen.getByText('Alpha').closest('tr') as HTMLTableRowElement
    expect(tr.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(tr, { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(tr, { key: ' ' })
    expect(onRowClick).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(tr, { key: 'ArrowDown' })
    expect(onRowClick).toHaveBeenCalledTimes(2)
  })

  it('without onRowClick rows are not focusable or clickable', () => {
    const { onRowClick, rerender, props } = setup()
    rerender(<AdminTable {...props} onRowClick={undefined} />)
    const tr = screen.getByText('Alpha').closest('tr') as HTMLTableRowElement
    expect(tr.hasAttribute('tabindex')).toBe(false)
    fireEvent.click(screen.getByText('Alpha'))
    fireEvent.keyDown(tr, { key: 'Enter' })
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
