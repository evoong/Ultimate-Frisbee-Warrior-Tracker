type EventType = {
  id: number
  name: string
  category: string
}

export default async function() {
  const result = await retoolDb.query<EventType>(
    `SELECT id, name, category FROM event_types
     WHERE name != 'Opponent Goal'
     ORDER BY category, name`
  )
  return result.data
}
