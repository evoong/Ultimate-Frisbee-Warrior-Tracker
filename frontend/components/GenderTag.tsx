// Compact M/W chip for gender_match. Letter + color (not color alone) so it
// still reads for colorblind users; sits beside a name instead of recoloring
// it, since a tinted name reads like a link/error state at a glance.
export default function GenderTag({ value, className = '' }: { value: string | null; className?: string }) {
  if (value !== 'Man' && value !== 'Woman') return null
  const isMan = value === 'Man'
  return (
    <span
      title={value}
      aria-label={value}
      className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[9px] font-mono font-bold leading-none shrink-0 ${
        isMan ? 'bg-gender-man/15 text-gender-man' : 'bg-gender-woman/15 text-gender-woman'
      } ${className}`}
    >
      {isMan ? 'M' : 'W'}
    </span>
  )
}

export function GenderRatio({ entries, className = '' }: { entries: { gender_match: string | null }[]; className?: string }) {
  const men = entries.filter(e => e.gender_match === 'Man').length
  const women = entries.filter(e => e.gender_match === 'Woman').length
  if (men === 0 && women === 0) return null
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-mono ${className}`}>
      <span className="text-gender-man">{men}M</span>
      <span className="text-muted-foreground">·</span>
      <span className="text-gender-woman">{women}W</span>
    </span>
  )
}
