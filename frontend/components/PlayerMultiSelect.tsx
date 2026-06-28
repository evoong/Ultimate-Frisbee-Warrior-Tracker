import { useRef, useState, useEffect } from 'react'
import { ChevronDown, Check, X } from 'lucide-react'

type Player = { id: number; name: string; total: number }

interface Props {
  players: Player[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  placeholder?: string
  className?: string
}

export default function PlayerMultiSelect({ players, selectedIds, onChange, placeholder = 'Top 8 players', className = '' }: Props) {
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

  const clearAll = () => onChange([])

  const singleMatch = selectedIds.length === 1 ? players.find(p => p.id === selectedIds[0]!) : undefined
  const label = selectedIds.length === 0
    ? placeholder
    : singleMatch
      ? singleMatch.name
      : `${selectedIds.length} players`

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 h-9 px-3 rounded-md border border-border bg-background text-foreground text-sm transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <span className={selectedIds.length === 0 ? 'text-muted-foreground' : 'text-foreground font-medium truncate'}>
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
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
            <span className="text-xs text-muted-foreground">{selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Select players'}</span>
            {selectedIds.length > 0 && (
              <button onClick={clearAll} className="text-xs text-muted-foreground hover:text-foreground">Clear all</button>
            )}
          </div>
          <div className="max-h-52 overflow-y-auto">
            {players.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">No players</div>
            ) : (
              players.map(p => {
                const checked = selectedIds.includes(p.id)
                return (
                  <button
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-colors hover:bg-accent ${checked ? 'bg-primary/5' : ''}`}
                  >
                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${checked ? 'bg-primary border-primary' : 'border-border'}`}>
                      {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                    </div>
                    <span className={`flex-1 truncate ${checked ? 'font-medium text-foreground' : 'text-foreground'}`}>
                      {p.name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{p.total}</span>
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
