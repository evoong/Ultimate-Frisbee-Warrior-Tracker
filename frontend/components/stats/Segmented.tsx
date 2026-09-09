import type { CSSProperties } from 'react'
import './stats-theme.css'

// One segmented-control idiom for the whole Stats page — the scope filter's
// three ranges, the assist matrix's web/table, the progression chart's stat,
// and the rankings table's formula builder. They were five hand-rolled copies
// of the same markup, each re-deciding what "active" looks like.
//
// The active segment is a single travelling thumb rather than a background
// that appears on whichever button was clicked. Two reasons, and the second
// one is the whole point of this file:
//
//  - A fill that blinks from one segment to another says "something changed"
//    without saying what moved where; a thumb that slides says which way you
//    went, in the same way the schedule ledger's one rail travels between
//    rows rather than each row lighting its own.
//  - Equal-width columns plus a hidden bold copy of every label (::after)
//    mean the control is exactly as wide at rest as it is in every other
//    state. Content-width segments whose active one bolts to 600 weight
//    change the group's total width by a pixel or two on every click, and
//    this control sits at the right-hand end of a `justify-between` header —
//    so those pixels push the whole header around.

export type SegmentOption<T extends string> = {
  key: T
  label: string
  /** Tooltip for a label short enough to need one. */
  title?: string
}

export default function Segmented<T extends string>({
  options, value, onChange, ariaLabel, className,
}: {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (key: T) => void
  ariaLabel?: string
  className?: string
}) {
  // -1 when the value matches nothing: the thumb hides rather than parking on
  // segment 0 and claiming a selection that is not there.
  const index = options.findIndex(o => o.key === value)

  return (
    <div
      className={`st-seg ${className ?? ''}`}
      role="group"
      aria-label={ariaLabel}
      style={{ '--st-seg-n': options.length, '--st-seg-i': Math.max(index, 0) } as CSSProperties}
    >
      <span className="st-seg-thumb" data-off={index < 0} aria-hidden="true" />
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          className="st-seg-btn"
          data-label={o.label}
          data-active={o.key === value}
          aria-pressed={o.key === value}
          title={o.title}
          onClick={() => onChange(o.key)}
        >
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}
