import { useState } from 'react'
import { Check, ChevronsUpDown, UserPlus, X } from 'lucide-react'
import { Button } from '../lib/shadcn/button'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '../lib/shadcn/command'
import { Popover, PopoverContent, PopoverTrigger } from '../lib/shadcn/popover'
import { cn } from '../lib/shadcn/utils'

type Player = { id: string; label: string; isSub?: boolean }

type Props = {
  players: Player[]
  value: string
  onValueChange: (value: string) => void
  onAddPlayer?: (name: string) => Promise<void>
  onDeletePlayer?: (id: string) => Promise<void>
  placeholder?: string
  className?: string
}

export default function PlayerCombobox({
  players,
  value,
  onValueChange,
  onAddPlayer,
  onDeletePlayer,
  placeholder = 'None',
  className,
}: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const selected = players.find(p => p.id === value)

  const hasExactMatch = players.some(
    p => p.label.toLowerCase() === search.toLowerCase()
  )
  const showAdd = onAddPlayer && search.trim().length > 1 && !hasExactMatch

  const handleAdd = async () => {
    if (!onAddPlayer || !search.trim()) return
    setAdding(true)
    await onAddPlayer(search.trim())
    setSearch('')
    setAdding(false)
    setOpen(false)
  }

  const handleDelete = async (e: React.MouseEvent, playerId: string) => {
    e.stopPropagation()
    if (!onDeletePlayer) return
    setDeletingId(playerId)
    await onDeletePlayer(playerId)
    // If the deleted player was selected, clear selection
    if (value === playerId) onValueChange('__none__')
    setDeletingId(null)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('justify-between font-normal', className)}
        >
          <span className="truncate">
            {selected ? selected.label : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0">
        <Command>
          <CommandInput
            placeholder="Search or add player..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>
              {showAdd ? (
                <button
                  onClick={handleAdd}
                  disabled={adding}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-primary hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <UserPlus className="w-4 h-4 flex-shrink-0" />
                  <span>{adding ? 'Adding...' : `Add "${search}" to game`}</span>
                </button>
              ) : (
                <p className="py-2 px-3 text-sm text-muted-foreground">No player found.</p>
              )}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__none__"
                onSelect={() => { onValueChange('__none__'); setOpen(false); setSearch('') }}
              >
                <Check className={cn('mr-2 h-4 w-4', value === '__none__' ? 'opacity-100' : 'opacity-0')} />
                None
              </CommandItem>
              {players.map(p => (
                <CommandItem
                  key={p.id}
                  value={p.label}
                  onSelect={() => { onValueChange(p.id); setOpen(false); setSearch('') }}
                  className="flex items-center justify-between pr-1"
                >
                  <div className="flex items-center min-w-0">
                    <Check className={cn('mr-2 h-4 w-4 shrink-0', value === p.id ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">{p.label}</span>
                  </div>
                  {p.isSub && onDeletePlayer && (
                    <button
                      onClick={(e) => handleDelete(e, p.id)}
                      disabled={deletingId === p.id}
                      className="ml-2 shrink-0 p-0.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
                      aria-label={`Remove ${p.label}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </CommandItem>
              ))}
              {showAdd && (
                <CommandItem
                  value={`__add__${search}`}
                  onSelect={handleAdd}
                  disabled={adding}
                  className="text-primary"
                >
                  <UserPlus className="mr-2 h-4 w-4" />
                  {adding ? 'Adding...' : `Add "${search}" to game`}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
