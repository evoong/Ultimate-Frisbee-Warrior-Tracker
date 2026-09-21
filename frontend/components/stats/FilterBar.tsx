import { MultiPicker } from './Picker'
import Segmented, { type SegmentOption } from './Segmented'
import { seasonLabel, type FilterMode, type GameOption, type SeasonOption } from './types'
import './stats-theme.css'

// The page's scope control, sitting inline in the header beside the title.
// It replaces a titled "Filters" Card that carried a <Label> over a
// full-width <Select> plus, in Specific Games mode, a 160px-tall scrolling
// checkbox list — roughly a third of the first screen spent saying "this
// season" before a single number appeared.
//
// Three modes, not the two a season/all-time toggle would give: dropping
// Specific Games would drop a real capability, and it is the same idiom
// either way (pick a mode, then narrow it), so it costs one segment.

const MODES: SegmentOption<FilterMode>[] = [
  { key: 'all', label: 'All-time' },
  { key: 'season', label: 'Season' },
  { key: 'games', label: 'Games' },
]

export default function FilterBar({
  mode, onModeChange,
  seasons, selectedSeasonIds, onSeasonsChange,
  games, selectedGameIds, onGamesChange,
}: {
  mode: FilterMode
  onModeChange: (mode: FilterMode) => void
  seasons: SeasonOption[]
  selectedSeasonIds: number[]
  onSeasonsChange: (ids: number[]) => void
  games: GameOption[]
  selectedGameIds: number[]
  onGamesChange: (ids: number[]) => void
}) {
  return (
    // The whole group is one fixed-width object: equal-width segments, then a
    // picker slot that is reserved whether or not a picker is in it. Both
    // halves of that are in stats-theme.css with the reasoning; the short
    // version is that this sits at the right-hand end of the page header, so
    // anything that changes its width when the mode changes moves the header
    // — and on a narrow window, re-wraps it and shoves the page down.
    <div className="st-scope">
      <Segmented
        options={MODES}
        value={mode}
        onChange={onModeChange}
        ariaLabel="Stat range"
      />

      <div className="st-scope-slot">
        {mode === 'season' && (
          <MultiPicker
            items={seasons.map(s => ({ id: s.id, label: seasonLabel(s) }))}
            selectedIds={selectedSeasonIds}
            onChange={onSeasonsChange}
            placeholder="All seasons"
            emptyLabel="No seasons yet"
            unit="seasons"
          />
        )}

        {mode === 'games' && (
          <MultiPicker
            items={games.map(g => {
              const season = seasons.find(s => s.id === g.season_id)
              return {
                id: g.id,
                label: `vs ${g.opponent}`,
                hint: new Date(g.game_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                // The season used to sit inline beside every row, which made
                // each option two competing lines of text; it is the one field
                // the date does not already disambiguate, so it moves to the
                // row's title rather than out of the UI.
                title: season ? `vs ${g.opponent} — ${seasonLabel(season)}` : undefined,
              }
            })}
            selectedIds={selectedGameIds}
            onChange={onGamesChange}
            placeholder="Pick games"
            emptyLabel="No games yet"
            unit="games"
          />
        )}
      </div>
    </div>
  )
}
