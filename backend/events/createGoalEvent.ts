type Params = {
  gameId: number
  playerId: number | null
  relatedPlayerId: number | null
  eventType?: string
  notes?: string
}

export default async function(req: { params: Params; user: User }) {
  const result = await retoolDb.query(
    'INSERT INTO game_events (game_id, player_id, related_player_id, event_type, notes, event_timestamp) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
    [req.params.gameId, req.params.playerId, req.params.relatedPlayerId, req.params.eventType ?? 'Goal', req.params.notes ?? null]
  )
  return result.data[0]
}
