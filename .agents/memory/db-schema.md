---
name: DB schema additions
description: Schema changes added beyond the original Retool schema
---

Added columns/tables beyond the base schema:
- `players.number INTEGER` — jersey number
- `seasons.default_game_time TIME` — auto-fills game time when season selected
- `seasons.organizer TEXT` — organizer name (part of "Organizer Name Year" display)
- `games.outcome_override TEXT` — overrides computed result from score
- `games.notes TEXT` — free-text game notes
- `game_lineups (id, game_id, player_id, lineup_name, created_at)` — per-game lineup groups
- `chat_logs (id, session_id, user_id, role, content, created_at)` — AI chat history

**Why:** All added to support new feature requests.
**How to apply:** Run migrations manually if deploying to a new DB.
