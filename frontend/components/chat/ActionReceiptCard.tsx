import { Undo2, Check, Loader2 } from 'lucide-react'
import { Button } from '../../lib/shadcn/button'

export type ActionReceipt = {
  id: string
  request_id?: string
  description: string
  status: string
}

interface ActionReceiptCardProps {
  action: ActionReceipt
  canUndo: boolean
  pending?: boolean
  error?: string | null
  onUndo: (id: string) => void
}

export default function ActionReceiptCard({ action, canUndo, pending = false, error = null, onUndo }: ActionReceiptCardProps) {
  const undone = action.status === 'undone'
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground">
      {undone ? (
        <Check className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
      ) : (
        <Undo2 className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="leading-relaxed">{action.description}</p>
        <span aria-live="polite" className={undone ? 'block text-xs text-muted-foreground' : 'sr-only'}>
          {undone ? 'Undone' : 'Applied'}
        </span>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      {action.status === 'applied' && canUndo && (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onUndo(action.id)}
          className="h-7 shrink-0 shadow-none text-muted-foreground hover:text-foreground"
        >
          {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
          {pending ? <span className="sr-only">Undo</span> : 'Undo'}
        </Button>
      )}
    </div>
  )
}
