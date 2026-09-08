import { MultiPicker } from './Picker'
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

const MODES: { key: FilterMode; label: string }[] = [
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
    <div className="flex flex-wrap items-center gap-2">
      <div className="st-seg" role="group" aria-label="Stat range">
        {MODES.map(m => (
          <button
            key={m.key}
            type="button"
            className="st-seg-btn"
            data-active={mode === m.key}
            aria-pressed={mode === m.key}
            onClick={() => onModeChange(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

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
  )
}
