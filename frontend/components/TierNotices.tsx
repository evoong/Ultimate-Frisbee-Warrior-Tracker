import React from 'react'

export function isArchivedGameDate(gameDate: string): boolean {
  // UTC so the cutoff matches the backend's gameDateWithinFreeWindow /
  // Postgres current_date comparison rather than drifting with the browser
  // timezone.
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const cutoff = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return gameDate < cutoff
}

export function FreeTierBanner({ tier }: { tier: string | null }) {
  if (tier !== 'free') return null
  return (
    <div className="p-3 border border-border bg-secondary/30 rounded-lg text-xs text-muted-foreground">
      Free tier: stats reflect the last 30 days. Upgrade for complete all-time history.
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
