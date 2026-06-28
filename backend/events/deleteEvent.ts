type Params = {
  eventId: number
}

export default async function(req: { params: Params; user: User }) {
  const result = await retoolDb.query(
    'DELETE FROM game_events WHERE id = $1 RETURNING *',
    [req.params.eventId]
  )
  return result.data[0]
}
