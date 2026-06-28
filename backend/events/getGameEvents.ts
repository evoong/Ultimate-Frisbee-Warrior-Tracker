type Params = {
  gameId: number
}

type GameEvent = {
  id: number
  game_id: number
  player_id: number | null
  related_player_id: number | null
  event_type: string
  point_number: number
  event_timestamp: string
  notes: string | null
}

export default async function(req: { params: Params; user: User }) {
  const result = await retoolDb.query<GameEvent>(
    'SELECT * FROM game_events WHERE game_id = $1 ORDER BY event_timestamp DESC',
    [req.params.gameId]
  )
  return result.data
}
