type Params = {
  seasonId?: number | null
}

type Player = {
  id: number
  first_name: string
  last_name: string
  display_name: string
  gender_match: string
  phone: string
  is_sub: boolean
  position: string | null
}

export default async function(req?: { params?: Params; user?: User }) {
  const seasonId = req?.params?.seasonId

  if (seasonId) {
    const result = await retoolDb.query<Player>(`
      SELECT p.id, p.first_name, p.last_name, p.display_name, p.gender_match, p.phone, COALESCE(p.is_sub, false) as is_sub, p.position
      FROM players p
      INNER JOIN season_players sp ON sp.player_id = p.id
      WHERE sp.season_id = $1 AND sp.active = true
      ORDER BY p.display_name
    `, [seasonId])
    return result.data
  }

  const result = await retoolDb.query<Player>(
    'SELECT id, first_name, last_name, display_name, gender_match, phone, COALESCE(is_sub, false) as is_sub, position FROM players ORDER BY display_name'
  )
  return result.data
}
