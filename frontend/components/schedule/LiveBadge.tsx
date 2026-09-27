type LiveBadgeProps = {
  active?: boolean
}

export default function LiveBadge({ active = true }: LiveBadgeProps) {
  if (!active) return null

  return (
    <span
      role="status"
      aria-label="Score updates live while this game is in progress"
      className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-bold tracking-[0.14em] text-red-600 dark:text-red-400"
    >
      <span aria-hidden="true" className="relative flex size-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping motion-reduce:animate-none" />
        <span className="relative inline-flex size-1.5 rounded-full bg-red-500" />
      </span>
      LIVE
    </span>
  )
}
