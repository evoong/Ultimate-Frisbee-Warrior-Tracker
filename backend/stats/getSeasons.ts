type Season = {
  season_id: number
  game_count: number
}

export default async function() {
  const result = await retoolDb.query<Season>(
    `SELECT 
      season_id, 
      COUNT(*) as game_count 
    FROM games 
    WHERE season_id IS NOT NULL 
    GROUP BY season_id 
    ORDER BY season_id DESC`
  )
  return result.data
}
