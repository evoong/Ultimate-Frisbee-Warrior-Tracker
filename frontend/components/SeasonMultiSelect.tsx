import { useRef, useState, useEffect } from 'react'
import { ChevronDown, Check, X } from 'lucide-react'

type Season = { id: number; name: string; year: number; organizer: string | null }

function seasonLabel(s: Season) {
  return [s.organizer, s.name, s.year].filter(Boolean).join(' ')
}

interface Props {
  seasons: Season[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  placeholder?: string
  className?: string
}

export default function SeasonMultiSelect({ seasons, selectedIds, onChange, placeholder = 'All Seasons', className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggle = (id: number) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter(s => s !== id) : [...selectedIds, id])
  }

  const selectAll = () => onChange(seasons.map(s => s.id))
  const clearAll = () => onChange([])

  const singleMatch = selectedIds.length === 1 ? seasons.find(s => s.id === selectedIds[0]!) : undefined
  const label = selectedIds.length === 0
    ? placeholder
    : singleMatch
      ? seasonLabel(singleMatch)
      : selectedIds.length === 1
        ? placeholder
        : `${selectedIds.length} seasons`

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 h-10 px-3 rounded-md border border-border bg-card text-foreground text-sm transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <span className={selectedIds.length === 0 ? 'text-muted-foreground' : 'text-foreground font-medium'}>
          {label}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {selectedIds.length > 0 && (
            <span
              role="button"
              onClick={e => { e.stopPropagation(); clearAll() }}
              className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Clear selection"
            >
              <X className="w-3 h-3" />
            </span>
          )}
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-md shadow-lg overflow-hidden">
          {/* Actions */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
            <button onClick={selectAll} className="text-xs text-primary hover:underline font-medium">Select all</button>
            <button onClick={clearAll} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
          </div>

          {/* Season list */}
          <div className="max-h-52 overflow-y-auto">
            {seasons.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">No seasons yet</div>
            ) : (
              seasons.map(s => {
                const checked = selectedIds.includes(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() => toggle(s.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-colors hover:bg-accent ${checked ? 'bg-primary/5' : ''}`}
                  >
                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${checked ? 'bg-primary border-primary' : 'border-border'}`}>
                      {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                    </div>
                    <span className={`flex-1 ${checked ? 'font-medium text-foreground' : 'text-foreground'}`}>
                      {seasonLabel(s)}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
