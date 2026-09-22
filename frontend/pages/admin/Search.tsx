import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { adminGet } from '../../lib/adminClient'
import { Button } from '../../lib/shadcn/button'
import { Input } from '../../lib/shadcn/input'
import { Label } from '../../lib/shadcn/label'

type Results = {
  organizations: { id: number; name: string; is_public: boolean }[]
  users: { id: string; email: string; last_sign_in_at: string | null }[]
  players: { id: number; display_name: string; organization_id: number }[]
}

export default function Search() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const q = query.trim()
    setError(null)
    setResults(null)
    if (q.length < 2) {
      setError('Query must be at least 2 characters.')
      return
    }
    setLoading(true)
    try {
      setResults(await adminGet<Results>(`/search?q=${encodeURIComponent(q)}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.')
    } finally {
      setLoading(false)
    }
  }

  const empty = results && !results.organizations.length && !results.users.length && !results.players.length

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Support search</h1>
        <p className="mt-1 text-sm text-muted-foreground">Find organizations, user accounts, or player records.</p>
      </div>
      <form onSubmit={submit} className="flex max-w-xl gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor="admin-search" className="sr-only">Search</Label>
          <Input
            id="admin-search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Name or email"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!results && !error && <p className="text-sm text-muted-foreground">Search organizations, users, or players.</p>}
      {empty && <p className="text-sm text-muted-foreground">No matches for “{query.trim()}”.</p>}
      {results && !empty && (
        <div className="grid gap-6 lg:grid-cols-3">
          <ResultGroup title="Organizations" empty="No organizations found.">
            {results.organizations.map(org => (
              <Link key={org.id} to={`/admin/org/${org.id}`} className="block rounded border p-3 hover:bg-accent">
                <span className="font-medium">{org.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">#{org.id} · {org.is_public ? 'Public' : 'Private'}</span>
              </Link>
            ))}
          </ResultGroup>
          <ResultGroup title="Users" empty="No user accounts found.">
            {results.users.map(user => (
              <Link key={user.id} to={`/admin/user/${user.id}`} className="block rounded border p-3 hover:bg-accent">
                <span className="font-medium">{user.email}</span>
                <span className="block text-xs text-muted-foreground">Last sign-in: {user.last_sign_in_at ?? 'Never'}</span>
              </Link>
            ))}
          </ResultGroup>
          <ResultGroup title="Players" empty="No player records found.">
            {results.players.map(player => (
              <Link key={player.id} to={`/admin/org/${player.organization_id}`} className="block rounded border p-3 hover:bg-accent">
                <span className="font-medium">{player.display_name}</span>
                <span className="ml-2 text-xs text-muted-foreground">Player #{player.id} · Org #{player.organization_id}</span>
              </Link>
            ))}
          </ResultGroup>
        </div>
      )}
    </section>
  )
}

function ResultGroup({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children]
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {items.length ? <div className="space-y-2">{children}</div> : <p className="text-sm text-muted-foreground">{empty}</p>}
    </section>
  )
}
