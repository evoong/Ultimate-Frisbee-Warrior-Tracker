type Params = {
  playerId: number
  gameId: number
}

export default async function(req: { params: Params; user: User }) {
  const { playerId, gameId } = req.params

  // Only allow deleting players marked as subs
  const check = await retoolDb.query<{ is_sub: boolean }>(
    'SELECT is_sub FROM players WHERE id = $1',
    [playerId]
  )
  const player = check.data[0]
  if (!player?.is_sub) {
    throw new Error('Cannot delete a player that is not a sub')
  }

  // Get season for this game (skip if gameId is 0 — roster-level delete)
  const seasonId = gameId > 0 ? (() => {
    return retoolDb.query<{ season_id: number | null }>(
      'SELECT season_id FROM games WHERE id = $1',
      [gameId]
    ).then(r => r.data[0]?.season_id ?? null)
  })() : Promise.resolve(null)

  const resolvedSeasonId = await seasonId

  // Remove from ALL season rosters if no specific game, else just that season
  if (resolvedSeasonId) {
    await retoolDb.query(
      'DELETE FROM season_players WHERE player_id = $1 AND season_id = $2',
      [playerId, resolvedSeasonId]
    )
  } else {
    await retoolDb.query(
      'DELETE FROM season_players WHERE player_id = $1',
      [playerId]
    )
  }

  // Check if this sub has any recorded events
  const eventsCheck = await retoolDb.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM game_events WHERE player_id = $1 OR related_player_id = $2',
    [playerId, playerId]
  )
  const eventCount = parseInt(eventsCheck.data[0]?.count ?? '0')

  // Fully delete the player record only if they have no events
  if (eventCount === 0) {
    await retoolDb.query('DELETE FROM players WHERE id = $1', [playerId])
  }

  return { success: true, fullyDeleted: eventCount === 0 }
}
