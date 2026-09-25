import React from 'react'

export function isArchivedGameDate(gameDate: string): boolean {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return gameDate < cutoff
}

export function FreeTierBanner({ tier }: { tier: string | null }) {
  if (tier !== 'free') return null
  return (
    <div className="p-3 border border-border bg-secondary/30 rounded-lg text-xs text-muted-foreground">
      Free tier: stats reflect the last 30 days. Upgrade for complete history.
    </div>
  )
}

export function ArchivedBoxScoreNotice({ tier, gameDate }: { tier: string | null; gameDate: string }) {
  if (tier !== 'free' || !isArchivedGameDate(gameDate)) return null
  return (
    <div className="text-center p-6 text-xs text-muted-foreground border border-dashed border-border rounded-lg">
      Detailed stats for this game are archived on the Free plan. Upgrade to view box scores.
    </div>
  )
}
