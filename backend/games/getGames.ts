type Game = {
  id: number
  opponent: string
  game_date: string
  game_time: string
  game_type: string
  our_score: number
  their_score: number
  result: string
  notes: string
}

export default async function() {
  const result = await retoolDb.query<Game>(
    'SELECT id, opponent, game_date, game_time, game_type, our_score, their_score, result, notes FROM games ORDER BY game_date DESC, game_time DESC'
  )
  return result.data
}
