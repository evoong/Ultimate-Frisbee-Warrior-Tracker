import * as React from 'react'
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../lib/shadcn/popover'
import { cn } from '../lib/shadcn/utils'

// The app's ghost switcher: the control that says *which* thing you are
// looking at (which season's roster, which play), sitting inline with the
// page's <h1> or at the head of its toolbar rather than in a full-width
// bordered box on a row of its own.
//
// A bordered select on its own line reads as a form field waiting to be
// filled in. These are not fields -- nothing is submitted, and the answer is
// already on screen in the list underneath. So there is no surface, no border
// and no radius at rest; chrome appears on hover and while the menu is open.
//
// This is the *global*-scope member of a family of three. Schedule has
// `components/schedule/SeasonPicker.tsx` (`--sch-*`, Phosphor) and Stats has
// `components/stats/Picker.tsx` (`--st-*`, Phosphor, and a permanent hairline
// so it matches the segmented controls beside it). Those pages are scoped
// design systems; Roster and Strategy are still on the global shadcn tokens
// and on lucide, which is a deliberate boundary (see CLAUDE.md) -- porting a
// page means porting all of its icons at once, not smuggling one Phosphor
// glyph in through a shared control. Same anatomy, each scope's own parts.

/**
 * One 34px box, one 5px radius -- the same as the icon buttons these sit
 * beside. The height is fixed rather than derived from the label: a control
 * that grows with a longer season name moves the heading row.
 */
const TRIGGER_CLASS = [
  'group inline-flex h-[2.125rem] min-w-0 items-center gap-1.5 rounded-[5px]',
  'border border-transparent pl-2 pr-[0.4375rem]',
  'text-[0.8125rem] font-medium tracking-[-0.008em] text-muted-foreground',
  'transition-colors hover:border-border hover:bg-accent hover:text-foreground',
  'data-[state=open]:border-border data-[state=open]:bg-accent data-[state=open]:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
].join(' ')

const OPTION_CLASS = [
  'flex w-full items-center gap-2.5 rounded-[5px] px-2.5 py-[0.4375rem]',
  'text-left text-[0.8125rem] text-foreground transition-colors hover:bg-accent',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
].join(' ')

// Radix's asChild forwards data-state, onClick and aria-expanded to its
// single child, so this has to *be* the button -- wrap it in a span and the
// caret never learns it is open and the span swallows the click.
const Trigger = React.forwardRef<
  HTMLButtonElement,
  { label: string; selected: boolean; ariaLabel: string; className?: string }
>(({ label, selected, ariaLabel, className, ...props }, ref) => {
  return (
    <button ref={ref} type="button" className={cn(TRIGGER_CLASS, className)} aria-label={ariaLabel} {...props}>
      {/* The label goes a step up the ramp once something is actually
          chosen, never a step down when it is not: --muted-foreground is
          already the dimmest passing value (5.7:1 light, 7.4:1 dark), and
          fading it to 60% for a placeholder lands at ~2.5:1. Contrast is the
          floor, so the *selected* state is what moves. */}
      <span className={`overflow-hidden text-ellipsis whitespace-nowrap ${selected ? 'text-foreground/80' : ''}`}>
        {label}
      </span>
      <ChevronDown
        className="h-3.5 w-3.5 shrink-0 opacity-55 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
        strokeWidth={2.25}
      />
    </button>
  )
})
Trigger.displayName = 'InlinePickerTrigger'

function Menu({ children }: { children: ReactNode }) {
  return (
    <PopoverContent
      align="start"
      sideOffset={6}
      className="max-h-[19rem] w-[17.5rem] overflow-y-auto p-1.5"
    >
      {children}
    </PopoverContent>
  )
}

function Head({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5 pt-0.5">{children}</div>
}

function Overline({ children }: { children: ReactNode }) {
  // Not `font-mono`: Tailwind's mono maps to the generic system stack here,
  // and Geist Mono is only exposed inside the schedule and stats scopes.
  return (
    <span className="text-[0.625rem] uppercase leading-none tracking-[0.09em] text-muted-foreground">
      {children}
    </span>
  )
}

const LINK_CLASS = [
  '-mx-1 -my-0.5 rounded-[4px] px-1 py-0.5 text-[0.6875rem] leading-tight',
  'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
].join(' ')

export type InlinePickerItem = {
  id: number
  label: string
  /** Right-aligned secondary text on the option row (a date, a count). */
  hint?: string
}

/**
 * Many-of-N. An empty selection is not "nothing chosen" -- every caller reads
 * it as "all of them", which is why the reset in the panel head is worded as
 * the placeholder rather than as "Clear".
 */
export function InlineMultiPicker({
  items,
  selectedIds,
  onChange,
  placeholder,
  unit,
  emptyLabel,
  onCreateNew,
  createLabel,
  className = '',
}: {
  items: InlinePickerItem[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  placeholder: string
  unit: string
  emptyLabel: string
  onCreateNew?: () => void
  createLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)

  const toggle = (id: number) =>
    onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id])

  // One selection names itself; several collapse to a count. No count badge
  // beside that -- "3 seasons 3" is the label saying the same number twice.
  const only = selectedIds.length === 1 ? items.find(i => i.id === selectedIds[0]) : undefined
  const label = selectedIds.length === 0
    ? placeholder
    : only
      ? only.label
      : `${selectedIds.length} ${unit}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Trigger
          label={label}
          selected={selectedIds.length > 0}
          ariaLabel={`${placeholder} — currently ${label}`}
          className={className}
        />
      </PopoverTrigger>
      <Menu>
        {items.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          <>
            <Head>
              <Overline>{items.length} {unit}</Overline>
              <button
                type="button"
                className={`${LINK_CLASS} ${selectedIds.length === 0 ? 'text-foreground' : ''}`}
                onClick={() => onChange([])}
              >
                {placeholder}
              </button>
            </Head>
            {items.map(item => {
              const checked = selectedIds.includes(item.id)
              return (
                <button
                  key={item.id}
                  type="button"
                  className={OPTION_CLASS}
                  aria-pressed={checked}
                  onClick={() => toggle(item.id)}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-transparent'
                    }`}
                  >
                    <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{item.hint}</span>}
                </button>
              )
            })}
          </>
        )}
        {onCreateNew && (
          <button
            type="button"
            className={`${OPTION_CLASS} mt-1.5 border-t border-border pt-2 text-muted-foreground hover:text-foreground`}
            onClick={() => { setOpen(false); onCreateNew() }}
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            {createLabel ?? 'Create new…'}
          </button>
        )}
      </Menu>
    </Popover>
  )
}

/**
 * One-of-N. Selection shows as a trailing check rather than as a filled box:
 * a box that can only ever hold one thing is a radio in a checkbox's clothes.
 */
export function InlineSinglePicker({
  items,
  selectedId,
  onChange,
  placeholder,
  emptyLabel,
  onOpenChange,
  className = '',
}: {
  items: InlinePickerItem[]
  selectedId: number | null
  onChange: (id: number) => void
  placeholder: string
  emptyLabel: string
  /** Fires on open, for callers that refetch their list lazily. */
  onOpenChange?: (open: boolean) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = items.find(i => i.id === selectedId)

  return (
    <Popover
      open={open}
      onOpenChange={next => { setOpen(next); onOpenChange?.(next) }}
    >
      <PopoverTrigger asChild>
        <Trigger
          label={selected?.label ?? placeholder}
          selected={!!selected}
          ariaLabel={`${placeholder} — currently ${selected?.label ?? 'none'}`}
          className={className}
        />
      </PopoverTrigger>
      <Menu>
        {items.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          items.map(item => (
            <button
              key={item.id}
              type="button"
              className={OPTION_CLASS}
              aria-pressed={item.id === selectedId}
              onClick={() => { onChange(item.id); setOpen(false) }}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{item.hint}</span>}
              {item.id === selectedId && <Check className="h-3 w-3 shrink-0 text-foreground" strokeWidth={3} />}
            </button>
          ))
        )}
      </Menu>
    </Popover>
  )
}
