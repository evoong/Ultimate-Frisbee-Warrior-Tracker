import express from 'express'
import cors from 'cors'
import { Pool, types } from 'pg'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

// Return DATE columns as strings (not JS Date objects)
types.setTypeParser(1082, (val: string) => val)

const app = express()
const PORT = 3001

app.use(cors())
app.use(express.json())

// Serve uploaded player photos as static files
const uploadsDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))

// Multer config — store images in /uploads, preserve extension
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg'
    cb(null, `player-${Date.now()}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
})

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// Games
app.get('/api/games', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, opponent, game_date, game_time, game_type, our_score, their_score, result, notes, season_id FROM games ORDER BY game_date DESC, game_time DESC'
    )
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/games', async (req, res) => {
  try {
    const { opponent, game_date, game_time, game_type, season_id } = req.body
    const result = await pool.query(
      'INSERT INTO games (opponent, game_date, game_time, game_type, our_score, their_score, season_id) VALUES ($1, $2, $3, $4, 0, 0, $5) RETURNING *',
      [opponent, game_date, game_time, game_type, season_id ?? null]
    )
    res.json(result.rows[0])
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Events
app.get('/api/events', async (req, res) => {
  try {
    const { gameId } = req.query
    const result = await pool.query(
      'SELECT * FROM game_events WHERE game_id = $1 ORDER BY event_timestamp DESC',
      [gameId]
    )
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/event-types', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, category FROM event_types WHERE name != 'Opponent Goal' ORDER BY category, name"
    )
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/events/goal', async (req, res) => {
  try {
    const { gameId, playerId, relatedPlayerId, eventType, notes } = req.body
    const result = await pool.query(
      'INSERT INTO game_events (game_id, player_id, related_player_id, event_type, notes, event_timestamp) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
      [gameId, playerId ?? null, relatedPlayerId ?? null, eventType ?? 'Goal', notes ?? null]
    )
    res.json(result.rows[0])
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/events/opponent-goal', async (req, res) => {
  try {
    const { gameId } = req.body
    const result = await pool.query(
      "INSERT INTO game_events (game_id, event_type, event_timestamp) VALUES ($1, 'Opponent Goal', NOW()) RETURNING *",
      [gameId]
    )
    res.json(result.rows[0])
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/events/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM game_events WHERE id = $1 RETURNING *',
      [req.params.id]
    )
    res.json(result.rows[0])
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.patch('/api/events/:id', async (req, res) => {
  try {
    const { playerId, relatedPlayerId } = req.body
    const result = await pool.query(
      'UPDATE game_events SET player_id = $1, related_player_id = $2 WHERE id = $3 RETURNING *',
      [playerId ?? null, relatedPlayerId ?? null, req.params.id]
    )
    res.json(result.rows[0])
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Players
app.get('/api/players', async (req, res) => {
  try {
    const { seasonId } = req.query
    if (seasonId && seasonId !== 'null') {
      const result = await pool.query(
        `SELECT p.id, p.first_name, p.last_name, p.display_name, p.gender_match, p.phone, COALESCE(p.is_sub, false) as is_sub, p.position, p.photo_url
         FROM players p
         INNER JOIN season_players sp ON sp.player_id = p.id
         WHERE sp.season_id = $1 AND sp.active = true
         ORDER BY p.display_name`,
        [seasonId]
      )
      return res.json(result.rows)
    }
    const result = await pool.query(
      'SELECT id, first_name, last_name, display_name, gender_match, phone, COALESCE(is_sub, false) as is_sub, position, photo_url FROM players ORDER BY display_name'
    )
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Upload / update player photo
app.post('/api/players/:id/photo', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const photoUrl = `/uploads/${req.file.filename}`
    // Delete old photo file if it exists
    const old = await pool.query('SELECT photo_url FROM players WHERE id = $1', [req.params.id])
    const oldUrl: string | null = old.rows[0]?.photo_url ?? null
    if (oldUrl) {
      const oldPath = path.join(process.cwd(), oldUrl)
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
    }
    await pool.query('UPDATE players SET photo_url = $1 WHERE id = $2', [photoUrl, req.params.id])
    res.json({ photo_url: photoUrl })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/players/season-roster', async (req, res) => {
  try {
    const { gameId } = req.query
    const gameResult = await pool.query('SELECT season_id FROM games WHERE id = $1', [gameId])
    const seasonId = gameResult.rows[0]?.season_id

    if (!seasonId) {
      const all = await pool.query('SELECT id, display_name, gender_match, is_sub FROM players ORDER BY display_name')
      return res.json(all.rows)
    }

    const rostered = await pool.query(
      `SELECT p.id, p.display_name, p.gender_match, p.is_sub
       FROM players p
       INNER JOIN season_players sp ON sp.player_id = p.id
       WHERE sp.season_id = $1 AND sp.active = true
       ORDER BY p.display_name`,
      [seasonId]
    )

    if (rostered.rows.length > 0) {
      return res.json(rostered.rows)
    }

    const all = await pool.query('SELECT id, display_name, gender_match, is_sub FROM players ORDER BY display_name')
    res.json(all.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/players/for-game', async (req, res) => {
  try {
    const { displayName, gameId } = req.body
    const gameResult = await pool.query('SELECT season_id FROM games WHERE id = $1', [gameId])
    const seasonId = gameResult.rows[0]?.season_id

    const playerResult = await pool.query(
      'INSERT INTO players (display_name, first_name, is_sub) VALUES ($1, $2, true) RETURNING *',
      [displayName, displayName]
    )
    const player = playerResult.rows[0]

    if (seasonId) {
      await pool.query(
        'INSERT INTO season_players (season_id, player_id, active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING',
        [seasonId, player.id]
      )
    }

    res.json(player)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.delete('/api/players/:id/sub', async (req, res) => {
  try {
    const { gameId } = req.body
    const playerId = req.params.id

    const check = await pool.query('SELECT is_sub FROM players WHERE id = $1', [playerId])
    if (!check.rows[0]?.is_sub) {
      return res.status(400).json({ error: 'Cannot delete a player that is not a sub' })
    }

    let resolvedSeasonId: number | null = null
    if (gameId && gameId > 0) {
      const gameResult = await pool.query('SELECT season_id FROM games WHERE id = $1', [gameId])
      resolvedSeasonId = gameResult.rows[0]?.season_id ?? null
    }

    if (resolvedSeasonId) {
      await pool.query('DELETE FROM season_players WHERE player_id = $1 AND season_id = $2', [playerId, resolvedSeasonId])
    } else {
      await pool.query('DELETE FROM season_players WHERE player_id = $1', [playerId])
    }

    const eventsCheck = await pool.query(
      'SELECT COUNT(*) as count FROM game_events WHERE player_id = $1 OR related_player_id = $2',
      [playerId, playerId]
    )
    const eventCount = parseInt(eventsCheck.rows[0]?.count ?? '0')

    if (eventCount === 0) {
      await pool.query('DELETE FROM players WHERE id = $1', [playerId])
    }

    res.json({ success: true, fullyDeleted: eventCount === 0 })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.patch('/api/players/:id/position', async (req, res) => {
  try {
    const { position } = req.body
    await pool.query('UPDATE players SET position = $1 WHERE id = $2', [position, req.params.id])
    res.json({ success: true })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/players/:id/game-stats', async (req, res) => {
  try {
    const playerId = req.params.id
    const result = await pool.query(
      `SELECT
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
      ORDER BY g.game_date DESC`,
      [playerId, playerId, playerId, playerId, playerId, playerId]
    )
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Stats
app.get('/api/stats/seasons', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT season_id, COUNT(*) as game_count FROM games WHERE season_id IS NOT NULL GROUP BY season_id ORDER BY season_id DESC`
    )
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/stats/players', async (req, res) => {
  try {
    const { seasonId, gameIds } = req.query

    let gameFilter = ''
    const params: unknown[] = []

    if (gameIds) {
      const ids = Array.isArray(gameIds) ? gameIds : [gameIds]
      const idNums = ids.map(Number).filter(n => !isNaN(n))
      if (idNums.length > 0) {
        gameFilter = 'AND ge.game_id = ANY($1::int[])'
        params.push(idNums)
      }
    } else if (seasonId) {
      gameFilter = 'AND g.season_id = $1'
      params.push(seasonId)
    }

    const query = `
      SELECT
        *,
        DENSE_RANK() OVER (ORDER BY ga DESC, goals DESC, assists DESC) AS ga_rank
      FROM (
        SELECT
          p.id AS player_id,
          p.display_name AS player_name,
          COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.player_id = p.id THEN ge.id END) AS goals,
          COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.related_player_id = p.id THEN ge.id END) AS assists,
          COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.player_id = p.id THEN ge.id END)
          + COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.related_player_id = p.id THEN ge.id END) AS ga,
          COUNT(DISTINCT CASE WHEN ge.event_type = 'Turnover' AND ge.player_id = p.id THEN ge.id END) AS turnovers,
          COUNT(DISTINCT ge.game_id) AS games_played
        FROM players p
        LEFT JOIN game_events ge ON ge.player_id = p.id OR ge.related_player_id = p.id
        LEFT JOIN games g ON ge.game_id = g.id
        WHERE 1=1 ${gameFilter}
        GROUP BY p.id, p.display_name
        HAVING COUNT(DISTINCT ge.game_id) > 0
      ) t
      ORDER BY ga_rank, player_name
    `

    const result = await pool.query(query, params)
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// Seasons
app.get('/api/seasons', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, year, start_date, end_date, location, league_name, organizer FROM seasons ORDER BY year DESC, id DESC'
    )
    res.json(result.rows)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/seasons', async (req, res) => {
  try {
    const { name, year, location, league_name, organizer } = req.body
    const result = await pool.query(
      'INSERT INTO seasons (name, year, location, league_name, organizer) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, year, location ?? null, league_name ?? null, organizer ?? null]
    )
    res.json(result.rows[0])
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.listen(PORT, 'localhost', () => {
  console.log(`API server running on http://localhost:${PORT}`)
})
