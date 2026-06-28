type Params = {
  displayName: string
  gameId: number
}

type Player = {
  id: number
  display_name: string
  first_name: string | null
  last_name: string | null
}

export default async function(req: { params: Params; user: User }) {
  const { displayName, gameId } = req.params

  // Get the season for this game
  const gameResult = await retoolDb.query<{ season_id: number | null }>(
    'SELECT season_id FROM games WHERE id = $1',
    [gameId]
  )
  const seasonId = gameResult.data[0]?.season_id

  // Create the player (flagged as a sub)
  const playerResult = await retoolDb.query<Player>(
    'INSERT INTO players (display_name, first_name, is_sub) VALUES ($1, $2, true) RETURNING *',
    [displayName, displayName]
  )
  const player = playerResult.data[0]
  if (!player) throw new Error('Failed to create player')

  // Add to season roster if there's a season
  if (seasonId) {
    await retoolDb.query(
      'INSERT INTO season_players (season_id, player_id, active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING',
      [seasonId, player.id]
    )
  }

  return player
}
