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

/**
 * Advances the "last settled range" ref one render at a time and reports
 * whether the range is still pending.
 *
 * This is the one commit-per-range-change gate from Stats.tsx, pulled out so
 * it can be unit tested on its own: Stats.tsx wires up auth, routing and half
 * a dozen backend hooks, which makes mounting it in a test impractical, but
 * the actual logic here is pure and does not need any of that.
 *
 * The write must be gated on the in-flight terms only (`loading` /
 * `pairingsLoading`), never on `rangePending` itself. `isRangePending` reports
 * pending whenever `previous.stats` is undefined, so gating the write on that
 * value would mean: the write never runs (it is guarded by the very thing
 * that starts undefined and only a successful write can change), the ref
 * stays undefined forever, and the caller renders skeletons permanently. This
 * bug shipped once already -- see the git history on this file's tests.
 */
export function settleRange<Stats, Pairings>({
  previous, statsIn, pairingsIn, loading, readsPairings, pairingsLoading,
}: {
  /** The range settled on the previous render. */
  previous: { stats?: Stats; pairings?: Pairings }
  /** The stats the in-flight (or just-completed) fetch currently holds. */
  statsIn: Stats | undefined
  /** The pairings the in-flight (or just-completed) fetch currently holds. */
  pairingsIn: Pairings | undefined
  /** A player_stats request is in flight. */
  loading: boolean
  /** This tab renders a panel fed by assist pairings. */
  readsPairings: boolean
  /** A pairings request is in flight. */
  pairingsLoading: boolean
}): { nextSettled: { stats?: Stats; pairings?: Pairings }; rangePending: boolean } {
  const fetchPending = loading || (readsPairings && pairingsLoading)
  const nextSettled = fetchPending
    ? previous
    : {
        stats: statsIn,
        // On a tab that does not read pairings, keep whatever was last
        // committed rather than publishing a half-loaded set to a tab the
        // user may be about to switch to.
        pairings: pairingsLoading ? previous.pairings : pairingsIn,
      }
  const rangePending = isRangePending({
    settledStats: nextSettled.stats,
    loading,
    readsPairings,
    pairingsLoading,
  })
  return { nextSettled, rangePending }
}
