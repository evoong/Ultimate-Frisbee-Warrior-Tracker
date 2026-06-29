---
name: Games played backfill
description: How games_played is calculated for season players
---

When filtering by season, games_played = count of ALL games in the season where the player is in season_players (active=true), NOT just games where they have event entries.

This is the subquery used in /api/stats/players:
```sql
(SELECT COUNT(*) FROM games g2 WHERE g2.season_id = $1 AND EXISTS (
  SELECT 1 FROM season_players sp2 WHERE sp2.player_id = p.id AND sp2.season_id = g2.season_id AND sp2.active = true
))
```

**Why:** User wanted all roster players to show games played even if they didn't score.
**How to apply:** Only active when filtering by season. When filtering by game IDs, use COUNT(DISTINCT ge.game_id) instead.
