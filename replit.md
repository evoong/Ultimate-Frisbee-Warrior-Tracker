# Ultimate Frisbee Warrior Tracker

A web app for tracking game events, scores, player rosters, and statistics for an Ultimate Frisbee team.

## Architecture

- **Frontend**: React 19 + TypeScript + Vite, served on port 5000
- **Backend**: Express.js API server on port 3001 (proxied via Vite)
- **Database**: Replit PostgreSQL (connected via `DATABASE_URL`)

## Project Structure

- `frontend/` — React app (pages, components, hooks, shadcn UI)
  - `pages/` — QuickScore, Schedule, Roster, Stats
  - `components/` — PlayerCombobox
  - `hooks/backend/` — API hooks (games, events, players, stats)
  - `lib/shadcn/` — UI component library
- `server/` — Express API server (`server/index.ts`)
- `backend/` — Original Retool backend code (reference only, not used at runtime)

## Development

The app runs via `npm run dev` which starts both services concurrently:
- Vite dev server on `0.0.0.0:5000`
- Express API on `localhost:3001`

## User Preferences

- Use the existing shadcn component style in `frontend/lib/shadcn/`
- Hooks in `frontend/hooks/backend/` wrap REST API calls to `server/index.ts`
