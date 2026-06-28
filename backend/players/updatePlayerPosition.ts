type Params = {
  playerId: number
  position: string | null
}

export default async function(req: { params: Params; user: User }) {
  const { playerId, position } = req.params

  const result = await retoolDb.query(
    'UPDATE players SET position = $1 WHERE id = $2',
    [position, playerId]
  )
  return result.data
}
