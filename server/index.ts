import express from "express";
import cors from "cors";
import { Pool, types } from "pg";
import multer from "multer";
import path from "path";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";

// Return DATE columns as strings (not JS Date objects)
types.setTypeParser(1082, (val: string) => val);

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Serve uploaded player photos as static files
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// Multer config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `player-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Seasons ──────────────────────────────────────────────────────────────────

app.get("/api/seasons", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, year, start_date, end_date, location, league_name, organizer, default_game_time FROM seasons ORDER BY year DESC, id DESC",
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Distinct values for season creation dropdowns
app.get("/api/seasons/meta", async (req, res) => {
  try {
    const organizers = await pool.query(
      "SELECT DISTINCT organizer FROM seasons WHERE organizer IS NOT NULL ORDER BY organizer",
    );
    const names = await pool.query(
      "SELECT DISTINCT name FROM seasons WHERE name IS NOT NULL ORDER BY name",
    );
    const years = await pool.query(
      "SELECT DISTINCT year FROM seasons WHERE year IS NOT NULL ORDER BY year DESC",
    );
    const locations = await pool.query(
      "SELECT DISTINCT location FROM seasons WHERE location IS NOT NULL ORDER BY location",
    );
    res.json({
      organizers: organizers.rows.map((r) => r.organizer),
      names: names.rows.map((r) => r.name),
      years: years.rows.map((r) => r.year),
      locations: locations.rows.map((r) => r.location),
    });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/seasons", async (req, res) => {
  try {
    const { name, year, location, league_name, organizer, default_game_time } =
      req.body;
    const result = await pool.query(
      "INSERT INTO seasons (name, year, location, league_name, organizer, default_game_time) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [
        name,
        year,
        location ?? null,
        league_name ?? null,
        organizer ?? null,
        default_game_time ?? null,
      ],
    );
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/seasons/:id", async (req, res) => {
  try {
    const { name, year, location, league_name, organizer, default_game_time } =
      req.body;
    await pool.query(
      "UPDATE seasons SET name=$1, year=$2, location=$3, league_name=$4, organizer=$5, default_game_time=$6 WHERE id=$7",
      [
        name,
        year,
        location ?? null,
        league_name ?? null,
        organizer ?? null,
        default_game_time ?? null,
        req.params.id,
      ],
    );
    res.json({ success: true });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Games ─────────────────────────────────────────────────────────────────────

app.get("/api/games", async (req, res) => {
  try {
    // Support single seasonId or multiple seasonIds (array)
    const rawSeasonIds = req.query["seasonIds"];
    const rawSeasonId = req.query["seasonId"];
    const ids: number[] = [];
    if (rawSeasonIds) {
      const arr = Array.isArray(rawSeasonIds) ? rawSeasonIds : [rawSeasonIds];
      arr.forEach((v) => {
        const n = parseInt(String(v));
        if (!isNaN(n)) ids.push(n);
      });
    } else if (rawSeasonId && rawSeasonId !== "all") {
      const n = parseInt(String(rawSeasonId));
      if (!isNaN(n)) ids.push(n);
    }

    let query =
      "SELECT id, opponent, game_date, game_time, game_type, our_score, their_score, result, outcome_override, notes, season_id FROM games";
    const params: unknown[] = [];
    if (ids.length === 1) {
      query += " WHERE season_id = $1";
      params.push(ids[0]);
    } else if (ids.length > 1) {
      query += " WHERE season_id = ANY($1::int[])";
      params.push(ids);
    }
    query += " ORDER BY game_date DESC, game_time DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/games", async (req, res) => {
  try {
    const { opponent, game_date, game_time, game_type, season_id, notes } =
      req.body;
    const result = await pool.query(
      "INSERT INTO games (opponent, game_date, game_time, game_type, our_score, their_score, season_id, notes) VALUES ($1, $2, $3, $4, 0, 0, $5, $6) RETURNING *",
      [
        opponent,
        game_date,
        game_time,
        game_type,
        season_id ?? null,
        notes ?? null,
      ],
    );
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/games/:id", async (req, res) => {
  try {
    const { notes, outcome_override, result: gameResult } = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (notes !== undefined) {
      updates.push(`notes = $${i++}`);
      params.push(notes);
    }
    if (outcome_override !== undefined) {
      updates.push(`outcome_override = $${i++}`);
      params.push(outcome_override);
    }
    if (gameResult !== undefined) {
      updates.push(`result = $${i++}`);
      params.push(gameResult);
    }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    await pool.query(
      `UPDATE games SET ${updates.join(", ")} WHERE id = $${i}`,
      params,
    );
    const updated = await pool.query("SELECT * FROM games WHERE id = $1", [
      req.params.id,
    ]);
    res.json(updated.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/games/:id", async (req, res) => {
  try {
    // Delete events first (cascading handled but we do it explicitly)
    await pool.query("DELETE FROM game_events WHERE game_id = $1", [
      req.params.id,
    ]);
    await pool.query("DELETE FROM game_lineups WHERE game_id = $1", [
      req.params.id,
    ]);
    const result = await pool.query(
      "DELETE FROM games WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Lineups ───────────────────────────────────────────────────────────────────

app.get("/api/games/:id/lineups", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT gl.id, gl.player_id, gl.lineup_name, p.display_name, p.position, p.gender_match
       FROM game_lineups gl JOIN players p ON p.id = gl.player_id
       WHERE gl.game_id = $1 ORDER BY gl.lineup_name, p.display_name`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/games/:id/lineups", async (req, res) => {
  try {
    const { player_id, lineup_name } = req.body;
    const result = await pool.query(
      "INSERT INTO game_lineups (game_id, player_id, lineup_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *",
      [req.params.id, player_id, lineup_name ?? "Starting"],
    );
    res.json(result.rows[0] ?? { success: true });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/games/:id/lineups/:playerId", async (req, res) => {
  try {
    const { lineup_name } = req.query;
    let q = "DELETE FROM game_lineups WHERE game_id = $1 AND player_id = $2";
    const params: unknown[] = [req.params.id, req.params.playerId];
    if (lineup_name) {
      q += " AND lineup_name = $3";
      params.push(lineup_name);
    }
    await pool.query(q, params);
    res.json({ success: true });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Events ────────────────────────────────────────────────────────────────────

app.get("/api/events", async (req, res) => {
  try {
    const { gameId } = req.query;
    const result = await pool.query(
      "SELECT * FROM game_events WHERE game_id = $1 ORDER BY event_timestamp DESC",
      [gameId],
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/event-types", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, category FROM event_types WHERE name != 'Opponent Goal' ORDER BY category, name",
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/events/goal", async (req, res) => {
  try {
    const { gameId, playerId, relatedPlayerId, eventType, notes } = req.body;
    // Use game date for event timestamp but keep current time-of-day
    const gameResult = await pool.query(
      "SELECT game_date FROM games WHERE id = $1",
      [gameId],
    );
    const gameDate = gameResult.rows[0]?.game_date ?? null;
    let tsExpr = "NOW()";
    let tsParam: string | null = null;
    if (gameDate) {
      // Combine game date with current time
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      tsParam = `${gameDate}T${timeStr}`;
      tsExpr = "$6::timestamp";
    }
    const result = await pool.query(
      `INSERT INTO game_events (game_id, player_id, related_player_id, event_type, notes, event_timestamp) VALUES ($1, $2, $3, $4, $5, ${tsExpr}) RETURNING *`,
      tsParam
        ? [
            gameId,
            playerId ?? null,
            relatedPlayerId ?? null,
            eventType ?? "Goal",
            notes ?? null,
            tsParam,
          ]
        : [
            gameId,
            playerId ?? null,
            relatedPlayerId ?? null,
            eventType ?? "Goal",
            notes ?? null,
          ],
    );
    // Update game scores
    await updateGameScore(gameId);
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/events/opponent-goal", async (req, res) => {
  try {
    const { gameId } = req.body;
    const gameResult = await pool.query(
      "SELECT game_date FROM games WHERE id = $1",
      [gameId],
    );
    const gameDate = gameResult.rows[0]?.game_date ?? null;
    let tsExpr = "NOW()";
    let tsParam: string | null = null;
    if (gameDate) {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      tsParam = `${gameDate}T${timeStr}`;
      tsExpr = "$2::timestamp";
    }
    const result = await pool.query(
      `INSERT INTO game_events (game_id, event_type, event_timestamp) VALUES ($1, 'Opponent Goal', ${tsExpr}) RETURNING *`,
      tsParam ? [gameId, tsParam] : [gameId],
    );
    await updateGameScore(gameId);
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/events/:id", async (req, res) => {
  try {
    const evt = await pool.query(
      "SELECT game_id FROM game_events WHERE id = $1",
      [req.params.id],
    );
    const result = await pool.query(
      "DELETE FROM game_events WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    if (evt.rows[0]?.game_id) await updateGameScore(evt.rows[0].game_id);
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/events/:id", async (req, res) => {
  try {
    const { playerId, relatedPlayerId, notes, eventType } = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (playerId !== undefined) {
      updates.push(`player_id = $${i++}`);
      params.push(playerId);
    }
    if (relatedPlayerId !== undefined) {
      updates.push(`related_player_id = $${i++}`);
      params.push(relatedPlayerId);
    }
    if (notes !== undefined) {
      updates.push(`notes = $${i++}`);
      params.push(notes);
    }
    if (eventType !== undefined) {
      updates.push(`event_type = $${i++}`);
      params.push(eventType);
    }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE game_events SET ${updates.join(", ")} WHERE id = $${i} RETURNING *`,
      params,
    );
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Helper: recalculate game score from events
async function updateGameScore(gameId: number | string) {
  const counts = await pool.query(
    `SELECT
      COUNT(CASE WHEN event_type = 'Goal' THEN 1 END) AS our_score,
      COUNT(CASE WHEN event_type = 'Opponent Goal' THEN 1 END) AS their_score
    FROM game_events WHERE game_id = $1`,
    [gameId],
  );
  const { our_score, their_score } = counts.rows[0];
  const our = parseInt(our_score ?? "0");
  const their = parseInt(their_score ?? "0");

  // Determine result from score unless outcome_override is set
  const gameRow = await pool.query(
    "SELECT outcome_override FROM games WHERE id = $1",
    [gameId],
  );
  const override = gameRow.rows[0]?.outcome_override ?? null;
  let result: string | null = override;
  if (!override) {
    if (our > their) result = "Win";
    else if (their > our) result = "Loss";
    else if (our === their && our > 0) result = "Tie";
    else result = null;
  }

  await pool.query(
    "UPDATE games SET our_score = $1, their_score = $2, result = $3 WHERE id = $4",
    [our, their, result, gameId],
  );
}

// ── Players ───────────────────────────────────────────────────────────────────

app.get("/api/players", async (req, res) => {
  try {
    // Support single seasonId or multiple seasonIds
    const rawSeasonIds = req.query["seasonIds"];
    const rawSeasonId = req.query["seasonId"];
    const ids: number[] = [];
    if (rawSeasonIds) {
      const arr = Array.isArray(rawSeasonIds) ? rawSeasonIds : [rawSeasonIds];
      arr.forEach((v) => {
        const n = parseInt(String(v));
        if (!isNaN(n)) ids.push(n);
      });
    } else if (rawSeasonId && rawSeasonId !== "null") {
      const n = parseInt(String(rawSeasonId));
      if (!isNaN(n)) ids.push(n);
    }

    if (ids.length > 0) {
      const result = await pool.query(
        `SELECT DISTINCT p.id, p.first_name, p.last_name, p.display_name, p.gender_match, p.phone, p.number,
                COALESCE(p.is_sub, false) as is_sub, p.position, p.photo_url
         FROM players p
         INNER JOIN season_players sp ON sp.player_id = p.id
         WHERE sp.season_id = ANY($1::int[]) AND sp.active = true
         ORDER BY p.display_name`,
        [ids],
      );
      return res.json(result.rows);
    }
    const result = await pool.query(
      "SELECT id, first_name, last_name, display_name, gender_match, phone, number, COALESCE(is_sub, false) as is_sub, position, photo_url FROM players ORDER BY display_name",
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/players/season-roster", async (req, res) => {
  try {
    const { gameId } = req.query;
    const gameResult = await pool.query(
      "SELECT season_id FROM games WHERE id = $1",
      [gameId],
    );
    const seasonId = gameResult.rows[0]?.season_id;

    if (!seasonId) {
      const all = await pool.query(
        "SELECT id, display_name, gender_match, is_sub, number FROM players ORDER BY display_name",
      );
      return res.json(all.rows);
    }

    const rostered = await pool.query(
      `SELECT p.id, p.display_name, p.gender_match, p.is_sub, p.number
       FROM players p
       INNER JOIN season_players sp ON sp.player_id = p.id
       WHERE sp.season_id = $1 AND sp.active = true
       ORDER BY p.display_name`,
      [seasonId],
    );

    if (rostered.rows.length > 0) return res.json(rostered.rows);

    const all = await pool.query(
      "SELECT id, display_name, gender_match, is_sub, number FROM players ORDER BY display_name",
    );
    res.json(all.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Get seasons for a player
app.get("/api/players/:id/seasons", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.year, s.organizer, sp.active
       FROM seasons s
       JOIN season_players sp ON sp.season_id = s.id
       WHERE sp.player_id = $1
       ORDER BY s.year DESC, s.id DESC`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Update player seasons
app.patch("/api/players/:id/seasons", async (req, res) => {
  try {
    const { seasonIds } = req.body; // array of season ids to be active
    // Remove all then add back
    await pool.query("DELETE FROM season_players WHERE player_id = $1", [
      req.params.id,
    ]);
    for (const sid of seasonIds ?? []) {
      await pool.query(
        "INSERT INTO season_players (season_id, player_id, active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING",
        [sid, req.params.id],
      );
    }
    res.json({ success: true });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/players", async (req, res) => {
  try {
    const {
      display_name,
      first_name,
      last_name,
      gender_match,
      phone,
      number,
      position,
      is_sub,
      season_ids,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO players (display_name, first_name, last_name, gender_match, phone, number, position, is_sub)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        display_name,
        first_name ?? display_name,
        last_name ?? null,
        gender_match ?? null,
        phone ?? null,
        number ?? null,
        position ?? null,
        is_sub ?? false,
      ],
    );
    const player = result.rows[0];
    if (season_ids && Array.isArray(season_ids)) {
      for (const sid of season_ids) {
        await pool.query(
          "INSERT INTO season_players (season_id, player_id, active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING",
          [sid, player.id],
        );
      }
    }
    res.json(player);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/players/:id", async (req, res) => {
  try {
    const {
      display_name,
      first_name,
      last_name,
      gender_match,
      phone,
      number,
      position,
    } = req.body;
    const updates: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (display_name !== undefined) {
      updates.push(`display_name = $${i++}`);
      params.push(display_name);
    }
    if (first_name !== undefined) {
      updates.push(`first_name = $${i++}`);
      params.push(first_name);
    }
    if (last_name !== undefined) {
      updates.push(`last_name = $${i++}`);
      params.push(last_name);
    }
    if (gender_match !== undefined) {
      updates.push(`gender_match = $${i++}`);
      params.push(gender_match);
    }
    if (phone !== undefined) {
      updates.push(`phone = $${i++}`);
      params.push(phone);
    }
    if (number !== undefined) {
      updates.push(`number = $${i++}`);
      params.push(number === "" ? null : number);
    }
    if (position !== undefined) {
      updates.push(`position = $${i++}`);
      params.push(position);
    }
    if (updates.length === 0) return res.json({ success: true });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE players SET ${updates.join(", ")} WHERE id = $${i} RETURNING *`,
      params,
    );
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/players/for-game", async (req, res) => {
  try {
    const { displayName, gameId } = req.body;
    const gameResult = await pool.query(
      "SELECT season_id FROM games WHERE id = $1",
      [gameId],
    );
    const seasonId = gameResult.rows[0]?.season_id;

    const playerResult = await pool.query(
      "INSERT INTO players (display_name, first_name, is_sub) VALUES ($1, $2, true) RETURNING *",
      [displayName, displayName],
    );
    const player = playerResult.rows[0];

    if (seasonId) {
      await pool.query(
        "INSERT INTO season_players (season_id, player_id, active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING",
        [seasonId, player.id],
      );
    }

    res.json(player);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Upload / update player photo
app.post("/api/players/:id/photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const photoUrl = `/uploads/${req.file.filename}`;
    const old = await pool.query(
      "SELECT photo_url FROM players WHERE id = $1",
      [req.params.id],
    );
    const oldUrl: string | null = old.rows[0]?.photo_url ?? null;
    if (oldUrl) {
      const oldPath = path.join(process.cwd(), oldUrl);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await pool.query("UPDATE players SET photo_url = $1 WHERE id = $2", [
      photoUrl,
      req.params.id,
    ]);
    res.json({ photo_url: photoUrl });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/players/:id/position", async (req, res) => {
  try {
    const { position } = req.body;
    await pool.query("UPDATE players SET position = $1 WHERE id = $2", [
      position,
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/players/:id/sub", async (req, res) => {
  try {
    const { gameId } = req.body;
    const playerId = req.params.id;

    const check = await pool.query("SELECT is_sub FROM players WHERE id = $1", [
      playerId,
    ]);
    if (!check.rows[0]?.is_sub) {
      return res
        .status(400)
        .json({ error: "Cannot delete a player that is not a sub" });
    }

    let resolvedSeasonId: number | null = null;
    if (gameId && gameId > 0) {
      const gameResult = await pool.query(
        "SELECT season_id FROM games WHERE id = $1",
        [gameId],
      );
      resolvedSeasonId = gameResult.rows[0]?.season_id ?? null;
    }

    if (resolvedSeasonId) {
      await pool.query(
        "DELETE FROM season_players WHERE player_id = $1 AND season_id = $2",
        [playerId, resolvedSeasonId],
      );
    } else {
      await pool.query("DELETE FROM season_players WHERE player_id = $1", [
        playerId,
      ]);
    }

    const eventsCheck = await pool.query(
      "SELECT COUNT(*) as count FROM game_events WHERE player_id = $1 OR related_player_id = $2",
      [playerId, playerId],
    );
    const eventCount = parseInt(eventsCheck.rows[0]?.count ?? "0");
    if (eventCount === 0) {
      await pool.query("DELETE FROM players WHERE id = $1", [playerId]);
    }

    res.json({ success: true, fullyDeleted: eventCount === 0 });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Delete any player (with confirmation)
app.delete("/api/players/:id", async (req, res) => {
  try {
    const playerId = req.params.id;
    await pool.query(
      "DELETE FROM game_events WHERE player_id = $1 OR related_player_id = $1",
      [playerId],
    );
    await pool.query("DELETE FROM season_players WHERE player_id = $1", [
      playerId,
    ]);
    await pool.query("DELETE FROM game_lineups WHERE player_id = $1", [
      playerId,
    ]);
    const result = await pool.query(
      "DELETE FROM players WHERE id = $1 RETURNING *",
      [playerId],
    );
    res.json(result.rows[0]);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/players/:id/game-stats", async (req, res) => {
  try {
    const playerId = req.params.id;
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
      INNER JOIN season_players sp ON sp.season_id = g.season_id AND sp.player_id = $4 AND sp.active = true
      LEFT JOIN game_events ge ON ge.game_id = g.id
      GROUP BY g.id, g.opponent, g.game_date, g.game_type, g.season_id
      ORDER BY g.game_date DESC`,
      [playerId, playerId, playerId, playerId],
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get("/api/stats/seasons", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id as season_id, s.name, s.year, s.organizer, COUNT(g.id) as game_count
       FROM seasons s
       LEFT JOIN games g ON g.season_id = s.id
       GROUP BY s.id, s.name, s.year, s.organizer
       HAVING COUNT(g.id) > 0
       ORDER BY s.year DESC, s.id DESC`,
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/stats/players", async (req, res) => {
  try {
    const { gameIds } = req.query;

    // Support single seasonId or multiple seasonIds
    const rawSeasonIds = req.query["seasonIds"];
    const rawSeasonId = req.query["seasonId"];
    const seasonIdArr: number[] = [];
    if (rawSeasonIds) {
      const arr = Array.isArray(rawSeasonIds) ? rawSeasonIds : [rawSeasonIds];
      arr.forEach((v) => {
        const n = parseInt(String(v));
        if (!isNaN(n)) seasonIdArr.push(n);
      });
    } else if (rawSeasonId) {
      const n = parseInt(String(rawSeasonId));
      if (!isNaN(n)) seasonIdArr.push(n);
    }
    const hasSeasons = seasonIdArr.length > 0;

    let gameFilter = "";
    let playerFilter = "";
    const params: unknown[] = [];

    if (gameIds) {
      const ids = Array.isArray(gameIds) ? gameIds : [gameIds];
      const idNums = ids.map(Number).filter((n) => !isNaN(n));
      if (idNums.length > 0) {
        gameFilter = "AND ge.game_id = ANY($1::int[])";
        params.push(idNums);
      }
    } else if (hasSeasons) {
      params.push(seasonIdArr);
      gameFilter = "AND g.season_id = ANY($1::int[])";
      playerFilter = `INNER JOIN season_players sp_filter ON sp_filter.player_id = p.id AND sp_filter.season_id = ANY($1::int[]) AND sp_filter.active = true`;
    }

    // games_played = all games in season(s) for that player (backfill)
    const gamesPlayedSubquery =
      hasSeasons && !gameIds
        ? `(SELECT COUNT(*) FROM games g2 WHERE g2.season_id = ANY($1::int[]) AND EXISTS (
           SELECT 1 FROM season_players sp2 WHERE sp2.player_id = p.id AND sp2.season_id = g2.season_id AND sp2.active = true
         ))`
        : `COUNT(DISTINCT ge.game_id)`;

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
          ${gamesPlayedSubquery} AS games_played
        FROM players p
        ${playerFilter}
        LEFT JOIN game_events ge ON ge.player_id = p.id OR ge.related_player_id = p.id
        LEFT JOIN games g ON ge.game_id = g.id
        WHERE 1=1 ${gameFilter}
        GROUP BY p.id, p.display_name
        HAVING (${gamesPlayedSubquery}) > 0
      ) t
      ORDER BY ga_rank, player_name
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Cumulative per-game stats for line chart
app.get("/api/stats/cumulative", async (req, res) => {
  try {
    const { seasonId } = req.query;
    const params: unknown[] = [];
    const seasonFilter = seasonId ? `AND g.season_id = $1` : "";
    if (seasonId) params.push(seasonId);

    // Get all season players if filtering by season, so we include all players (not just those with events)
    let playersQuery: string;
    if (seasonId) {
      playersQuery = `
        SELECT DISTINCT p.id AS player_id, p.display_name AS player_name
        FROM players p
        JOIN season_players sp ON sp.player_id = p.id
        WHERE sp.season_id = $1 AND sp.active = true
      `;
    } else {
      playersQuery = `
        SELECT DISTINCT p.id AS player_id, p.display_name AS player_name
        FROM players p
        JOIN game_events ge ON ge.player_id = p.id OR ge.related_player_id = p.id
        JOIN games g ON ge.game_id = g.id
        WHERE 1=1 ${seasonFilter}
      `;
    }

    const query = `
      SELECT
        g.id AS game_id,
        g.opponent,
        g.game_date,
        p.player_id,
        p.player_name,
        COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.player_id = p.player_id THEN ge.id END) AS goals,
        COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.related_player_id = p.player_id THEN ge.id END) AS assists,
        COUNT(DISTINCT CASE WHEN ge.event_type = 'Turnover' AND ge.player_id = p.player_id THEN ge.id END) AS turnovers
      FROM games g
      CROSS JOIN (${playersQuery}) p
      LEFT JOIN game_events ge ON ge.game_id = g.id AND (ge.player_id = p.player_id OR ge.related_player_id = p.player_id)
      WHERE 1=1 ${seasonFilter}
      GROUP BY g.id, g.opponent, g.game_date, p.player_id, p.player_name
      ORDER BY g.game_date, g.id, p.player_name
    `;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Chat (Gemini AI) ──────────────────────────────────────────────────────────

app.get("/api/chat/history", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.json([]);
    const result = await pool.query(
      "SELECT id, role, content, created_at FROM chat_logs WHERE session_id = $1 ORDER BY created_at ASC LIMIT 100",
      [session_id],
    );
    res.json(result.rows);
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/chat/history", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (session_id)
      await pool.query("DELETE FROM chat_logs WHERE session_id = $1", [
        session_id,
      ]);
    res.json({ success: true });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, session_id, history } = req.body;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not set. Please add it in your environment secrets." });
    }

    // Fetch DB context for system prompt
    const seasonsData = await pool.query(
      "SELECT id, name, year, organizer FROM seasons ORDER BY year DESC LIMIT 10",
    );
    const gamesData = await pool.query(
      "SELECT id, opponent, game_date, our_score, their_score, result, season_id FROM games ORDER BY game_date DESC LIMIT 20",
    );
    const playersData = await pool.query(
      "SELECT id, display_name, position, gender_match FROM players ORDER BY display_name LIMIT 50",
    );
    const statsData = await pool.query(`
      SELECT p.display_name,
        COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.player_id = p.id THEN ge.id END) AS goals,
        COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.related_player_id = p.id THEN ge.id END) AS assists,
        COUNT(DISTINCT CASE WHEN ge.event_type = 'Turnover' AND ge.player_id = p.id THEN ge.id END) AS turnovers
      FROM players p
      LEFT JOIN game_events ge ON ge.player_id = p.id OR ge.related_player_id = p.id
      GROUP BY p.id, p.display_name
      HAVING COUNT(ge.id) > 0
      ORDER BY (COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.player_id = p.id THEN ge.id END) + COUNT(DISTINCT CASE WHEN ge.event_type = 'Goal' AND ge.related_player_id = p.id THEN ge.id END)) DESC
      LIMIT 20
    `);

    const systemPrompt = `You are a helpful assistant for the Ultimate Frisbee Warrior Tracker app. You have access to real-time data about the team.

Current Data:
SEASONS: ${JSON.stringify(seasonsData.rows)}
RECENT GAMES: ${JSON.stringify(gamesData.rows)}
PLAYERS: ${JSON.stringify(playersData.rows)}
TOP STATS: ${JSON.stringify(statsData.rows)}

You can help users:
- Answer questions about player stats, game results, season standings
- Add points/goals to games (respond with ACTION: ADD_GOAL {"gameId": X, "playerId": Y, "relatedPlayerId": Z, "eventType": "Goal"})
- Add opponent goals (respond with ACTION: ADD_OPPONENT_GOAL {"gameId": X})
- Create new games (respond with ACTION: CREATE_GAME {"opponent": "Name", "game_date": "YYYY-MM-DD", "game_time": "HH:MM", "game_type": "Regular", "season_id": X})
- Provide insights and analysis about team performance

When you want to perform an action, include the ACTION tag in your response followed by the JSON. Be concise and helpful.`;

    // Build conversation history for Gemini
    const contents: { role: string; parts: { text: string }[] }[] = [];

    // Add history
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }

    // Add current message
    contents.push({ role: "user", parts: [{ text: message }] });

    const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    const geminiResponse = await genai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 1024,
        temperature: 0.7,
      },
    });

    const reply = geminiResponse.text ?? "Sorry, I could not generate a response.";

    // Parse and execute any actions
    const actionResults: string[] = [];
    const actionMatch = reply.match(/ACTION:\s+(\w+)\s+(\{[^}]+\})/g);
    if (actionMatch) {
      for (const action of actionMatch) {
        const parts = action.match(/ACTION:\s+(\w+)\s+(\{.+\})/);
        if (!parts) continue;
        const [, actionType, jsonStr] = parts;
        try {
          const data = JSON.parse(jsonStr);
          if (actionType === "ADD_GOAL") {
            await fetch(`http://localhost:${PORT}/api/events/goal`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                gameId: data.gameId,
                playerId: data.playerId ?? null,
                relatedPlayerId: data.relatedPlayerId ?? null,
                eventType: data.eventType ?? "Goal",
              }),
            });
            actionResults.push("Goal added successfully");
          } else if (actionType === "ADD_OPPONENT_GOAL") {
            await fetch(`http://localhost:${PORT}/api/events/opponent-goal`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ gameId: data.gameId }),
            });
            actionResults.push("Opponent goal added");
          } else if (actionType === "CREATE_GAME") {
            await fetch(`http://localhost:${PORT}/api/games`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            });
            actionResults.push("Game created successfully");
          }
        } catch {
          // ignore action parse errors
        }
      }
    }

    // Store in DB
    if (session_id) {
      await pool.query(
        "INSERT INTO chat_logs (session_id, role, content) VALUES ($1, $2, $3)",
        [session_id, "user", message],
      );
      await pool.query(
        "INSERT INTO chat_logs (session_id, role, content) VALUES ($1, $2, $3)",
        [session_id, "assistant", reply],
      );
    }

    res.json({ reply, actionResults });
  } catch (err: unknown) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, "localhost", () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
