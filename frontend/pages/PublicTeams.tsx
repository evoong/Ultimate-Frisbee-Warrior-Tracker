import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

type PublicTeam = { id: number; name: string; photo_url: string | null }

export default function PublicTeams() {
  const { switchTeam } = useAuth()
  const [teams, setTeams] = useState<PublicTeam[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // No is_public filter needed: the read policy already limits this to
    // public teams plus any the caller belongs to. Filtering here as well
    // would imply the client is the thing enforcing it.
    supabase
      .from('organizations')
      .select('id,name,photo_url')
      .order('name')
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setTeams((data ?? []) as PublicTeam[])
      })
  }, [])

  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>
  if (!teams) return <p className="p-6 text-sm text-muted-foreground">Loading teams…</p>
  if (teams.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No teams have made themselves public yet.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-2 p-6">
      <h1 className="text-lg font-semibold">Public teams</h1>
      {teams.map(t => (
        <button
          key={t.id}
          onClick={() => switchTeam(t.id)}
          className="flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-muted"
        >
          {t.photo_url && <img src={t.photo_url} alt="" className="h-8 w-8 rounded-full object-cover" />}
          <span>{t.name}</span>
        </button>
      ))}
    </div>
  )
}
