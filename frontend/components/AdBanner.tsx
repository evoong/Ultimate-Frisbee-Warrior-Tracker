import { cn } from '../lib/shadcn/utils'

export function AdBanner({ tier }: { tier: string | null }) {
  if (tier !== 'free') return null

  return (
    <div
      className={cn(
        'w-full text-center px-4 py-2 text-xs',
        'bg-amber-500/10 border-y border-amber-500/20 text-amber-700 dark:text-amber-300',
      )}
      role="status"
      aria-live="polite"
    >
      Support Ultimate Frisbee Warrior Tracker with ads.
    </div>
  )
}