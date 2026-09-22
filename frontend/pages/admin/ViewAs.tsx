import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { adminGet } from '../../lib/adminClient'
import { Button } from '../../lib/shadcn/button'
import { Skeleton } from '../../lib/shadcn/skeleton'

type ViewAsData = {
  user: { id: string; email: string }
  memberships: { organization_id: number; name: string; role: string }[]
  playerLinks?: { player_id: number; display_name: string; organization_id: number }[]
}

export default function ViewAs({ userId: propUserId }: { userId?: string }) {
  const { userId: paramUserId } = useParams<{ userId: string }>()
  const userId = propUserId ?? paramUserId!
  const navigate = useNavigate()
  const [data, setData] = useState<ViewAsData | null>(null)

  useEffect(() => {
    adminGet<ViewAsData>(`/user/${userId}`).then(setData)
  }, [userId])

  if (!data) return <Skeleton className="m-6 h-64" />

  return (
    <main className="min-h-screen bg-background">
      <div className="sticky top-0 z-50 flex items-center justify-between border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <strong>Viewing as {data.user.email} — read-only preview</strong>
        <Button variant="outline" size="sm" onClick={() => navigate('/admin')}>Exit view-as</Button>
      </div>
      <section className="mx-auto max-w-3xl space-y-6 p-6">
        <div>
          <h1 className="text-xl font-semibold">{data.user.email}</h1>
          <p className="text-sm text-muted-foreground">Customer account preview. Writes remain unavailable.</p>
        </div>
        <section>
          <h2 className="mb-2 font-semibold">Teams</h2>
          {data.memberships.length ? (
            <ul className="divide-y rounded border">
              {data.memberships.map(team => <li key={team.organization_id} className="flex justify-between p-3"><span>{team.name}</span><span className="capitalize text-muted-foreground">{team.role}</span></li>)}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No team memberships.</p>}
        </section>
        {data.playerLinks && <section>
          <h2 className="mb-2 font-semibold">Player links</h2>
          {data.playerLinks.length ? (
            <ul className="divide-y rounded border">
              {data.playerLinks.map(player => <li key={player.player_id} className="p-3">{player.display_name}</li>)}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No player links.</p>}
        </section>}
      </section>
    </main>
  )
}
