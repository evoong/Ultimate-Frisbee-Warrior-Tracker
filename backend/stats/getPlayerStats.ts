type Params = {
  seasonId?: number | null
  gameIds?: number[]
}

type PlayerStats = {
  player_id: number
  player_name: string
  goals: number
  assists: number
  turnovers: number
  games_played: number
}

export default async function(req: { params: Params; user: User }) {
  const { seasonId, gameIds } = req.params
  
  let gameFilter = ''
  let params: unknown[] = []
  
  if (gameIds && gameIds.length > 0) {
    gameFilter = 'AND ge.game_id = ANY($1)'
    params = [gameIds]
  } else if (seasonId) {
    gameFilter = 'AND g.season_id = $1'
    params = [seasonId]
  }
  
  const query = `
SELECT
    *,
    DENSE_RANK() OVER (ORDER BY ga DESC, goals DESC, assists DESC) AS ga_rank
FROM (
    SELECT 
        p.id AS player_id,
        p.display_name AS player_name,

        COUNT(DISTINCT CASE
            WHEN ge.event_type = 'Goal'
             AND ge.player_id = p.id
            THEN ge.id
        END) AS goals,

        COUNT(DISTINCT CASE
            WHEN ge.event_type = 'Goal'
             AND ge.related_player_id = p.id
            THEN ge.id
        END) AS assists,

        COUNT(DISTINCT CASE
            WHEN ge.event_type = 'Goal'
             AND ge.player_id = p.id
            THEN ge.id
        END)
        +
        COUNT(DISTINCT CASE
            WHEN ge.event_type = 'Goal'
             AND ge.related_player_id = p.id
            THEN ge.id
        END) AS ga,

        COUNT(DISTINCT CASE
            WHEN ge.event_type = 'Turnover'
             AND ge.player_id = p.id
            THEN ge.id
        END) AS turnovers,

        COUNT(DISTINCT ge.game_id) AS games_played

    FROM players p
    LEFT JOIN game_events ge
        ON ge.player_id = p.id
        OR ge.related_player_id = p.id
    LEFT JOIN games g
        ON ge.game_id = g.id
    WHERE 1=1
      ${gameFilter}
    GROUP BY p.id, p.display_name
    HAVING COUNT(DISTINCT ge.game_id) > 0
) t
ORDER BY ga_rank, player_name;
  `
  
  const result = await retoolDb.query<PlayerStats>(query, params)
  return result.data
}
