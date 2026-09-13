import { useState } from 'react'
import { CaretDown, Check } from '@phosphor-icons/react'
import { Popover, PopoverContent, PopoverTrigger } from '../../lib/shadcn/popover'
import './schedule-theme.css'

// The schedule's season filter. It used to be a full-width bordered select on
// its own row under the header -- a form input asking you to fill it in, when
// what it actually reports is *which schedule you are looking at*. That is a
// piece of the page's title, not a field, so it now sits inline beside the
// <h1> as a ghost control: no surface and no border until you point at it.
//
// It is deliberately not the Stats page's Picker: that one is `--st-*` scoped
// and carries a hairline frame to match the segmented controls beside it. The
// same object here would put a box back next to the heading, which is the
// thing being removed. Same anatomy, schedule tokens, no chrome at rest.

type Season = { id: number; name: string; year: number; organizer: string | null }

function seasonLabel(s: Season) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

interface Props {
  seasons: Season[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  /** Shown when nothing is picked, which the query reads as "every season". */
  placeholder?: string
  className?: string
}

export default function SeasonPicker({
  seasons,
  selectedIds,
  onChange,
  placeholder = 'All seasons',
  className = '',
}: Props) {
  const [open, setOpen] = useState(false)

  const toggle = (id: number) =>
    onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id])

  // One selected season names itself; several collapse to a count, because
  // three season names side by side is a paragraph, not a title. No count
  // badge beside that: "3 seasons 3" is the label saying the same number
  // twice, and a ghost control next to an <h1> cannot afford the noise.
  const only = selectedIds.length === 1 ? seasons.find(s => s.id === selectedIds[0]) : undefined
  const label = selectedIds.length === 0
    ? placeholder
    : only
      ? seasonLabel(only)
      : `${selectedIds.length} seasons`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`schedule-scope sch-season ${className}`}
          data-empty={selectedIds.length === 0 ? 'true' : undefined}
          aria-label={`Filter the schedule by season — currently ${label}`}
        >
          <span className="sch-season-label">{label}</span>
          <CaretDown className="sch-season-caret h-3.5 w-3.5 shrink-0" weight="bold" />
        </button>
      </PopoverTrigger>
      {/* Radix portals to <body>, outside `.schedule-scope`, so the panel has
          to carry the scope itself or every --sch-* inside resolves to
          nothing and it renders unstyled. */}
      <PopoverContent
        align="start"
        sideOffset={6}
        className="schedule-scope w-[17.5rem] rounded-md border-0 bg-transparent p-0 shadow-none"
      >
        <div className="sch-menu max-h-[19rem] overflow-y-auto p-1.5">
          {seasons.length === 0 ? (
            <p className="sch-menu-empty">No seasons yet</p>
          ) : (
            <>
              <div className="sch-menu-head">
                <span className="sch-menu-overline">
                  {seasons.length} season{seasons.length === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  className="sch-menu-link"
                  data-active={selectedIds.length === 0 ? 'true' : undefined}
                  onClick={() => onChange([])}
                >
                  {placeholder}
                </button>
              </div>
              {seasons.map(s => {
                const checked = selectedIds.includes(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    className="sch-option"
                    data-checked={checked}
                    aria-pressed={checked}
                    onClick={() => toggle(s.id)}
                  >
                    <span className="sch-option-box">
                      <Check className="h-2.5 w-2.5" weight="bold" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{seasonLabel(s)}</span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
