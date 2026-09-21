// Feature flags for stats the app can store but cannot yet collect.
//
// Turnovers are the only one today. Every turnover surface -- the leaderboard
// series, the rankings column, the progression stat, the box score column,
// the Roster breakdowns -- was reading a number that is always 0, because no
// screen in the app can record a `Turnover`, `Throwaway` or `Drop` event
// (see `TURNOVER_EVENT_TYPES` in lib/eventUtils.ts: the classification is
// still there, and so are the aggregations that feed off it). A column of
// zeros is worse than no column: it reads as "this team never turns it over"
// rather than as "nobody tracked it".
//
// So the data path stays whole and only the display is gated. Flip this to
// `true` the day a turnover can be entered and every surface comes back with
// its layout, colours and ordering intact -- nothing here deletes anything.
export const SHOW_TURNOVERS = false
