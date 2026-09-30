import { useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../lib/shadcn/dialog'
import { Send, Bot, User, Loader2, Trash2 } from 'lucide-react'
import FadeIn from '../components/FadeIn'
import ActionReceiptCard, { type ActionReceipt } from '../components/chat/ActionReceiptCard'
import { useAuth } from '../contexts/AuthContext'

type Message = { role: 'user' | 'assistant'; content: string; actions?: ActionReceipt[] }

function parseInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, j) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={j}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*'))
      return <em key={j}>{part.slice(1, -1)}</em>
    return part
  })
}

function renderMarkdown(text: string) {
  return text.split('\n').map((line, i) => {
    if (line.trim() === '') return <div key={i} className="h-1" />
    // Bullet: lines starting with "* " or "- " (but not "**")
    if (/^(\* (?!\*)|- )/.test(line)) {
      const content = line.replace(/^(\* |- )/, '')
      return (
        <div key={i} className="flex gap-1.5">
          <span className="mt-0.5 shrink-0 text-xs">•</span>
          <span>{parseInline(content)}</span>
        </div>
      )
    }
    return <div key={i}>{parseInline(line)}</div>
  })
}

// Same shape as gateway/sessionId.ts, duplicated on purpose: the frontend
// bundle never imports gateway code. Old `s_<ts>_<rand>` values fail the
// regex and are silently re-minted; their rows are unreachable under the
// new owner-scoped RLS anyway (user_id was never written for them).
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getSessionId() {
  let id = localStorage.getItem('ufwt_chat_session')
  if (!id || !SESSION_ID_RE.test(id)) {
    id = crypto.randomUUID()
    localStorage.setItem('ufwt_chat_session', id)
  }
  return id
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [standaloneActions, setStandaloneActions] = useState<ActionReceipt[]>([])
  const [undoPendingIds, setUndoPendingIds] = useState<Set<string>>(new Set())
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const sessionId = useRef(getSessionId())
  const { can, currentTeamId } = useAuth()

  useEffect(() => {
    if (currentTeamId == null) return
    fetch(`/api/chat/history?session_id=${sessionId.current}&organization_id=${currentTeamId}`)
      .then(r => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) {
          const legacy = data as { role: string; content: string }[]
          setMessages(legacy.map(d => ({ role: d.role as 'user' | 'assistant', content: d.content })))
          setStandaloneActions([])
        } else {
          const shaped = data as { messages?: { role: string; content: string }[]; actions?: ActionReceipt[] }
          setMessages((shaped.messages ?? []).map(d => ({ role: d.role as 'user' | 'assistant', content: d.content })))
          setStandaloneActions(shaped.actions ?? [])
        }
        setHistoryLoaded(true)
      })
      .catch(() => setHistoryLoaded(true))
  }, [currentTeamId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading || currentTeamId == null) return
    setInput('')
    const newMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          session_id: sessionId.current,
          history: newMessages.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
          organization_id: currentTeamId,
        }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply ?? data.error ?? 'No response',
        actions: Array.isArray(data.actions) ? data.actions : [],
      }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Failed to reach the server. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  const handleUndo = async (actionId: string) => {
    if (currentTeamId == null || undoPendingIds.has(actionId)) return
    setUndoPendingIds(prev => new Set(prev).add(actionId))
    setUndoErrors(prev => {
      const next = { ...prev }
      delete next[actionId]
      return next
    })
    try {
      const res = await fetch('/api/chat/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action_id: actionId, organization_id: currentTeamId }),
      })
      if (res.ok) {
        const settle = (a: ActionReceipt) => (a.id === actionId ? { ...a, status: 'undone' } : a)
        setMessages(prev => prev.map(m => (m.actions ? { ...m, actions: m.actions.map(settle) } : m)))
        setStandaloneActions(prev => prev.map(settle))
      } else if (res.status === 409) {
        const body = await res.json().catch(() => null)
        setUndoErrors(prev => ({
          ...prev,
          [actionId]: body?.error || "This change can't be undone automatically — the data has changed since.",
        }))
      } else {
        setUndoErrors(prev => ({ ...prev, [actionId]: 'Undo failed — try again.' }))
      }
    } catch {
      setUndoErrors(prev => ({ ...prev, [actionId]: 'Undo failed — try again.' }))
    } finally {
      setUndoPendingIds(prev => {
        const next = new Set(prev)
        next.delete(actionId)
        return next
      })
    }
  }

  const clearHistory = async () => {
    if (currentTeamId == null) return
    setClearing(true)
    try {
      await fetch(`/api/chat/history?session_id=${sessionId.current}&organization_id=${currentTeamId}`, { method: 'DELETE' })
      const attached = messages.flatMap(m => m.actions ?? [])
      if (attached.length > 0) setStandaloneActions(prev => [...attached, ...prev])
      setMessages([])
    } finally {
      setClearing(false)
      setConfirmClear(false)
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-2xl font-bold text-foreground">Team Assistant</h1>
        {can.record && messages.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmClear(true)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="w-4 h-4 mr-1.5" />
            Clear chat
          </Button>
        )}
      </div>

      <Dialog open={confirmClear} onOpenChange={open => !open && setConfirmClear(false)}>
        <DialogContent className="bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>Clear chat history</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently delete this chat's message history. This cannot be undone.
          </p>
          <div className="flex gap-3 mt-2">
            <Button variant="outline" onClick={() => setConfirmClear(false)} className="flex-1" disabled={clearing}>
              Cancel
            </Button>
            <Button
              onClick={clearHistory}
              disabled={clearing}
              className="flex-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {clearing ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Clear chat'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Message list */}
      <Card className="flex-1 overflow-hidden bg-card border-border flex flex-col">
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
          {historyLoaded && standaloneActions.length > 0 && (
            <FadeIn className="rounded-md border border-border bg-card p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Recent actions</p>
              <div className="flex flex-col gap-2">
                {standaloneActions.map(a => (
                  <ActionReceiptCard
                    key={a.id}
                    action={a}
                    canUndo={can.manageTeam}
                    pending={undoPendingIds.has(a.id)}
                    error={undoErrors[a.id] ?? null}
                    onUndo={handleUndo}
                  />
                ))}
              </div>
            </FadeIn>
          )}
          {!historyLoaded ? (
            <div className="flex justify-center items-center h-full text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />Loading history…
            </div>
          ) : messages.length === 0 ? (
            <FadeIn className="flex flex-col items-center justify-center h-full text-center gap-3">
              <Bot className="w-12 h-12 text-primary opacity-60" />
              <p className="text-muted-foreground text-sm">Ask me anything about the team: stats, scores, players, or upcoming games.</p>
            </FadeIn>
          ) : (
            messages.map((msg, i) => (
              // Per-message key so each new message eases in as it is appended.
              <FadeIn slide key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                  {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4 text-primary" />}
                </div>
                <div className={`flex flex-col gap-2 min-w-0 flex-1 ${msg.role === 'user' ? 'items-end' : ''}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-tr-sm'
                      : 'bg-muted text-foreground rounded-tl-sm'
                  }`}>
                    {msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
                  </div>
                  {msg.actions && msg.actions.length > 0 && (
                    <div className="flex flex-col gap-2 w-full max-w-[80%]">
                      {msg.actions.map(a => (
                        <ActionReceiptCard
                          key={a.id}
                          action={a}
                          canUndo={can.manageTeam}
                          pending={undoPendingIds.has(a.id)}
                          error={undoErrors[a.id] ?? null}
                          onUndo={handleUndo}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </FadeIn>
            ))
          )}
          {loading && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
                <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-muted-foreground/60 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </CardContent>
      </Card>

      {/* Input — the assistant is a team-only feature (writes chat history via
          the service-role endpoint), so read-only users get a notice instead. */}
      {can.record ? (
        <div className="flex gap-2 mt-3">
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
            placeholder="Ask about stats, players, games…"
            disabled={loading}
            className="bg-card border-border text-foreground"
          />
          <Button
            onClick={sendMessage}
            disabled={!input.trim() || loading}
            className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          The team assistant is available to team members only.
        </p>
      )}
    </div>
  )
}
