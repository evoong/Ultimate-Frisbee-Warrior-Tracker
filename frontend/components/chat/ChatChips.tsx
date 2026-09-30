import { Button } from '../../lib/shadcn/button'
import type { TeamRole } from '../../lib/authClient'

// Quick-action chips: preset PROMPTS, never writes — they go through the
// normal sendMessage path, so the assistant proposes and the card confirms.
type Chip = { label: string; message: string; write?: boolean }

const CHIPS: Chip[] = [
  { label: 'View lineup', message: 'Show me the current lineup' },
  { label: 'Build lineup', message: 'Help me build a lineup for the next game', write: true },
  { label: 'Log event', message: 'Log a goal', write: true },
  { label: 'Undo event', message: 'Undo the last event', write: true },
  { label: 'Saved lineups', message: 'What lineup templates do we have?' },
]

// Chips key off the team ROLE, not can.record: members have can.record
// (roster/schedule entry) but the chat write tools are editor-tier.
export function ChatChips({ role, onSend, hidden }: {
  role: TeamRole | null
  onSend: (message: string) => void
  hidden?: boolean
}) {
  if (hidden || role == null) return null
  const visible = CHIPS.filter(c => !c.write || role === 'editor' || role === 'captain')
  return (
    <div className="flex gap-2 flex-wrap">
      {visible.map(c => (
        <Button
          key={c.label}
          type="button"
          variant="outline"
          size="sm"
          className="bg-card border-border text-muted-foreground hover:text-foreground"
          onClick={() => onSend(c.message)}
        >
          {c.label}
        </Button>
      ))}
    </div>
  )
}
