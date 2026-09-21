import { useState, type ReactNode } from 'react'
import { CaretDown, Check } from '@phosphor-icons/react'
import { Avatar, AvatarFallback, AvatarImage } from '../../lib/shadcn/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '../../lib/shadcn/popover'
import { crestInitials } from './types'
import './stats-theme.css'

// One dropdown idiom for the whole Stats page: the scope filter's seasons and
// games, the assist matrix's player, the progression chart's season. Seasons
// and games and players differ only in what fills `items` — giving each its
// own control is how a page ends up with four dropdowns that almost match,
// which reads as an accident rather than as a set.
//
// It replaced three different controls that were doing this job: a shadcn
// <Select> under a <Label>, and two hand-rolled click-outside popovers
// (SeasonMultiSelect, PlayerMultiSelect) with their own trigger styling and
// their own lucide chevrons. Both of those are gone now -- SeasonMultiSelect
// when Roster moved to components/InlinePicker.tsx, the global-scope member
// of this family (see CLAUDE.md).

export type PickerItem = {
  id: number
  label: string
  /** Right-aligned secondary text on the option row (a date, a count). */
  hint?: string
  /** Full text for the row's title attribute when `label` is abbreviated. */
  title?: string
  /** Renders a crest on the option and on the trigger. */
  photoUrl?: string | null
  /** Opt a row out of a crest even in a picker that otherwise shows them. */
  crest?: boolean
}

function Crest({ item }: { item: PickerItem }) {
  return (
    <Avatar className="st-crest st-crest--xs">
      {item.photoUrl && <AvatarImage src={item.photoUrl} alt="" />}
      <AvatarFallback className="st-crest-text">{crestInitials(item.label)}</AvatarFallback>
    </Avatar>
  )
}

/**
 * Trigger plus panel. The popover portals to <body>, outside `.stats-scope`,
 * so it has to carry the scope class itself — without it every `--st-*`
 * inside resolves to nothing and the panel renders unstyled.
 */
function PickerShell({ label, muted, badge, leading, ariaLabel, children }: {
  label: string
  muted: boolean
  badge?: ReactNode
  leading?: ReactNode
  ariaLabel: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="st-picker" aria-label={ariaLabel}>
          {leading}
          <span className={`st-picker-label ${muted ? 'opacity-60' : ''}`}>{label}</span>
          {badge}
          <CaretDown className="h-3.5 w-3.5 shrink-0 opacity-55" weight="bold" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="stats-scope w-[17rem] rounded-md border-0 bg-transparent p-0 shadow-none"
      >
        <div className="st-tip max-h-[19rem] overflow-y-auto p-1.5">
          {children(() => setOpen(false))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function MultiPicker({ items, selectedIds, onChange, placeholder, emptyLabel, unit, showCrests }: {
  items: PickerItem[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  placeholder: string
  emptyLabel: string
  unit: string
  showCrests?: boolean
}) {
  const toggle = (id: number) =>
    onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id])

  const only = selectedIds.length === 1 ? items.find(i => i.id === selectedIds[0]) : undefined
  const label = selectedIds.length === 0 ? placeholder : only ? only.label : `${selectedIds.length} ${unit}`

  return (
    <PickerShell
      label={label}
      muted={selectedIds.length === 0}
      ariaLabel={placeholder}
      badge={selectedIds.length > 1 ? <span className="st-picker-count">{selectedIds.length}</span> : undefined}
    >
      {() => items.length === 0 ? (
        <p className="st-meta px-2.5 py-3 text-center">{emptyLabel}</p>
      ) : (
        <>
          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-0.5">
            <span className="st-overline">{items.length} {unit}</span>
            <button
              type="button"
              className="st-link"
              onClick={() => onChange(selectedIds.length === items.length ? [] : items.map(i => i.id))}
            >
              {selectedIds.length === items.length ? 'Clear' : 'Select all'}
            </button>
          </div>
          {items.map(item => {
            const checked = selectedIds.includes(item.id)
            return (
              <button
                key={item.id}
                type="button"
                className="st-option"
                data-checked={checked}
                aria-pressed={checked}
                title={item.title}
                onClick={() => toggle(item.id)}
              >
                <span className="st-option-box">
                  <Check className="h-2.5 w-2.5" weight="bold" />
                </span>
                {showCrests && <Crest item={item} />}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && <span className="st-meta shrink-0">{item.hint}</span>}
              </button>
            )
          })}
        </>
      )}
    </PickerShell>
  )
}

/**
 * The same control with one choice. Selection shows as a trailing check
 * rather than as a filled box: a box that can only ever have one thing in it
 * is a radio wearing a checkbox's clothes.
 */
export function SinglePicker({ items, selectedId, onChange, placeholder, emptyLabel, showCrests }: {
  items: PickerItem[]
  selectedId: number | null
  onChange: (id: number) => void
  placeholder: string
  emptyLabel: string
  showCrests?: boolean
}) {
  const selected = items.find(i => i.id === selectedId)
  return (
    <PickerShell
      label={selected?.label ?? placeholder}
      muted={!selected}
      ariaLabel={placeholder}
      leading={showCrests && selected ? <Crest item={selected} /> : undefined}
    >
      {close => items.length === 0 ? (
        <p className="st-meta px-2.5 py-3 text-center">{emptyLabel}</p>
      ) : (
        items.map(item => {
          const checked = item.id === selectedId
          return (
            <button
              key={item.id}
              type="button"
              className="st-option"
              aria-pressed={checked}
              title={item.title}
              onClick={() => { onChange(item.id); close() }}
            >
              {showCrests && <Crest item={item} />}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="st-meta shrink-0">{item.hint}</span>}
              {checked && <Check className="h-3 w-3 shrink-0 text-[hsl(var(--st-accent-ink))]" weight="bold" />}
            </button>
          )
        })
      )}
    </PickerShell>
  )
}
