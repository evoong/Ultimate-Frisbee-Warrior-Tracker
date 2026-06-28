type Params = {
  gameId: number
  playerId: number
}

export default async function(req: { params: Params; user: User }) {
  const result = await retoolDb.query(
    'INSERT INTO game_events (game_id, player_id, event_type, event_timestamp) VALUES ($1, $2, $3, NOW()) RETURNING *',
    [req.params.gameId, req.params.playerId, 'Turnover']
  )
  return result.data[0]
}
