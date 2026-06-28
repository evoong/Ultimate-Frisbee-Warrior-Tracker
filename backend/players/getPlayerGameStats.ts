type Params = {
  playerId: number
}

type PlayerGameStat = {
  game_id: number
  opponent: string
  game_date: string
  game_type: string
  season_id: number | null
  goals: number
  assists: number
  turnovers: number
}

export default async function(req: { params: Params; user: User }) {
  const { playerId } = req.params

  const result = await retoolDb.query<PlayerGameStat>(`
    SELECT
      g.id as game_id,
      g.opponent,
      g.game_date,
      g.game_type,
      g.season_id,
      COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.player_id = $1 THEN ge.id END) as goals,
      COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.related_player_id = $2 THEN ge.id END) as assists,
      COUNT(DISTINCT CASE WHEN ge.event_type = 'Turnover' AND ge.player_id = $3 THEN ge.id END) as turnovers
    FROM games g
    LEFT JOIN game_events ge ON ge.game_id = g.id
    GROUP BY g.id, g.opponent, g.game_date, g.game_type, g.season_id
    HAVING
      COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.player_id = $4 THEN ge.id END) > 0
      OR COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.related_player_id = $5 THEN ge.id END) > 0
      OR COUNT(DISTINCT CASE WHEN ge.event_type = 'Turnover' AND ge.player_id = $6 THEN ge.id END) > 0
    ORDER BY g.game_date DESC
  `, [playerId, playerId, playerId, playerId, playerId, playerId])

  return result.data
}
