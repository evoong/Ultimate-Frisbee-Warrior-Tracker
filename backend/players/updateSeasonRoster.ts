type Params = {
  seasonId: number
  playerIds: number[]
}

export default async function(req: { params: Params; user: User }) {
  const { seasonId, playerIds } = req.params

  // Delete existing roster for this season
  await retoolDb.query('DELETE FROM season_rosters WHERE season_id = $1', [seasonId])

  // Insert each player one at a time to avoid dynamic placeholder construction
  for (const playerId of playerIds) {
    await retoolDb.query(
      'INSERT INTO season_rosters (season_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [seasonId, playerId]
    )
  }

  return { success: true, seasonId, count: playerIds.length }
}
