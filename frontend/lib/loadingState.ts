/**
 * Whether the current range has anything to show yet.
 *
 * The subtle case is the first one: `useApiCall` starts `loading` at false, and
 * on a cold load no fetch has fired at all while the default season is still
 * resolving from three parallel queries. A page that only asks "is a request in
 * flight" therefore reads that window as *empty* and renders its empty state
 * before it has asked for anything. `settledStats === undefined` is what
 * distinguishes "not started" from "came back with nothing".
 *
 * Same shape as the gate at pages/Roster.tsx:1162, which covers the identical
 * window with `players === undefined && (loading || awaitingSeasonDefault)`.
 */
export function isRangePending({ settledStats, loading, readsPairings, pairingsLoading }: {
  /** The last committed stats, or undefined if none has ever landed. */
  settledStats: unknown
  /** A player_stats request is in flight. */
  loading: boolean
  /** This tab renders a panel fed by assist pairings. */
  readsPairings: boolean
  /** A pairings request is in flight. */
  pairingsLoading: boolean
}): boolean {
  if (settledStats === undefined) return true
  if (loading) return true
  return readsPairings && pairingsLoading
}
