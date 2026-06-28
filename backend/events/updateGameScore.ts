type Params = {
  gameId: number
  ourScore: number
  theirScore: number
}

export default async function(req: { params: Params; user: User }) {
  const result = await retoolDb.query(
    'UPDATE games SET our_score = $1, their_score = $2 WHERE id = $3 RETURNING *',
    [req.params.ourScore, req.params.theirScore, req.params.gameId]
  )
  return result.data[0]
}
