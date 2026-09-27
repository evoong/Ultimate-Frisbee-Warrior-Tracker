export function AdBanner({ tier }: { tier: string | null }) {
  if (tier !== 'free') return null

  return (
    <div
      className="w-full border-y border-border bg-muted px-4 py-2 text-center text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      Support Ultimate Frisbee Warrior Tracker with ads. <span className="text-foreground">Upgrade to remove ads.</span>
    </div>
  )
}