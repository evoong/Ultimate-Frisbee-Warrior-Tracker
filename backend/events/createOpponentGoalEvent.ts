type Params = {
  gameId: number
}

export default async function(req: { params: Params; user: User }) {
  const result = await retoolDb.query(
    'INSERT INTO game_events (game_id, event_type, event_timestamp) VALUES ($1, $2, NOW()) RETURNING *',
    [req.params.gameId, 'Opponent Goal']
  )
  return result.data[0]
}
