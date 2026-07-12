import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'

type HookResult<T, P = void> = {
  data: T | undefined
  loading: boolean
  error: string | null
  trigger: P extends void ? () => Promise<T | undefined> : (params?: P) => Promise<T | undefined>
}

function useApiCall<T, P = void>(fn: (params: P) => Promise<T>): HookResult<T, P> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)

  const trigger = useCallback(async (params?: P) => {
    // Guard against out-of-order responses: only the latest call may set state
    const callId = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await fn(params as P)
      if (callId === seqRef.current) setData(result)
      return result
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (callId === seqRef.current) setError(msg)
      return undefined
    } finally {
      if (callId === seqRef.current) setLoading(false)
    }
  }, [fn])

  return { data, loading, error, trigger: trigger as HookResult<T, P>['trigger'] }
}

export type LeagueTeam = {
  id: number
  season_id: number
  name: string
  is_us: boolean
  color: string | null
  notes: string | null
}

// A row in league_games: a matchup we play links to its rich `games` row
// via our_game_id and carries no score of its own (derived from that
// game's goal events instead); this is the only kind of matchup that can
// exist now that there's no "add matchup"/bracket UI for anyone else.
export type LeagueGame = {
  id: number
  season_id: number
  home_team_id: number | null
  away_team_id: number | null
  home_score: number | null
  away_score: number | null
  game_date: string | null
  game_time: string | null
  location: string | null
  stage: 'regular' | 'playoff'
  our_game_id: number | null
}

// league_games row enriched with derived facts:
// - eff_home/away_score: stored score, or for a matchup linked to one of
//   our games, the score derived from that game's goal events
// - is_final: whether the game counts as decided (drives standings)
export type EnrichedLeagueGame = LeagueGame & {
  eff_home_team_id: number | null
  eff_away_team_id: number | null
  eff_home_score: number | null
  eff_away_score: number | null
  is_final: boolean
  involves_us: boolean
  our_override: string | null
}

export type LeagueData = {
  season: { id: number; win_points: number; tie_points: number; loss_points: number }
  teams: LeagueTeam[]
  games: EnrichedLeagueGame[]
}

export type StandingsRow = {
  team: LeagueTeam
  games_played: number
  wins: number
  losses: number
  ties: number
  points_for: number
  points_against: number
  point_diff: number
  points: number
  rank: number
}

// A linked game is over once its scheduled start is comfortably in the
// past (ultimate league games run ~90 minutes).
const GAME_DURATION_MS = 2 * 60 * 60 * 1000

function linkedGameIsFinal(g: { game_date: string | null; game_time: string | null; outcome_override: string | null }, hasEvents: boolean): boolean {
  if (g.outcome_override) return true
  if (!g.game_date || !hasEvents) return false
  const start = new Date(`${g.game_date}T${g.game_time ?? '23:59'}`)
  return Date.now() > start.getTime() + GAME_DURATION_MS
}

export function useGetLeague() {
  const fn = useCallback(async (params: { seasonId: number }): Promise<LeagueData> => {
    const [seasonRes, teamsRes, gamesRes] = await Promise.all([
      supabase.from('seasons').select('id, win_points, tie_points, loss_points').eq('id', params.seasonId).single(),
      supabase.from('league_teams').select('*').eq('season_id', params.seasonId).order('name'),
      supabase.from('league_games').select('*').eq('season_id', params.seasonId)
        .order('game_date', { ascending: true }).order('game_time', { ascending: true }),
    ])
    if (seasonRes.error) throw new Error(seasonRes.error.message)
    if (teamsRes.error) throw new Error(teamsRes.error.message)
    if (gamesRes.error) throw new Error(gamesRes.error.message)

    const teams = (teamsRes.data ?? []) as LeagueTeam[]
    const rows = (gamesRes.data ?? []) as LeagueGame[]
    const usId = teams.find(t => t.is_us)?.id ?? null

    // Derive scores for matchups linked to one of our tracked games.
    const linkedIds = rows.map(r => r.our_game_id).filter((id): id is number => id != null)
    const linkedGames = new Map<number, { game_date: string | null; game_time: string | null; outcome_override: string | null }>()
    const eventScores = new Map<number, { our: number; their: number }>()
    if (linkedIds.length > 0) {
      const [gRes, eRes] = await Promise.all([
        supabase.from('games').select('id, game_date, game_time, outcome_override').in('id', linkedIds),
        supabase.from('game_events').select('game_id, event_type').in('game_id', linkedIds).in('event_type', ['Goal', 'Opponent Goal']),
      ])
      if (gRes.error) throw new Error(gRes.error.message)
      if (eRes.error) throw new Error(eRes.error.message)
      ;(gRes.data ?? []).forEach((g: any) => linkedGames.set(g.id, g))
      ;(eRes.data ?? []).forEach((e: any) => {
        if (!eventScores.has(e.game_id)) eventScores.set(e.game_id, { our: 0, their: 0 })
        const s = eventScores.get(e.game_id)!
        if (e.event_type === 'Goal') s.our++
        else s.their++
      })
    }

    const enriched: EnrichedLeagueGame[] = rows.map(r => {
      const base: EnrichedLeagueGame = {
        ...r,
        eff_home_team_id: r.home_team_id,
        eff_away_team_id: r.away_team_id,
        eff_home_score: r.home_score,
        eff_away_score: r.away_score,
        is_final: r.our_game_id == null && r.home_score != null && r.away_score != null,
        involves_us: usId != null && (r.home_team_id === usId || r.away_team_id === usId),
        our_override: null,
      }
      if (r.our_game_id != null) {
        const linked = linkedGames.get(r.our_game_id)
        const score = eventScores.get(r.our_game_id)
        const our = score?.our ?? 0
        const their = score?.their ?? 0
        const weAreHome = usId != null && r.home_team_id === usId
        base.eff_home_score = weAreHome ? our : their
        base.eff_away_score = weAreHome ? their : our
        base.involves_us = true
        base.our_override = linked?.outcome_override ?? null
        base.is_final = linked ? linkedGameIsFinal(linked, our + their > 0) : false
      }
      return base
    })

    return {
      season: {
        id: params.seasonId,
        win_points: (seasonRes.data as any).win_points ?? 2,
        tie_points: (seasonRes.data as any).tie_points ?? 1,
        loss_points: (seasonRes.data as any).loss_points ?? 0,
      },
      teams,
      games: enriched,
    }
  }, [])
  return useApiCall<LeagueData, { seasonId: number }>(fn)
}

// Pure standings computation so the table derives entirely from entered
// scores. Only decided regular-season games with both teams known count.
// Sort defaults: points, then point differential, then points for.
export function computeStandings(league: LeagueData): StandingsRow[] {
  const rows = new Map<number, StandingsRow>()
  league.teams.forEach(team => {
    rows.set(team.id, {
      team, games_played: 0, wins: 0, losses: 0, ties: 0,
      points_for: 0, points_against: 0, point_diff: 0, points: 0, rank: 0,
    })
  })

  const usId = league.teams.find(t => t.is_us)?.id ?? null
  for (const g of league.games) {
    if (g.stage !== 'regular' || !g.is_final) continue
    const home = g.eff_home_team_id != null ? rows.get(g.eff_home_team_id) : undefined
    const away = g.eff_away_team_id != null ? rows.get(g.eff_away_team_id) : undefined
    if (!home || !away || g.eff_home_score == null || g.eff_away_score == null) continue

    // An outcome override on one of our games (Default Win, Forfeit, ...)
    // beats the score comparison, matching Schedule's display logic.
    let homeOutcome: 'W' | 'L' | 'T'
    if (g.our_override && usId != null) {
      const ourOutcome = g.our_override.startsWith('Win') || g.our_override === 'Default Win' ? 'W'
        : g.our_override === 'Tie' ? 'T' : 'L'
      const weAreHome = g.eff_home_team_id === usId
      homeOutcome = ourOutcome === 'T' ? 'T' : (ourOutcome === 'W') === weAreHome ? 'W' : 'L'
    } else {
      homeOutcome = g.eff_home_score > g.eff_away_score ? 'W' : g.eff_home_score < g.eff_away_score ? 'L' : 'T'
    }

    home.games_played++
    away.games_played++
    home.points_for += g.eff_home_score
    home.points_against += g.eff_away_score
    away.points_for += g.eff_away_score
    away.points_against += g.eff_home_score
    if (homeOutcome === 'W') { home.wins++; away.losses++ }
    else if (homeOutcome === 'L') { home.losses++; away.wins++ }
    else { home.ties++; away.ties++ }
  }

  const list = [...rows.values()]
  list.forEach(r => {
    r.point_diff = r.points_for - r.points_against
    r.points = r.wins * league.season.win_points + r.ties * league.season.tie_points + r.losses * league.season.loss_points
  })
  list.sort((a, b) =>
    b.points - a.points ||
    b.point_diff - a.point_diff ||
    b.points_for - a.points_for ||
    a.team.name.localeCompare(b.team.name)
  )
  list.forEach((r, i) => { r.rank = i + 1 })
  return list
}

// Lightweight teams-only fetch (e.g. opponent suggestions in Schedule's
// create-game form). Use useGetLeague when games are needed too.
export function useGetLeagueTeams() {
  const fn = useCallback(async (params: { seasonId: number }) => {
    const { data, error } = await supabase
      .from('league_teams')
      .select('*')
      .eq('season_id', params.seasonId)
      .order('name')
    if (error) throw new Error(error.message)
    return (data ?? []) as LeagueTeam[]
  }, [])
  return useApiCall<LeagueTeam[], { seasonId: number }>(fn)
}

// Per-season standings math (win/tie/loss points, default 2/1/0).
export function useUpdateSeasonPoints() {
  const fn = useCallback(async (params: { seasonId: number; win_points: number; tie_points: number; loss_points: number }) => {
    const { seasonId, ...body } = params
    const { data, error } = await supabase.from('seasons').update(body).eq('id', seasonId).select('id, win_points, tie_points, loss_points')
    if (error) throw new Error(error.message)
    return data?.[0]
  }, [])
  return useApiCall(fn)
}

export function useCreateLeagueTeam() {
  const fn = useCallback(async (params: { organizationId: number | null; seasonId: number; name: string; is_us?: boolean }) => {
    const { data, error } = await supabase
      .from('league_teams')
      .insert({ organization_id: params.organizationId, season_id: params.seasonId, name: params.name.trim(), is_us: params.is_us ?? false })
      .select()
    if (error) throw new Error(error.message)
    return data?.[0] as LeagueTeam
  }, [])
  return useApiCall(fn)
}

export function useUpdateLeagueTeam() {
  const fn = useCallback(async (params: { id: number; name?: string; notes?: string | null; color?: string | null }) => {
    const { id, ...body } = params
    const { data, error } = await supabase.from('league_teams').update(body).eq('id', id).select()
    if (error) throw new Error(error.message)
    return data?.[0] as LeagueTeam
  }, [])
  return useApiCall(fn)
}

export function useDeleteLeagueTeam() {
  const fn = useCallback(async (params: { id: number }) => {
    const { error } = await supabase.from('league_teams').delete().eq('id', params.id)
    if (error) throw new Error(error.message)
    return true
  }, [])
  return useApiCall(fn)
}

