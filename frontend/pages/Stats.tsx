import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useGetGames } from '../hooks/backend/games'
import { useGetPlayers } from '../hooks/backend/players'
import { useGetPlayerStats, useGetSeasons, useGetCumulativeStats, useGetAllSeasons, useGetAssistPairings, type PairingRow } from '../hooks/backend/stats'
import {
  useGetLeague, useGetOpponentHistory, computeStandings,
  useCreateLeagueTeam, useUpdateLeagueTeam, useDeleteLeagueTeam, useUpdateSeasonPoints,
  type LeagueTeam,
} from '../hooks/backend/league'
import { useMyPlayerLink, useClaimPlayer, useGetTeamPlayerLinks } from '../hooks/backend/playerLink'
import { getLatestJamSeasonWithPlayedGame, getDefaultJamSeasonId } from '../lib/seasonUtils'
import { isPastGame } from '../lib/gameOrder'
import { track } from '../lib/analytics'
import { SHOW_TURNOVERS } from '../lib/features'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import PlayerCombobox from '../components/PlayerCombobox'
import { Skeleton } from '../lib/shadcn/skeleton'
import FadeIn from '../components/FadeIn'
import StatsHeader from '../components/stats/StatsHeader'
import FilterBar from '../components/stats/FilterBar'
import { LeaderCard, TeamCard, MetricCard } from '../components/stats/KpiBento'
import PerformanceChart from '../components/stats/PerformanceChart'
import RankingsTable from '../components/stats/RankingsTable'
import StandingsTable, { type StandingsRow, type StandingsSortKey } from '../components/stats/StandingsTable'
import { SinglePicker } from '../components/stats/Picker'
import ChemistryHub from '../components/stats/ChemistryHub'
import AssistMatrix from '../components/stats/AssistMatrix'
import ProgressionChart from '../components/stats/ProgressionChart'
import {
  ALL_SEASONS, shortName,
  type ChemistryPair, type FilterMode, type MatrixEdge, type PlayerLine,
  type ProgressionPoint, type ProgressionStat, type SeriesKey, type TeamLine,
} from '../components/stats/types'
import {
  CaretLeft, Check as CheckIcon, Gear, Handshake, NotePencil, PencilSimple,
  Plus as PlusIcon, Scales, Trash, Trophy, X as XIcon,
} from '@phosphor-icons/react'

type PlayerStat = {
  player_id: number; player_name: string; goals: string; assists: string
  turnovers: string; games_played: string; ga_rank: number
}
type CumulativeRow = {
  game_id: number; opponent: string; game_date: string
  player_id: number; player_name: string; goals: string; assists: string; turnovers: string
}
type Season = { id: number; name: string; year: number; organizer: string | null; start_date: string | null; end_date: string | null }
type StatsSeasonRow = { id: number; name: string; year: number; organizer: string | null; game_count: string }
// The columns of `games` this page reads. Scores are derived live from
// game_events by useGetGames, not stored; `result` is a stored column no
// write path populates, which is why the team card treats the live score as
// the source of truth and lets only an explicit override outrank it.
type Game = {
  id: number; opponent: string; game_date: string; game_time: string | null; season_id: number | null
  our_score?: number | null; their_score?: number | null
  result?: string | null; outcome_override?: string | null
}

// "0.9 / gm" under a raw total. Returns undefined rather than "0.0 / gm"
// when there are no games, so the hint disappears instead of asserting a
// rate nothing supports.
function perGame(total: string | number, gamesPlayed: string | number): string | undefined {
  const g = Number(gamesPlayed)
  if (!Number.isFinite(g) || g <= 0) return undefined
  return `${(Number(total) / g).toFixed(1)} / gm`
}

// The two cells that close a leader card. A leader's card is meant to be
// their whole line, which is why it carries the stats that did *not* put them
// on it. With turnovers gated off there is only one of those left, so the
// second cell falls back to G+A -- the strip is two columns at every width by
// design, and one lonely cell is a different object from the team card
// beside it.
function secondaryFor(hero: SeriesKey, p: PlayerLine | null): { label: string; series?: SeriesKey; value: number }[] {
  const other: SeriesKey = hero === 'goals' ? 'assists' : 'goals'
  const cells: { label: string; series?: SeriesKey; value: number }[] = [
    { label: other === 'goals' ? 'Goals' : 'Assists', series: other, value: p?.[other] ?? 0 },
  ]
  if (SHOW_TURNOVERS) cells.push({ label: 'Turnovers', series: 'turnovers', value: p?.turnovers ?? 0 })
  else cells.push({ label: 'G+A', value: (p?.goals ?? 0) + (p?.assists ?? 0) })
  return cells
}

function seasonLabel(s: { name: string; year: number; organizer: string | null }) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

// A stable identity for "no pairings yet", so the memos that derive the
// chemistry list and the matrix edges off it do not recompute every render.
const NO_PAIRINGS: PairingRow[] = []

type PageTab = 'me' | 'overview' | 'table' | 'standings'

// URL words for each tab, readable rather than the internal PageTab keys
// ("table" predates the "Player Rankings" label — see the PageTab comment
// above and doesn't belong in a URL a person actually reads).
const PAGE_TABS: { key: PageTab; label: string; slug: string }[] = [
  { key: 'me', label: 'Me', slug: 'me' },
  { key: 'overview', label: 'Overview', slug: 'overview' },
  { key: 'table', label: 'Player Rankings', slug: 'rankings' },
  { key: 'standings', label: 'League Standings', slug: 'standings' },
]

function pageTabForSlug(slug: string | undefined, tabs: { key: PageTab; slug: string }[]): PageTab {
  return tabs.find(t => t.slug === slug)?.key ?? 'overview'
}

export default function Stats() {
  const navigate = useNavigate()
  const { isGuest, currentTeamId } = useAuth()
  // The active sub-tab mirrors this URL segment, so a reload, browser
  // back/forward, or a bookmarked/shared link lands on the right sub-tab
  // instead of always resetting to Overview.
  const { subtab } = useParams<{ subtab: string }>()
  // A guest holds no membership and can never claim a roster spot, so "Me"
  // never appears for one -- there is nothing there but a claim picker that
  // would 403 on every selection.
  const visibleTabs = useMemo(() => PAGE_TABS.filter(t => t.key !== 'me' || !isGuest), [isGuest])
  const pageTab = pageTabForSlug(subtab, visibleTabs)

  // The scope filter lives up here, not in PlayerStatsView, because it now
  // renders inline in the page header beside the title -- and the header is
  // the one thing every sub-tab shares. Games and seasons come with it: the
  // picker needs both lists, and fetching them again one level down would be
  // the same two queries twice.
  const { data: games, trigger: fetchGames } = useGetGames()
  const { data: seasons, trigger: fetchSeasons } = useGetSeasons()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()

  const [filterType, setFilterType] = useState<'all' | 'season' | 'games'>('all')
  const [selectedSeasonIds, setSelectedSeasonIds] = useState<number[]>([])
  const [selectedGameIds, setSelectedGameIds] = useState<number[]>([])
  const [defaultSeasonId, setDefaultSeasonId] = useState<number | null>(null)

  useEffect(() => {
    if (subtab && !visibleTabs.some(t => t.slug === subtab)) navigate('/stats', { replace: true })
  }, [subtab, visibleTabs])

  useEffect(() => {
    if (currentTeamId == null) return
    fetchGames({ organizationId: currentTeamId })
    fetchSeasons({ organizationId: currentTeamId })
    fetchAllSeasons({ organizationId: currentTeamId })
  }, [currentTeamId])

  // Land on the latest Jam season that has actually been played, rather than
  // on every game ever recorded. Exactly once: the guard used to be
  // "filterType is still all and nothing is selected", which is also true
  // the moment someone deliberately switches back to All-time, so any later
  // refetch of games/seasons would quietly drag them back into a season.
  const defaultAppliedRef = useRef(false)
  useEffect(() => {
    if (defaultAppliedRef.current) return
    const s = seasons as StatsSeasonRow[] | undefined
    const allS = allSeasons as Season[] | undefined
    const g = games as Game[] | undefined
    if (!s || s.length === 0 || !allS || allS.length === 0 || !g) return
    defaultAppliedRef.current = true
    const id = getLatestJamSeasonWithPlayedGame(allS, g, s[0]!.id)
    setDefaultSeasonId(id)
    setFilterType('season')
    setSelectedSeasonIds([id])
  }, [seasons, allSeasons, games])

  const handleModeChange = (mode: FilterMode) => {
    setFilterType(mode)
    // Switching back into Season mode with nothing selected reads as "all
    // seasons", which is the same view as All-time and makes the segment
    // that was just clicked look inert. Reinstate the season the page
    // opened on instead.
    setSelectedSeasonIds(mode === 'season' && defaultSeasonId != null ? [defaultSeasonId] : [])
    // Games mode lands on the most recent game that has actually been
    // played, for the same reason. Empty was worse than inert here: with
    // nothing selected the fetch effect below fires no query at all, so
    // every panel kept showing the *previous* range's numbers under a
    // segment that now says "Games" -- stale data wearing a fresh label.
    // `games` is date-desc from the hook, so the first past one is the
    // latest. A user who wants several picks them from the slot beside it.
    const latest = mode === 'games'
      ? ((games as Game[] | undefined) ?? []).find(g => isPastGame(g))
      : undefined
    setSelectedGameIds(latest ? [latest.id] : [])
  }

  return (
    <div className="stats-scope space-y-5">
      <StatsHeader
        title="Stats"
        tabs={visibleTabs}
        activeKey={pageTab}
        onSelect={key => {
          const t = visibleTabs.find(v => v.key === key)!
          navigate(t.key === 'overview' ? '/stats' : `/stats/${t.slug}`)
        }}
      >
        {pageTab !== 'standings' && (
          <FilterBar
            mode={filterType}
            onModeChange={handleModeChange}
            seasons={(allSeasons as Season[] | undefined) ?? []}
            selectedSeasonIds={selectedSeasonIds}
            onSeasonsChange={setSelectedSeasonIds}
            games={(games as Game[] | undefined) ?? []}
            selectedGameIds={selectedGameIds}
            onGamesChange={setSelectedGameIds}
          />
        )}
      </StatsHeader>

      {pageTab === 'standings' ? <Standings /> : (
        <PlayerStatsView
          tab={pageTab as 'me' | 'overview' | 'table'}
          games={(games as Game[] | undefined)}
          allSeasons={(allSeasons as Season[] | undefined)}
          filterType={filterType}
          selectedSeasonIds={selectedSeasonIds}
          selectedGameIds={selectedGameIds}
          defaultSeasonId={defaultSeasonId}
        />
      )}
    </div>
  )
}

// Overview and Table share one Filters card and one useGetPlayerStats
// fetch (previously split across the Stats and Ranking pages, which
// duplicated the same filter UI and query); only the content below the
// filters differs by tab.
function PlayerStatsView({
  tab, games, allSeasons, filterType, selectedSeasonIds, selectedGameIds, defaultSeasonId,
}: {
  tab: 'me' | 'overview' | 'table'
  /** Hoisted to Stats() along with the filter below -- see the comment there. */
  games: Game[] | undefined
  allSeasons: Season[] | undefined
  filterType: FilterMode
  selectedSeasonIds: number[]
  selectedGameIds: number[]
  /** The season the page opened on; seeds the progression chart's own picker. */
  defaultSeasonId: number | null
}) {
  const { currentTeamId, user } = useAuth()
  const link = useMyPlayerLink()
  const claim = useClaimPlayer()
  const teamLinks = useGetTeamPlayerLinks()
  const { data: stats, loading, error, trigger: fetchStats } = useGetPlayerStats()
  const { data: cumulativeRaw, loading: cumulativeLoading, trigger: fetchCumulative } = useGetCumulativeStats()
  const { data: progressionRoster, trigger: fetchProgressionRoster } = useGetPlayers()
  const { data: pairings, loading: pairingsLoading, error: pairingsError, trigger: fetchPairings } = useGetAssistPairings()
  // Org-wide, unscoped by season (unlike progressionRoster above) — just a
  // gender_match lookup for the Assist Network's node outlines.
  const { data: orgPlayers, error: orgPlayersError, trigger: fetchOrgPlayers } = useGetPlayers()

  // Shared between the Assists and Goals network graphs, so selecting a
  // player in one highlights them in the other too.
  const [networkSelectedId, setNetworkSelectedId] = useState<number | null>(null)
  const [includeSubsInNetwork, setIncludeSubsInNetwork] = useState(true)

  // ALL_SEASONS (-1) means "every game"; null means "not resolved yet", which
  // is what keeps the fetch below from firing an all-time query on mount and
  // then immediately refiring for the default season.
  const [cumulativeSeasonId, setCumulativeSeasonId] = useState<number | null>(null)
  const [cumulativeStat, setCumulativeStat] = useState<ProgressionStat>('ga')
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([])

  useEffect(() => {
    if (currentTeamId == null) return
    fetchOrgPlayers({ organizationId: currentTeamId })
  }, [currentTeamId])

  // The progression chart has its own season picker, independent of the page
  // filter; it just opens on the same season the page did.
  useEffect(() => {
    if (defaultSeasonId != null && cumulativeSeasonId == null) setCumulativeSeasonId(defaultSeasonId)
  }, [defaultSeasonId])

  useEffect(() => {
    if (currentTeamId == null) return
    // limit: 200 is a practical "all pairs" ceiling — the Top Pairings card
    // and the Assist Network's two graphs (Assists and Goals, which now
    // read the same pairing data) each derive their own view from this one
    // fetch rather than hitting the network separately per view.
    if (filterType === 'all') {
      fetchStats({ organizationId: currentTeamId })
      fetchPairings({ organizationId: currentTeamId, limit: 200 })
    } else if (filterType === 'season') {
      if (selectedSeasonIds.length > 0) {
        fetchStats({ seasonIds: selectedSeasonIds, organizationId: currentTeamId })
        fetchPairings({ seasonIds: selectedSeasonIds, organizationId: currentTeamId, limit: 200 })
      } else {
        fetchStats({ organizationId: currentTeamId })
        fetchPairings({ organizationId: currentTeamId, limit: 200 })
      }
    } else if (filterType === 'games' && selectedGameIds.length > 0) {
      fetchStats({ gameIds: selectedGameIds, organizationId: currentTeamId })
      fetchPairings({ gameIds: selectedGameIds, organizationId: currentTeamId, limit: 200 })
    }
  }, [filterType, selectedSeasonIds, selectedGameIds, currentTeamId])

  useEffect(() => {
    if (currentTeamId == null || cumulativeSeasonId == null) return
    if (cumulativeSeasonId !== ALL_SEASONS) {
      fetchCumulative({ seasonId: cumulativeSeasonId, organizationId: currentTeamId })
      fetchProgressionRoster({ seasonIds: [cumulativeSeasonId], organizationId: currentTeamId })
    } else {
      fetchCumulative({ organizationId: currentTeamId })
      fetchProgressionRoster({ organizationId: currentTeamId })
    }
    setSelectedPlayerIds([])
  }, [cumulativeSeasonId, currentTeamId])

  // "Me" tab only: who am I on this roster, and which players are already
  // spoken for (pending or approved) so the claim picker doesn't offer a
  // name someone else already claimed. Skipped for the other two tabs --
  // there's no reason to run these queries while looking at Overview/Table.
  useEffect(() => {
    if (tab !== 'me' || currentTeamId == null || !user) return
    link.trigger({ teamId: currentTeamId, userId: user.id })
    teamLinks.trigger({ teamId: currentTeamId })
  }, [tab, currentTeamId, user])

  // ── One commit per range change ─────────────────────────────────────────
  // The range filter fires two independent queries -- player_stats and assist
  // pairings -- with two independent latencies, and the panels below read one
  // or the other. Publishing each result the moment it lands makes a single
  // click on "Season" settle the page twice: the KPI cards and the leaderboard
  // change at ~260ms (the leaderboard losing 210px and dragging everything
  // under it up with it), chemistry and the assist web change again at ~480ms.
  // Two jolts 200ms apart read as the page assembling itself out of parts.
  //
  // So the page holds the last settled pair until every query this tab reads
  // has come back, then commits all of it in one step. Overview reads both;
  // Me and Player Rankings read only player_stats and must not wait on a
  // round trip for a panel that is not on screen.
  //
  // `settled` is written during render deliberately: it is derived from this
  // render's own data and is idempotent, and an effect would publish one
  // paint late -- which is the flash this exists to remove.
  const rangePending = loading || (tab === 'overview' && pairingsLoading)
  const settled = useRef<{ stats?: PlayerStat[]; pairings?: PairingRow[] }>({})
  if (!rangePending) {
    settled.current = {
      stats: stats as PlayerStat[] | undefined,
      // On a tab that does not read pairings, keep whatever was last
      // committed rather than publishing a half-loaded set to a tab the user
      // may be about to switch to.
      pairings: pairingsLoading ? settled.current.pairings : (pairings as PairingRow[] | undefined),
    }
  }
  const statsArr = settled.current.stats

  // "Me" tab: the claimed player's own row from the exact same `stats`
  // query the Table tab renders (same Filters card, same fetch) -- so
  // whatever a member sees here always matches their row over there. No
  // separate aggregate query for "my stats".
  const mine = link.data && link.data.status === 'approved'
    ? statsArr?.find(s => s.player_id === link.data!.player_id)
    : undefined
  // Roster players nobody has claimed yet (pending or approved) -- offering
  // an already-linked player would just 403 against player_links' unique
  // (player_id) constraint.
  const linkedPlayerIds = new Set((teamLinks.data ?? []).map(l => l.player_id))
  const unclaimedPlayers = ((orgPlayers as { id: number; display_name: string } [] | undefined) ?? [])
    .filter(p => !linkedPlayerIds.has(p.id))
    .map(p => ({ id: String(p.id), label: p.display_name }))

  // ── Presentation lines ──────────────────────────────────────────────────
  // One parse of the string-typed SQL aggregates, shared by the KPI cards and
  // the leaderboard so the two can never disagree about who is top. Photos
  // come off the org roster, not off `stats`: player_stats is an aggregate
  // over game events and carries no profile columns at all.
  const playerLines: PlayerLine[] = useMemo(() => {
    const photoById = new Map(
      ((orgPlayers as { id: number; photo_url: string | null }[] | undefined) ?? [])
        .map(p => [p.id, p.photo_url] as const),
    )
    return (statsArr ?? []).map(p => ({
      playerId: p.player_id,
      name: p.player_name,
      shortName: shortName(p.player_name),
      photoUrl: photoById.get(p.player_id) ?? null,
      goals: parseInt(p.goals),
      assists: parseInt(p.assists),
      turnovers: parseInt(p.turnovers),
      gamesPlayed: parseInt(p.games_played),
    }))
  }, [statsArr, orgPlayers])

  const topFinisher = [...playerLines].sort((a, b) => b.goals - a.goals)[0] ?? null
  const topPlaymaker = [...playerLines].sort((a, b) => b.assists - a.assists)[0] ?? null
  const teamGoals = playerLines.reduce((sum, p) => sum + p.goals, 0)
  const teamAssists = playerLines.reduce((sum, p) => sum + p.assists, 0)

  // The leaderboard is capped at 12 rows -- past that the bars are too short
  // to compare against each other and the panel outruns the viewport. Ranked
  // by G+A, the same order the summary table opens in.
  const chartLines = useMemo(
    () => [...playerLines].sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists)).slice(0, 12),
    [playerLines],
  )

  // ── Cumulative line chart data ───────────────────────────────────────────────
  const { lineData, allPlayersForSelection, topPlayers } = useMemo(() => {
    const rows = cumulativeRaw as CumulativeRow[] | undefined
    if (!rows || rows.length === 0) return { lineData: [], allPlayersForSelection: [], topPlayers: [] }

    // Build game order from ALL games in the season (not just games with events),
    // so the chart shows a flat segment for games where a player had zero contributions.
    const allGamesForSeason = ((games as Game[] | undefined) ?? [])
      .filter(g => cumulativeSeasonId === ALL_SEASONS || g.season_id === cumulativeSeasonId)
      .slice() // date-desc from hook, so reverse for chronological order
      .reverse()
    const gameOrder: { game_id: number; opponent: string; game_date: string }[] = allGamesForSeason.map(g => ({
      game_id: g.id, opponent: g.opponent, game_date: g.game_date,
    }))

    const perGamePlayer: Record<number, Record<number, { goals: number; assists: number; turnovers: number }>> = {}
    for (const r of rows) {
      if (!perGamePlayer[r.game_id]) perGamePlayer[r.game_id] = {}
      if (!perGamePlayer[r.game_id]![r.player_id]) {
        perGamePlayer[r.game_id]![r.player_id] = { goals: 0, assists: 0, turnovers: 0 }
      }
      const existing = perGamePlayer[r.game_id]![r.player_id]!
      existing.goals += parseInt(r.goals)
      existing.assists += parseInt(r.assists)
      existing.turnovers += parseInt(r.turnovers)
    }

    const playerTotals: Record<number, { name: string; total: number }> = {}
    for (const r of rows) {
      if (!playerTotals[r.player_id]) playerTotals[r.player_id] = { name: r.player_name, total: 0 }
      const v = cumulativeStat === 'goals' ? parseInt(r.goals)
        : cumulativeStat === 'assists' ? parseInt(r.assists)
        : cumulativeStat === 'turnovers' ? parseInt(r.turnovers)
        : parseInt(r.goals) + parseInt(r.assists)
      playerTotals[r.player_id]!.total += v
    }

    // Selection list = full season roster, not just players with events.
    // Players with stats sort first (by total desc), zero-stat players follow alphabetically.
    const withEvents = Object.entries(playerTotals)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, { name, total }]) => ({ id: parseInt(id), name, total }))
    const eventIds = new Set(withEvents.map(p => p.id))
    const rosterOnly = ((progressionRoster as { id: number; display_name: string }[] | undefined) ?? [])
      .filter(p => !eventIds.has(p.id))
      .map(p => ({ id: p.id, name: p.display_name, total: 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const allPlayersForSelection = [...withEvents, ...rosterOnly]

    // If specific players selected, use those; otherwise default to top 8
    let displayPlayers: { id: number; name: string }[]
    if (selectedPlayerIds.length > 0) {
      displayPlayers = allPlayersForSelection.filter(p => selectedPlayerIds.includes(p.id))
    } else {
      displayPlayers = allPlayersForSelection.slice(0, 8)
    }

    const cumulative: Record<number, number> = {}
    for (const p of displayPlayers) cumulative[p.id] = 0

    const lineData = gameOrder.map((game, idx) => {
      const point: Record<string, unknown> = { label: `G${idx + 1}`, fullLabel: `vs ${game.opponent}` }
      for (const p of displayPlayers) {
        const gs = perGamePlayer[game.game_id]?.[p.id] ?? { goals: 0, assists: 0, turnovers: 0 }
        const v = cumulativeStat === 'goals' ? gs.goals
          : cumulativeStat === 'assists' ? gs.assists
          : cumulativeStat === 'turnovers' ? gs.turnovers
          : gs.goals + gs.assists
        cumulative[p.id] += v
        point[String(p.id)] = cumulative[p.id]
      }
      return point
    })

    return { lineData, allPlayersForSelection, topPlayers: displayPlayers }
  }, [cumulativeRaw, cumulativeStat, selectedPlayerIds, games, cumulativeSeasonId, progressionRoster])

  // ── Team line ───────────────────────────────────────────────────────────
  // The games the current filter actually covers. This is the denominator for
  // every per-game rate on the page: the sum of each player's games_played
  // would count one game once per player who appeared in it, so a 12-player
  // roster over 5 games would divide the team's goals by sixty.
  const filteredGames = ((games as Game[] | undefined) ?? []).filter(g => {
    if (!isPastGame(g)) return false
    if (filterType === 'season' && selectedSeasonIds.length > 0) return g.season_id != null && selectedSeasonIds.includes(g.season_id)
    if (filterType === 'games' && selectedGameIds.length > 0) return selectedGameIds.includes(g.id)
    return true
  })
  const gamesInFilter = filteredGames.length

  const teamLine: TeamLine = useMemo(() => {
    let wins = 0, losses = 0, ties = 0, pointsFor = 0, pointsAgainst = 0
    for (const g of filteredGames) {
      const our = g.our_score ?? 0
      const their = g.their_score ?? 0
      pointsFor += our
      pointsAgainst += their
      // Same precedence the schedule ledger and Standings use: an explicit
      // outcome_override outranks the score (a forfeit has a result but no
      // goals), and otherwise the live score decides. `games.result` is never
      // written, so it is deliberately not consulted here.
      const override = g.outcome_override
      const won = override
        ? override.startsWith('Win') || override === 'Default Win'
        : our > their
      const tied = override ? override === 'Tie' : our === their
      if (tied) ties++
      else if (won) wins++
      else losses++
    }
    return {
      wins, losses, ties, pointsFor, pointsAgainst,
      gamesPlayed: filteredGames.length,
      avgGoals: gamesInFilter > 0 ? teamGoals / gamesInFilter : null,
      avgAssists: gamesInFilter > 0 ? teamAssists / gamesInFilter : null,
    }
  }, [filteredGames, gamesInFilter, teamGoals, teamAssists])
  // ── Chemistry and matrix ────────────────────────────────────────────────
  // pairingRows is the full fetched set, already sorted by count descending
  // (see useGetAssistPairings). The chemistry list takes the top slice; the
  // matrix takes all of them, because it filters by one player at a time and
  // a pairing outside the top ten is exactly the one a mid-roster player
  // needs to see.
  const pairingRows = settled.current.pairings ?? NO_PAIRINGS

  const orgPlayerMap = useMemo(() => new Map(
    ((orgPlayers as { id: number; photo_url: string | null; is_sub: boolean }[] | undefined) ?? [])
      .map(p => [p.id, p] as const),
  ), [orgPlayers])

  const chemistryPairs: ChemistryPair[] = useMemo(
    () => pairingRows.slice(0, 8).map(r => ({
      assisterId: r.assisterId,
      assisterName: r.assisterName,
      assisterPhotoUrl: orgPlayerMap.get(r.assisterId)?.photo_url ?? null,
      scorerId: r.scorerId,
      scorerName: r.scorerName,
      scorerPhotoUrl: orgPlayerMap.get(r.scorerId)?.photo_url ?? null,
      count: r.count,
    })),
    [pairingRows, orgPlayerMap],
  )

  // The matrix's roster: everyone with stats in range, ranked by assists
  // (the picker's default lands on the top assister), optionally minus subs.
  // No cap — the old graph capped at 30 because that many nodes on a ring is
  // already a hairball; a list has no such ceiling.
  const matrixPlayers = useMemo(
    () => [...playerLines]
      .filter(p => includeSubsInNetwork || orgPlayerMap.get(p.playerId)?.is_sub !== true)
      .sort((a, b) => b.assists - a.assists || b.goals - a.goals || a.name.localeCompare(b.name)),
    [playerLines, includeSubsInNetwork, orgPlayerMap],
  )

  const matrixEdges: MatrixEdge[] = useMemo(() => {
    const ids = new Set(matrixPlayers.map(p => p.playerId))
    return pairingRows
      .filter(r => ids.has(r.scorerId) && ids.has(r.assisterId))
      .map(r => ({ assisterId: r.assisterId, scorerId: r.scorerId, count: r.count }))
  }, [pairingRows, matrixPlayers])

  // Focus follows the data rather than an effect: a pinned player who drops
  // out of range (a filter change, subs toggled off) simply stops matching
  // and the matrix falls back to the top assister.
  const matrixSelectedId = networkSelectedId != null && matrixPlayers.some(p => p.playerId === networkSelectedId)
    ? networkSelectedId
    : matrixPlayers[0]?.playerId ?? null

  return (
    <div className="space-y-4">
      {tab === 'me' && (
        <>
          {link.data === undefined || teamLinks.data === undefined || orgPlayers === undefined ? (
            // `link` (is it me?), `teamLinks` (who else has already claimed
            // a spot?), and `orgPlayers` (the roster to pick from) must all
            // be in before the "no link yet" card can render at all --
            // unclaimedPlayers is derived from teamLinks and orgPlayers
            // together, and link/teamLinks are independent parallel calls
            // from the same effect with no ordering guarantee (orgPlayers
            // comes from a separate mount-time effect). If `link` resolved
            // first and this only checked `link.data`, the card would
            // render while teamLinks.data was still undefined, `?? []`
            // would yield an empty exclusion set, and every roster player
            // -- including ones someone else already claimed -- would
            // appear selectable.
            <section className="st-panel p-4">
              {link.error || teamLinks.error || orgPlayersError ? (
                <p className="text-sm text-destructive">
                  {link.error || teamLinks.error || orgPlayersError}
                </p>
              ) : (
                <Skeleton className="h-9 w-full" />
              )}
            </section>
          ) : !link.data ? (
            // No link yet: offer to claim a roster spot. A link never grants
            // any permission -- it only answers "whose stats are these" --
            // so a pending claim is harmless while it waits for approval.
            <section className="st-panel">
              <div className="st-panel-head">
                <span className="st-overline">Which player are you?</span>
              </div>
              <div className="space-y-3 p-4">
                <p className="st-meta">
                  Pick your name on the roster to see your own stats. A captain or
                  editor confirms it.
                </p>
                <PlayerCombobox
                  players={unclaimedPlayers}
                  value="__none__"
                  onValueChange={async id => {
                    if (id === '__none__') return
                    const ok = await claim.trigger({ playerId: Number(id) })
                    if (ok) {
                      track('player_claim_requested', { player_id: Number(id) })
                      if (currentTeamId != null && user) {
                        await link.trigger({ teamId: currentTeamId, userId: user.id })
                      }
                    }
                  }}
                  placeholder="Select your name"
                />
                {claim.error && <p className="text-sm text-destructive">{claim.error}</p>}
              </div>
            </section>
          ) : link.data.status === 'pending' ? (
            <section className="st-panel">
              <div className="st-panel-head">
                <span className="st-overline">Waiting for confirmation</span>
              </div>
              <p className="st-meta p-4">
                You've claimed a roster spot. A captain or editor needs to confirm it
                before your stats show up here.
              </p>
            </section>
          ) : statsArr === undefined ? (
            // Same shape as the gate above: `mine` is derived from `link`
            // (resolved by this point) AND `statsArr`, fetched by a separate
            // effect. Without this check, `mine` would read as undefined
            // while stats are still loading and fall through to the "no
            // stats yet" case below -- a wrong, if momentary, message.
            <section className="st-panel p-4">
              <Skeleton className="h-9 w-full" />
            </section>
          ) : mine ? (
            <>
              <h2 className="st-name text-lg">{mine.player_name}</h2>
              {/* The grid tracks the card count rather than being pinned at
                  four: with turnovers gated off, a lg:grid-cols-4 leaves a
                  quarter of the row empty. */}
              {/* Wrapper, not FadeIn -- see the card row on the Overview tab. */}
              <div className="st-swap" data-busy={rangePending}>
                <FadeIn className={`grid gap-3 ${SHOW_TURNOVERS ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1 sm:grid-cols-3'}`}>
                  <MetricCard label="Goals" value={mine.goals} series="goals" hint={perGame(mine.goals, mine.games_played)} />
                  <MetricCard label="Assists" value={mine.assists} series="assists" hint={perGame(mine.assists, mine.games_played)} />
                  {SHOW_TURNOVERS && (
                    <MetricCard label="Turnovers" value={mine.turnovers} series="turnovers" hint={perGame(mine.turnovers, mine.games_played)} />
                  )}
                  <MetricCard label="Games played" value={mine.games_played} />
                </FadeIn>
              </div>
            </>
          ) : (
            <section className="st-panel">
              <p className="st-meta p-8 text-center">No stats yet for the current filter.</p>
            </section>
          )}
        </>
      )}

      {tab === 'overview' && (
        <>
          {/* The three cards that open the page. They render whenever the
              filter covers any games at all -- the leader cards carry their
              own "no player data" state, so a range with games but no
              recorded stats still shows the team's record rather than
              collapsing the whole row. */}
          {(playerLines.length > 0 || gamesInFilter > 0) && (
            /* The dim goes on a wrapper, never on FadeIn itself: FadeIn's
               entrance runs with `animation-fill-mode: both`, so the
               animation keeps ownership of `opacity` after it ends and a
               transition on the same element never runs -- the card row would
               snap to 40% and back while every panel below it faded. */
            <div className="st-swap" data-busy={rangePending && playerLines.length > 0}>
              <FadeIn className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <LeaderCard
                  overline="Top finisher"
                  icon={<Trophy className="h-3.5 w-3.5" weight="bold" />}
                  series="goals"
                  player={topFinisher}
                  value={topFinisher?.goals ?? 0}
                  unit="Goals"
                  teamTotal={teamGoals}
                  secondary={secondaryFor('goals', topFinisher)}
                />
                <LeaderCard
                  overline="Top playmaker"
                  icon={<Handshake className="h-3.5 w-3.5" weight="bold" />}
                  series="assists"
                  player={topPlaymaker}
                  value={topPlaymaker?.assists ?? 0}
                  unit="Assists"
                  teamTotal={teamAssists}
                  secondary={secondaryFor('assists', topPlaymaker)}
                />
                <TeamCard icon={<Scales className="h-3.5 w-3.5" weight="bold" />} team={teamLine} />
              </FadeIn>
            </div>
          )}

          {/* The leaderboard. Everything it needs is already parsed into
              chartLines, so the panel takes no query and no filter state --
              the same boundary GameRow keeps against `games`. */}
          <PerformanceChart
            players={chartLines}
            loading={rangePending}
            error={error ? `Error: ${error}` : null}
            emptyLabel={filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view stats' : 'No stats available yet'}
          />

          {/* Who connects with whom. Takes joined pairs and nothing else --
              it never sees a game_events row or a filter. */}
          <ChemistryHub
            pairs={chemistryPairs}
            loading={rangePending}
            error={pairingsError ? `Error: ${pairingsError}` : null}
            emptyLabel={filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view stats' : 'No assisted goals in this range yet'}
          />

          {/* One player's connections, both directions -- as a web of the
              whole roster (default) or as two ranked lists. It takes joined
              edges and a selection and nothing else. */}
          <AssistMatrix
            players={matrixPlayers}
            edges={matrixEdges}
            selectedId={matrixSelectedId}
            onSelect={setNetworkSelectedId}
            includeSubs={includeSubsInNetwork}
            onIncludeSubsChange={setIncludeSubsInNetwork}
            loading={rangePending}
            error={pairingsError ? `Error: ${pairingsError}` : null}
            emptyLabel={filterType === 'games' && selectedGameIds.length === 0 ? 'Select games to view stats' : 'No assisted goals in this range yet'}
          />

          {/* Cumulative output, focus + dim. The season and player pickers
              live inside the panel because they scope this chart alone, not
              the page -- the page's own scope is the header's FilterBar. */}
          <ProgressionChart
            data={lineData as ProgressionPoint[]}
            players={topPlayers}
            roster={allPlayersForSelection}
            selectedPlayerIds={selectedPlayerIds}
            onSelectedPlayerIdsChange={setSelectedPlayerIds}
            seasons={(allSeasons as Season[] | undefined) ?? []}
            seasonId={cumulativeSeasonId ?? ALL_SEASONS}
            onSeasonChange={setCumulativeSeasonId}
            stat={cumulativeStat}
            onStatChange={setCumulativeStat}
            loading={cumulativeLoading}
          />
        </>
      )}

      {tab === 'table' && (
        <RankingsTable players={playerLines} loading={rangePending} />
      )}
    </div>
  )
}

function Standings() {
  const { can, currentTeamId } = useAuth()
  const { data: allSeasons, trigger: fetchAllSeasons } = useGetAllSeasons()
  const { data: league, loading: leagueLoading, error, trigger: fetchLeague } = useGetLeague()

  const { trigger: createTeam } = useCreateLeagueTeam()
  const { trigger: updateTeam } = useUpdateLeagueTeam()
  const { trigger: deleteTeam } = useDeleteLeagueTeam()
  const { trigger: updateSeasonPoints } = useUpdateSeasonPoints()

  const [selectedSeasonId, setSelectedSeasonId] = useState<number | undefined>(undefined)

  // Team detail page: all-time history (every season, not just the one
  // currently selected in the filter above) for whichever team row was
  // clicked in the standings table.
  const [detailTeam, setDetailTeam] = useState<LeagueTeam | null>(null)
  const [notesValue, setNotesValue] = useState('')
  const [editingNotes, setEditingNotes] = useState(false)
  const { data: oppHistory, loading: oppHistoryLoading, trigger: fetchOppHistory } = useGetOpponentHistory()

  useEffect(() => {
    if (detailTeam && currentTeamId != null) fetchOppHistory({ organizationId: currentTeamId, name: detailTeam.name })
  }, [detailTeam, currentTeamId])

  // Manage league dialog (teams + points config)
  const [manageOpen, setManageOpen] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [renamingTeamId, setRenamingTeamId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [pointsDraft, setPointsDraft] = useState({ win: '2', tie: '1', loss: '0' })

  useEffect(() => {
    if (currentTeamId == null) return
    fetchAllSeasons({ organizationId: currentTeamId })
  }, [currentTeamId])

  useEffect(() => {
    const seasons = allSeasons as Season[] | undefined
    if (!seasons || seasons.length === 0 || selectedSeasonId != null) return
    setSelectedSeasonId(getDefaultJamSeasonId(seasons, seasons[0]?.id))
  }, [allSeasons])

  useEffect(() => {
    if (selectedSeasonId != null) fetchLeague({ seasonId: selectedSeasonId })
  }, [selectedSeasonId])

  useEffect(() => {
    if (league) {
      setPointsDraft({
        win: String(league.season.win_points),
        tie: String(league.season.tie_points),
        loss: String(league.season.loss_points),
      })
    }
  }, [league])

  const refresh = () => { if (selectedSeasonId != null) fetchLeague({ seasonId: selectedSeasonId }) }

  const standings = useMemo(() => league ? computeStandings(league) : [], [league])
  const usTeam = league?.teams.find(t => t.is_us) ?? null

  // Column sort: clicking a header reorders the rows; "#" always shows the
  // official rank (points, then point diff, then points for) regardless of
  // which column the table is currently sorted by.
  const [standingsSortKey, setStandingsSortKey] = useState<StandingsSortKey>('rank')
  const [standingsSortDir, setStandingsSortDir] = useState<'asc' | 'desc'>('asc')

  const handleStandingsSortClick = (key: StandingsSortKey) => {
    if (standingsSortKey === key) setStandingsSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setStandingsSortKey(key)
      setStandingsSortDir(key === 'team' || key === 'rank' ? 'asc' : 'desc')
    }
  }

  const sortedStandings = useMemo(() => {
    const arr = [...standings]
    arr.sort((a, b) => {
      const cmp = standingsSortKey === 'team' ? a.team.name.localeCompare(b.team.name)
        : standingsSortKey === 'rank' ? a.rank - b.rank
        : standingsSortKey === 'games_played' ? a.games_played - b.games_played
        : standingsSortKey === 'wins' ? a.wins - b.wins
        : standingsSortKey === 'points_for' ? a.points_for - b.points_for
        : standingsSortKey === 'points_against' ? a.points_against - b.points_against
        : standingsSortKey === 'point_diff' ? a.point_diff - b.point_diff
        : a.points - b.points
      return standingsSortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [standings, standingsSortKey, standingsSortDir])

  // Form guide per team, oldest to newest, from every decided regular
  // game this season (not capped: one dot per game played).
  const formByTeam = useMemo(() => {
    const map = new Map<number, ('W' | 'L' | 'T')[]>()
    if (!league) return map
    const finals = league.games
      .filter(g => g.stage === 'regular' && g.is_final && g.eff_home_score != null && g.eff_away_score != null)
      .sort((a, b) => (a.game_date ?? '').localeCompare(b.game_date ?? ''))
    for (const g of finals) {
      for (const side of ['home', 'away'] as const) {
        const teamId = side === 'home' ? g.eff_home_team_id : g.eff_away_team_id
        if (teamId == null) continue
        const mine = side === 'home' ? g.eff_home_score! : g.eff_away_score!
        const theirs = side === 'home' ? g.eff_away_score! : g.eff_home_score!
        const outcome: 'W' | 'L' | 'T' = mine > theirs ? 'W' : mine < theirs ? 'L' : 'T'
        const arr = map.get(teamId) ?? []
        arr.push(outcome)
        map.set(teamId, arr)
      }
    }
    return map
  }, [league])

  const handleAddTeam = async () => {
    if (!newTeamName.trim() || selectedSeasonId == null || currentTeamId == null) return
    await createTeam({ seasonId: selectedSeasonId, name: newTeamName, organizationId: currentTeamId })
    track('league_team_created', { season_id: selectedSeasonId })
    setNewTeamName('')
    refresh()
  }

  const handleRenameTeam = async () => {
    if (renamingTeamId == null || !renameValue.trim()) return
    await updateTeam({ id: renamingTeamId, name: renameValue.trim() })
    track('league_team_renamed', { team_id: renamingTeamId })
    setRenamingTeamId(null)
    refresh()
  }

  const handleDeleteTeam = async (id: number) => {
    await deleteTeam({ id })
    track('league_team_deleted', { team_id: id })
    refresh()
  }

  const handleSavePoints = async () => {
    if (selectedSeasonId == null) return
    const win = parseInt(pointsDraft.win, 10)
    const tie = parseInt(pointsDraft.tie, 10)
    const loss = parseInt(pointsDraft.loss, 10)
    if ([win, tie, loss].some(isNaN)) return
    await updateSeasonPoints({ seasonId: selectedSeasonId, win_points: win, tie_points: tie, loss_points: loss })
    track('season_points_updated', { season_id: selectedSeasonId })
    refresh()
  }

  const handleSaveNotes = async () => {
    if (!detailTeam) return
    await updateTeam({ id: detailTeam.id, notes: notesValue.trim() || null })
    track('league_team_notes_updated', { team_id: detailTeam.id })
    setDetailTeam({ ...detailTeam, notes: notesValue.trim() || null })
    setEditingNotes(false)
    refresh()
  }

  // The table takes rows, not a league: it never sees a `league_teams` row,
  // a stage, or an eff_home_score. Same boundary GameRow keeps against
  // `games`, and the reason the form guide can be computed here where the
  // schedule's own rules already live.
  const standingsRows: StandingsRow[] = useMemo(
    () => sortedStandings.map(r => ({
      teamId: r.team.id,
      teamName: r.team.name + (r.team.is_us ? ' (us)' : ''),
      isUs: r.team.is_us,
      rank: r.rank,
      gamesPlayed: r.games_played,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
      pointsFor: r.points_for,
      pointsAgainst: r.points_against,
      pointDiff: r.point_diff,
      points: r.points,
      form: formByTeam.get(r.team.id) ?? [],
    })),
    [sortedStandings, formByTeam],
  )

  const seasons = (allSeasons as Season[] | undefined) ?? []
  const loading = leagueLoading || league == null

  // ── Opponent detail page ────────────────────────────────────────────────
  // Full history for one opponent name across every season it's appeared
  // in, not just the season currently selected by the filter above.
  if (detailTeam) {
    const oppTeams = oppHistory?.teams ?? []
    const oppGames = oppHistory?.games ?? []
    const usTeamsBySeasonId = oppHistory?.usTeamsBySeasonId ?? new Map<number, { id: number; name: string }>()
    const teamNamesById = oppHistory?.teamNamesById ?? new Map<number, string>()
    const nameForTeamId = (id: number | null) => (id == null ? 'TBD' : teamNamesById.get(id) ?? 'TBD')

    let allTimeH2h: { w: number; l: number; t: number } | null = null
    if (!detailTeam.is_us) {
      const record = { w: 0, l: 0, t: 0 }
      for (const g of oppGames) {
        if (!g.is_final || g.eff_home_score == null || g.eff_away_score == null) continue
        const us = usTeamsBySeasonId.get(g.season_id)
        if (!us) continue
        const weAreHome = g.eff_home_team_id === us.id
        const ourScore = weAreHome ? g.eff_home_score : g.eff_away_score
        const theirScore = weAreHome ? g.eff_away_score : g.eff_home_score
        if (ourScore > theirScore) record.w++
        else if (ourScore < theirScore) record.l++
        else record.t++
      }
      allTimeH2h = record
    }

    const detailSeason = oppTeams.find(t => t.id === detailTeam.id)

    return (
      <div className="space-y-4">
        <button type="button" className="st-btn" onClick={() => { setDetailTeam(null); setEditingNotes(false) }}>
          <CaretLeft className="h-3.5 w-3.5" weight="bold" />
          Standings
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <h2 className="st-title text-xl">{detailTeam.name}</h2>
          {detailTeam.is_us && <span className="st-chip">Us</span>}
        </div>

        {oppHistoryLoading && !oppHistory ? (
          <p className="st-meta">Loading…</p>
        ) : (
          <>
            {allTimeH2h && (
              <section className="st-panel st-kpi">
                <span className="st-overline">All-time head-to-head vs us</span>
                {/* Three outcomes, three tokens, one figure each — the same
                    up/down/tie family the standings differential uses, so a
                    win means one colour everywhere on the page. */}
                <div className="st-strip" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                  <div className="st-strip-cell st-up">
                    <span className="st-unit">Won</span>
                    <span className="st-figure st-figure--sm">{allTimeH2h.w}</span>
                  </div>
                  <div className="st-strip-cell st-down">
                    <span className="st-unit">Lost</span>
                    <span className="st-figure st-figure--sm">{allTimeH2h.l}</span>
                  </div>
                  <div className="st-strip-cell st-tie">
                    <span className="st-unit">Tied</span>
                    <span className="st-figure st-figure--sm">{allTimeH2h.t}</span>
                  </div>
                </div>
              </section>
            )}

            <section className="st-panel">
              <div className="st-panel-head"><span className="st-overline">Seasons played</span></div>
              <div className="p-3 sm:p-4">
                {oppTeams.length === 0 ? (
                  <p className="st-meta">No seasons yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {oppTeams.map(t => (
                      <span key={t.id} className="st-chip">
                        {seasonLabel({ name: t.season_name, year: t.season_year, organizer: t.season_organizer })}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="st-panel">
              <div className="st-panel-head"><span className="st-overline">All games</span></div>
              {oppGames.length === 0 ? (
                <p className="st-meta p-4">No games yet.</p>
              ) : (
                <div className="st-list">
                    {oppGames.map(g => {
                      const thisTeamId = oppTeams.find(t => t.season_id === g.season_id)?.id ?? null
                      const isThisTeamHome = g.eff_home_team_id === thisTeamId
                      const otherName = nameForTeamId(isThisTeamHome ? g.eff_away_team_id : g.eff_home_team_id)
                      const mine = isThisTeamHome ? g.eff_home_score : g.eff_away_score
                      const theirs = isThisTeamHome ? g.eff_away_score : g.eff_home_score
                      const decided = g.is_final && mine != null && theirs != null
                      const season = oppTeams.find(t => t.season_id === g.season_id)
                      return (
                        <div key={g.id} className="st-row">
                          <div className="min-w-0 flex-1">
                            <p className="st-name">vs {otherName}</p>
                            <p className="st-meta mt-0.5 truncate">
                              {season ? seasonLabel({ name: season.season_name, year: season.season_year, organizer: season.season_organizer }) : ''}
                              {' · '}{g.game_date ?? 'TBD'}
                            </p>
                          </div>
                          {decided ? (
                            <span className={`st-figure st-figure--sm shrink-0 ${mine! > theirs! ? 'st-up' : mine! < theirs! ? 'st-down' : 'st-tie'}`}>
                              {mine}-{theirs}
                            </span>
                          ) : (
                            <span className="st-unit shrink-0">Upcoming</span>
                          )}
                        </div>
                      )
                    })}
                </div>
              )}
            </section>

            {!detailTeam.is_us && (
              <section className="st-panel">
                <div className="st-panel-head">
                  <span className="st-overline">
                    <NotePencil className="h-3.5 w-3.5" weight="bold" />
                    Notes
                    {detailSeason && ` · ${seasonLabel({ name: detailSeason.season_name, year: detailSeason.season_year, organizer: detailSeason.season_organizer })}`}
                  </span>
                  {can.record && !editingNotes && (
                    <button type="button" className="st-link" onClick={() => setEditingNotes(true)}>Edit</button>
                  )}
                </div>
                <div className="p-3 sm:p-4">
                  {editingNotes ? (
                    <div className="space-y-2">
                      <textarea
                        value={notesValue}
                        onChange={e => setNotesValue(e.target.value)}
                        rows={4}
                        className="st-field"
                        placeholder="Scouting notes: their zone looks beatable deep..."
                      />
                      <div className="flex gap-1.5">
                        <button type="button" className="st-btn st-btn--accent" onClick={handleSaveNotes}>Save</button>
                        <button type="button" className="st-btn" onClick={() => { setEditingNotes(false); setNotesValue(detailTeam.notes ?? '') }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-[hsl(var(--st-ink-mid))]">
                      {detailTeam.notes || 'No notes yet.'}
                    </p>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SinglePicker
          items={seasons.map(s => ({ id: s.id, label: seasonLabel(s) }))}
          selectedId={selectedSeasonId ?? null}
          onChange={setSelectedSeasonId}
          placeholder="Select season"
          emptyLabel="No seasons yet"
        />
        {can.manageTeam && (
          <button
            type="button"
            className="st-btn st-btn--icon"
            onClick={() => setManageOpen(true)}
            aria-label="Manage standings"
            title="Manage standings"
          >
            <Gear className="h-4 w-4" weight="bold" />
          </button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <FadeIn>
        <StandingsTable
          rows={standingsRows}
          sortKey={standingsSortKey}
          sortDir={standingsSortDir}
          onSort={handleStandingsSortClick}
          onSelect={id => {
            const team = league?.teams.find(t => t.id === id)
            if (!team) return
            setDetailTeam(team)
            setNotesValue(team.notes ?? '')
            setEditingNotes(false)
          }}
          loading={loading}
          emptyLabel="No league teams yet. Add the teams in your league to start tracking standings."
        />
      </FadeIn>

      {/* Manage league: teams and points config */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="stats-scope max-w-md">
          <DialogHeader><DialogTitle className="st-title text-lg">Manage standings</DialogTitle></DialogHeader>
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="st-overline">Teams</p>
              <div className="st-list max-h-56 overflow-y-auto rounded-md border border-[hsl(var(--st-rule-strong))]">
                {(league?.teams ?? []).map(t => (
                  <div key={t.id} className="st-row">
                    {renamingTeamId === t.id ? (
                      <>
                        <input
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRenameTeam() }}
                          className="st-field"
                          autoFocus
                        />
                        <button type="button" className="st-btn st-btn--icon st-btn--accent" onClick={handleRenameTeam} aria-label="Save name">
                          <CheckIcon className="h-3.5 w-3.5" weight="bold" />
                        </button>
                        <button type="button" className="st-btn st-btn--icon" onClick={() => setRenamingTeamId(null)} aria-label="Cancel rename">
                          <XIcon className="h-3.5 w-3.5" weight="bold" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="st-name min-w-0 flex-1">{t.name}{t.is_us ? ' (us)' : ''}</span>
                        <button
                          type="button"
                          className="st-btn st-btn--icon"
                          style={{ height: '1.75rem', width: '1.75rem' }}
                          onClick={() => { setRenamingTeamId(t.id); setRenameValue(t.name) }}
                          aria-label={`Rename ${t.name}`}
                        >
                          <PencilSimple className="h-3.5 w-3.5" weight="bold" />
                        </button>
                        {!t.is_us && (
                          <button
                            type="button"
                            className="st-btn st-btn--icon"
                            style={{ height: '1.75rem', width: '1.75rem' }}
                            onClick={() => handleDeleteTeam(t.id)}
                            aria-label={`Delete ${t.name}`}
                          >
                            <Trash className="h-3.5 w-3.5" weight="bold" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-1.5">
                <input
                  value={newTeamName}
                  onChange={e => setNewTeamName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTeam() }}
                  placeholder="New team name"
                  className="st-field"
                />
                <button type="button" className="st-btn st-btn--accent" onClick={handleAddTeam} disabled={!newTeamName.trim()}>
                  <PlusIcon className="h-3.5 w-3.5" weight="bold" />
                  Add
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="st-overline">Standings points</p>
              <div className="grid grid-cols-3 gap-2">
                {(['win', 'tie', 'loss'] as const).map(k => (
                  <label key={k} className="space-y-1.5">
                    <span className="st-unit block">{k}</span>
                    <input
                      type="number" inputMode="numeric"
                      value={pointsDraft[k]}
                      onChange={e => setPointsDraft(p => ({ ...p, [k]: e.target.value }))}
                      className="st-field"
                      style={{ fontFamily: 'var(--st-mono)', fontVariantNumeric: 'tabular-nums' }}
                    />
                  </label>
                ))}
              </div>
              <button type="button" className="st-btn" onClick={handleSavePoints}>Save points</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
