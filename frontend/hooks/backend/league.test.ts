import { expect, test } from 'vitest'
import { computeStandings, type LeagueData } from './league'

const league: LeagueData = {
  season: { id: 1, win_points: 2, tie_points: 1, loss_points: 0 },
  teams: ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({
    id: index + 1, season_id: 1, name, is_us: false, color: null, notes: null,
  })),
  games: [1, 2].map((homeId, index) => ({
    id: index + 1, season_id: 1, home_team_id: homeId, away_team_id: 3,
    home_score: 1, away_score: 0, game_date: null, game_time: null,
    location: null, stage: 'regular' as const, our_game_id: null,
    eff_home_team_id: homeId, eff_away_team_id: 3, eff_home_score: 1,
    eff_away_score: 0, is_final: true, involves_us: false, our_override: null,
  })),
}

test('equal standings share rank and next distinct team gets next rank', () => {
  expect(computeStandings(league).map(({ team, rank }) => [team.name, rank])).toEqual([
    ['Alpha', 1], ['Beta', 1], ['Gamma', 2],
  ])
})
