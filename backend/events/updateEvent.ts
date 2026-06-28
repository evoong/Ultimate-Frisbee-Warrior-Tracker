type Params = {
  eventId: number
  playerId?: number | null
  relatedPlayerId?: number | null
}

export default async function(req: { params: Params; user: User }) {
  const { eventId, playerId, relatedPlayerId } = req.params
  
  const result = await retoolDb.query(
    'UPDATE game_events SET player_id = $1, related_player_id = $2 WHERE id = $3 RETURNING *',
    [playerId ?? null, relatedPlayerId ?? null, eventId]
  )
  return result.data[0]
}
