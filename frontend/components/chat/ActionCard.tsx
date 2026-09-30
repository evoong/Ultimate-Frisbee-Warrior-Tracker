import { Button } from '../../lib/shadcn/button'
import { Card, CardContent } from '../../lib/shadcn/card'
import { Check, Loader2, X } from 'lucide-react'

export type ChatProposal = {
  id: string
  tool_name: string
  args: Record<string, unknown>
  summary: string
}

// pending: awaiting the user; confirming: request in flight;
// done: settled (success or terminal 403/404/410); error: transient, retryable.
export type ProposalStatus = 'pending' | 'confirming' | 'done' | 'error'

// The detail block derives from the PROPOSAL ARGS, never from the reply
// text — the summary is server-built, so the card cannot drift from what
// confirm will actually execute.
function renderDetails(proposal: ChatProposal) {
  if (proposal.tool_name === 'create_lineup') {
    const groups = (proposal.args.groups as { name: string; players?: { playerName: string; role?: string }[] }[]) ?? []
    return groups.map((g, i) => (
      <div key={i} className="text-xs">
        <span className="font-medium text-foreground">{g.name}:</span>{' '}
        <span className="text-muted-foreground">
          {(g.players ?? []).map(p => `${p.playerName}${p.role ? ` (${p.role})` : ''}`).join(', ') || '(empty)'}
        </span>
      </div>
    ))
  }
  const SKIP = new Set(['gameDate', 'opponent'])
  return Object.entries(proposal.args)
    .filter(([k]) => !SKIP.has(k))
    .map(([k, v]) => (
      <div key={k} className="text-xs">
        <span className="font-medium text-foreground">{k}:</span>{' '}
        <span className="text-muted-foreground">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
      </div>
    ))
}

export function ActionCard({ proposal, status, outcome, onConfirm, onCancel, onDismiss }: {
  proposal: ChatProposal
  status: ProposalStatus
  outcome?: string | null
  onConfirm: () => void
  onCancel: () => void
  onDismiss: () => void
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-3 space-y-2">
        <p className="text-sm font-medium text-foreground leading-snug">{proposal.summary}</p>
        <div className="space-y-1">{renderDetails(proposal)}</div>
        {outcome && (
          <p className={`text-xs ${status === 'done' ? 'text-muted-foreground' : 'text-destructive'}`}>{outcome}</p>
        )}
        {status === 'done' ? (
          <Button size="sm" variant="outline" onClick={onDismiss} className="text-foreground">
            Dismiss
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={onConfirm}
              disabled={status === 'confirming'}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {status === 'confirming' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel} disabled={status === 'confirming'} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4 mr-1.5" />
              Decline
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
