type Params = {
  opponent: string
  game_date: string
  game_time: string
  game_type: string
}

export default async function(req: { params: Params; user: User }) {
  const result = await retoolDb.query(
    'INSERT INTO games (opponent, game_date, game_time, game_type, our_score, their_score, season_id) VALUES ($1, $2, $3, $4, 0, 0, 2) RETURNING *',
    [req.params.opponent, req.params.game_date, req.params.game_time, req.params.game_type]
  )
  return result.data[0]
}
