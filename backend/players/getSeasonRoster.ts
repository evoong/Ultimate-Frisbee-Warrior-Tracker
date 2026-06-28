type Params = {
  gameId: number
}

type Player = {
  id: number
  display_name: string
  gender_match: string | null
  is_sub: boolean | null
}

export default async function(req: { params: Params; user: User }) {
  const { gameId } = req.params

  // Get the season_id for this game
  const gameResult = await retoolDb.query<{ season_id: number | null }>(
    'SELECT season_id FROM games WHERE id = $1',
    [gameId]
  )
  const seasonId = gameResult.data[0]?.season_id

  // If no season, fall back to all players
  if (!seasonId) {
    const all = await retoolDb.query<Player>(
      'SELECT id, display_name, gender_match, is_sub FROM players ORDER BY display_name'
    )
    return all.data
  }

  // Return players on this season's roster (active only)
  const rostered = await retoolDb.query<Player>(`
    SELECT p.id, p.display_name, p.gender_match, p.is_sub
    FROM players p
    INNER JOIN season_players sp ON sp.player_id = p.id
    WHERE sp.season_id = $1 AND sp.active = true
    ORDER BY p.display_name
  `, [seasonId])

  // If roster not configured, fall back to all players
  if (rostered.data.length > 0) {
    return rostered.data
  }

  const all = await retoolDb.query<Player>(
    'SELECT id, display_name, gender_match, is_sub FROM players ORDER BY display_name'
  )
  return all.data
}
