import * as React from 'react'
import type { IconWeight } from '@phosphor-icons/react'
import './schedule-theme.css'

// Every utility control in the schedule header goes through here so the
// cluster stays uniform: one 34px square, one 5px radius, one 16px Phosphor
// glyph at "regular" weight. Icons drawn at different weights are the single
// loudest tell that a toolbar was assembled rather than designed, which is
// why this is a shared object and not four hand-written className strings.
export const SCHEDULE_ICON_PROPS = {
  className: 'h-4 w-4',
  weight: 'regular',
} as const satisfies { className: string; weight: IconWeight }

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  /**
   * Toggle state. Leave undefined for a plain action button: passing it turns
   * the control into a toggle button and emits aria-pressed, which is the
   * right pairing for role=button. (role="switch" would want aria-checked
   * instead, so this deliberately does not set one.)
   */
  active?: boolean
  /**
   * "accent" is the cluster's one primary action. It is the same square
   * inverted, not a coloured button — see .sch-icon-btn--accent.
   */
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
