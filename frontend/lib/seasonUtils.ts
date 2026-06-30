type SeasonLike = { id: number; organizer: string | null; start_date: string | null; end_date: string | null }

/**
 * Returns the id of the most relevant Jam season:
 * 1. Currently active (today within start_date..end_date; null end_date = open-ended)
 * 2. Next upcoming (earliest future start_date)
 * 3. Most recently ended (latest past end_date)
 * Falls back to `fallbackId` if no Jam seasons exist.
 */
export function getDefaultJamSeasonId(allSeasons: SeasonLike[], fallbackId?: number): number | undefined {
  const today = new Date().toISOString().slice(0, 10)
  const jam = allSeasons.filter(s => s.organizer === 'Jam')
  const active = jam.find(s => s.start_date && s.start_date <= today && (s.end_date == null || today <= s.end_date))
  const upcoming = jam.filter(s => s.start_date && s.start_date > today).sort((a, b) => a.start_date!.localeCompare(b.start_date!))[0]
  const ended = jam.filter(s => s.end_date && s.end_date < today).sort((a, b) => b.end_date!.localeCompare(a.end_date!))[0]
  return (active ?? upcoming ?? ended)?.id ?? fallbackId
}
