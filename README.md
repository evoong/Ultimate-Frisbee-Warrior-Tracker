# Ultimate Frisbee Warrior Tracker

Ultimate Frisbee Warrior Tracker is a full-stack web application designed to help Ultimate Frisbee organizers, captains, and players track seasons, rosters, and game statistics.

## Features
- **Season Management:** Create, view, and organize different Ultimate Frisbee seasons and leagues.
- **Roster & Player Tracking:** Add players to rosters and track their participation.
- **Game Tracking:** Record game schedules, locations, and outcomes.
- **Modern User Interface:** Built with React and styled with a sleek, responsive dark mode design.

## Tech Stack
- **Frontend:** React, Vite, Lucide React (Icons)
- **Backend:** Node.js, Express
- **Database:** PostgreSQL (Supabase) via Supabase REST API and RPC functions
- **Deployment:** Vercel (Frontend & Serverless API functions)

## Running Locally

To run the project locally for development:

1. Install dependencies for the backend and frontend:
   ```bash
   npm install
   cd frontend && npm install
   ```

2. Create a `.env` file in the root directory with the necessary Supabase credentials:
   ```env
   SUPABASE_URL=your_supabase_url
   SUPABASE_PUBLISHABLE_KEY=your_publishable_key
   SUPABASE_SECRET_KEY=your_secret_key
   ```

3. Start the development server (runs both the Vite frontend and Express API):
   ```bash
   npm run dev
   ```

The frontend will be available at `http://localhost:5001` and the backend API at `http://localhost:3001`.