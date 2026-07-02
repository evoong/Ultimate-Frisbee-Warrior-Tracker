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
}

/**
 * Wraps content so it fades and slides up gently when it mounts, using the
 * tailwindcss-animate utilities already in the project. Pair with skeletons:
 * show a skeleton while data is undefined, then render the real content inside
 * FadeIn once it arrives so the swap feels smooth instead of a hard pop-in.
 */
export default function FadeIn({ delay = 0, as = 'div', className, style, children, ...props }: FadeInProps) {
  const Tag = as
  return (
    <Tag
      className={cn(
        'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500',
        className,
      )}
      style={delay ? { animationDelay: `${delay}ms`, ...style } : style}
      {...props}
    >
      {children}
    </Tag>
  )
}
