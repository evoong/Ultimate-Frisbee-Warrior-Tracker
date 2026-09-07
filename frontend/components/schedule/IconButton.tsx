import * as React from 'react'
import './schedule-theme.css'

// Every utility control in the schedule header goes through here so the
// cluster stays uniform: one 34px square, one 4px radius, one 16px lucide
// glyph at strokeWidth 1.75. Icons drawn at different weights are the single
// loudest tell that a toolbar was assembled rather than designed.
export const SCHEDULE_ICON_PROPS = {
  className: 'h-4 w-4',
  strokeWidth: 1.75,
} as const

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  /**
   * Toggle state. Leave undefined for a plain action button: passing it turns
   * the control into a toggle button and emits aria-pressed, which is the
   * right pairing for role=button. (role="switch" would want aria-checked
   * instead, so this deliberately does not set one.)
   */
  active?: boolean
  tone?: 'default' | 'accent'
}

const IconButton = React.forwardRef<HTMLButtonElement, Props>(
  ({ label, active, tone = 'default', className = '', children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-active={active ? 'true' : undefined}
      className={`sch-icon-btn ${tone === 'accent' ? 'sch-icon-btn--accent' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  ),
)
IconButton.displayName = 'ScheduleIconButton'

export default IconButton
