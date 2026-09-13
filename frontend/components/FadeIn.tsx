import * as React from 'react'
import { cn } from '../lib/shadcn/utils'

type FadeInProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Milliseconds to delay the entrance. Use to stagger list items so they
   * ease in one after another instead of all at once (e.g. index * 40).
   */
  delay?: number
  /** Render as a different element while keeping the animation. */
  as?: React.ElementType
  /**
   * Rise slightly while fading in. Off by default and deliberately rare.
   *
   * Content that replaces a skeleton must not move: the skeleton is already
   * laid out where the content goes, so a rise is movement with no cause and
   * reads as the page settling after it has finished. Turn this on only where
   * something genuinely arrives out of nothing and the direction means
   * something -- a chat message rising into a log is the one such case in this
   * app.
   */
  slide?: boolean
}

/**
 * Wraps content so it fades gently when it mounts.
 *
 * Where a skeleton precedes the content, prefer `Resolve`: it cross fades the
 * skeleton into the content in one box, which is a statement this component
 * cannot make on its own.
 *
 * Note the absence of `fill-mode-both`. With it, the animation keeps ownership
 * of `opacity` after it ends and any transition set on the same element never
 * runs -- which is why the Stats dim has to go on a wrapper. Without it this
 * component composes freely.
 */
export default function FadeIn({ delay = 0, as = 'div', slide = false, className, style, children, ...props }: FadeInProps) {
  const Tag = as
  return (
    <Tag
      className={cn(
        'animate-in fade-in duration-200',
        slide && 'slide-in-from-bottom-2',
        className,
      )}
      style={delay ? { animationDelay: `${delay}ms`, ...style } : style}
      {...props}
    >
      {children}
    </Tag>
  )
}
