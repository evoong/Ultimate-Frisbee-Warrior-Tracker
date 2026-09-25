import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { adminGet } from '../../lib/adminClient'
import AdminTable, { type AdminTableColumn } from '../../components/admin/AdminTable'
import { Button } from '../../lib/shadcn/button'
import { Input } from '../../lib/shadcn/input'
import { Label } from '../../lib/shadcn/label'

export type OrgRow = {
  id: number
  name: string
  is_public: boolean
  tier: string
  members: number
  created_at: string
  last_activity: string | null
}
export type OrgsPayload = { rows: OrgRow[]; total: number }

const PAGE_SIZE = 50
const DEBOUNCE_MS = 300

export default function Organizations() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  const q = searchParams.get('q') ?? ''
  const sortKey = searchParams.get('sort') ?? 'name'
  const sortDir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
  const page = Math.max(1, Number(searchParams.get('page')) || 1)

  const [input, setInput] = useState(q)
  const [data, setData] = useState<OrgsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  function setParams(patch: Record<string, string | null>) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) next.delete(key)
        else next.set(key, value)
      }
      return next
    })
  }

  // Back/forward changes q behind the input; mirror it so the field never
  // disagrees with the URL it restored from.
  useEffect(() => {
    setInput(prev => (prev === q ? prev : q))
  }, [q])

  // Typed input lands in the URL (and refetches) only after the debounce.
  useEffect(() => {
    if (input === q) return
    const timer = setTimeout(() => setParams({ q: input || null, page: '1' }), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input, q])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    params.set('sort', sortKey)
    params.set('dir', sortDir)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String((page - 1) * PAGE_SIZE))
    adminGet<OrgsPayload>(`/orgs?${params}`)
      .then(payload => { if (!cancelled) setData(payload) })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load organizations.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [q, sortKey, sortDir, page, reloadKey])

  const onSortChange = (key: string) => setParams({
    sort: key,
    dir: key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc',
    page: '1',
  })

  const columns: AdminTableColumn<OrgRow>[] = [
    { key: 'name', header: 'Name', sortable: true, render: row => row.name },
    { key: 'tier', header: 'Tier', sortable: true, render: row => row.tier },
    {
      key: 'members',
      header: 'Members',
      sortable: true,
      align: 'right',
      render: row => <span className="nav-mono">{row.members}</span>,
    },
    {
      key: 'visibility',
      header: 'Visibility',
      render: row => (
        <span className="inline-flex rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
          {row.is_public ? 'Public' : 'Private'}
        </span>
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: row => new Date(row.created_at).toLocaleDateString(),
    },
    {
      key: 'last_activity',
      header: 'Last activity',
      sortable: true,
      render: row => (row.last_activity ? new Date(row.last_activity).toLocaleDateString() : '—'),
    },
  ]

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Organizations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every organization on the platform. Click a row to open its detail page.
        </p>
      </div>
      <div className="max-w-xl">
        <Label htmlFor="admin-orgs-search" className="sr-only">Search organizations by name</Label>
        <Input
          id="admin-orgs-search"
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder="Search by name"
          autoComplete="off"
        />
      </div>
      {error ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">{error}</p>
          <Button variant="outline" size="sm" onClick={() => setReloadKey(key => key + 1)}>Retry</Button>
        </div>
      ) : (
        <AdminTable
          columns={columns}
          rows={data?.rows ?? []}
          total={data?.total ?? 0}
          page={page}
          pageSize={PAGE_SIZE}
          onPageChange={p => setParams({ page: String(p) })}
          sortKey={sortKey}
          sortDir={sortDir}
          onSortChange={onSortChange}
          loading={loading}
          onRowClick={row => navigate(`/admin/org/${row.id}`)}
          ariaLabel="Organizations"
        />
      )}
    </section>
  )
}
