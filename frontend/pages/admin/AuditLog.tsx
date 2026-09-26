import { useCallback, useEffect, useState } from 'react'
import { AdminRequestError, adminGet } from '../../lib/adminClient'

interface AuditRow {
  id: number
  at: string
  admin_id: string
  admin_role: string
  operation: string
  target: unknown
  before: unknown
  after: unknown
  result: 'ok' | 'denied' | 'error'
  error: string | null
  request_id: string | null
}

const RESULT_CLASS: Record<AuditRow['result'], string> = {
  ok: 'border-border',
  denied: 'border-amber-500/50',
  error: 'border-destructive/50',
}

export default function AdminAuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  // True from mount: a fetch is in flight the moment the page mounts, and
  // the lazy route means that first paint is observable — busy=false here
  // flashed "No entries yet." over the in-flight load (and let tests latch
  // the transient node before busy detached it). Same pattern as
  // Organizations/Flags' loading useState(true).
  const [busy, setBusy] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)

  const load = useCallback(async (reset: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (filter) params.set('operation', filter)
      if (!reset && cursor) params.set('cursor', cursor)
      const res = await adminGet<{ rows: AuditRow[]; next_cursor: string | null }>(
        `/audit?${params.toString()}`
      )
      setRows(prev => (reset ? res.rows : [...prev, ...res.rows]))
      setCursor(res.next_cursor)
    } catch (err) {
      setError((err as AdminRequestError).message)
    } finally {
      setBusy(false)
    }
  }, [cursor, filter])

  useEffect(() => {
    void load(true)
  }, [filter])

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="admin-audit-operation">Filter by operation</label>
        <select
          id="admin-audit-operation"
          className="rounded border bg-background px-2 py-1 text-sm"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        >
          <option value="">all</option>
          {['set_member_role', 'remove_member', 'invite_member', 'revoke_invite',
            'set_player_link', 'approve_player_link', 'merge_players', 'delete_org']
            .map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <ul className="flex flex-col gap-2">
        {rows.map(r => (
          <li key={r.id} className={`rounded border ${RESULT_CLASS[r.result]} p-3`}>
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-semibold">{r.operation}</code>
              <span className="rounded border px-1.5 py-0.5 text-xs">{r.result}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(r.at).toLocaleString()} · {r.admin_role} ·
                <code>{r.admin_id.slice(0, 8)}</code>
              </span>
              <button
                className="ml-auto rounded border px-2 py-0.5 text-xs"
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              >
                {expanded === r.id ? 'Hide' : 'Details'}
              </button>
            </div>

            {r.error && <p className="mt-2 text-xs text-destructive">{r.error}</p>}

            {expanded === r.id && (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">
                {JSON.stringify({ target: r.target, before: r.before, after: r.after, request_id: r.request_id }, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>

      {rows.length === 0 && !busy && (
        <p className="text-muted-foreground">No entries yet.</p>
      )}

      {cursor && (
        <button
          className="self-start rounded border px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={busy}
          onClick={() => void load(false)}
        >
          {busy ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}