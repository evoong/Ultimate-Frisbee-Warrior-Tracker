type LiveBadgeProps = {
  active?: boolean
}

export default function LiveBadge({ active = true }: LiveBadgeProps) {
  if (!active) return null

  return (
    <span
      role="status"
      aria-label="Score updates live while this game is in progress"
      className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] font-bold tracking-[0.14em] text-primary"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
      LIVE
    </span>
  )
}
