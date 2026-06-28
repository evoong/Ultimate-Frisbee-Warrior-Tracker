import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '../lib/shadcn/card'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Bot, Send, Trash2, User, Loader2, Zap } from 'lucide-react'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  actionResults?: string[]
}

const SESSION_KEY = 'ufwt_chat_session'

function getOrCreateSession(): string {
  let sid = localStorage.getItem(SESSION_KEY)
  if (!sid) {
    sid = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`
    localStorage.setItem(SESSION_KEY, sid)
  }
  return sid
}

function formatMessage(content: string) {
  // Remove ACTION tags from display
  return content.replace(/ACTION:\s+\w+\s+\{[^}]+\}/g, '').trim()
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionId] = useState(() => getOrCreateSession())
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadHistory()
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const loadHistory = async () => {
    try {
      const res = await fetch(`/api/chat/history?session_id=${sessionId}`)
      if (res.ok) {
        const rows = await res.json() as { id: number; role: string; content: string }[]
        setMessages(rows.map(r => ({
          id: String(r.id),
          role: r.role as 'user' | 'assistant',
          content: r.content,
        })))
      }
    } catch { /* ignore */ }
  }

  const handleClear = async () => {
    setMessages([])
    await fetch(`/api/chat/history?session_id=${sessionId}`, { method: 'DELETE' })
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: Message = { id: `u_${Date.now()}`, role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      // Build history (last 20 messages)
      const history = messages.slice(-20).map(m => ({ role: m.role, content: m.content }))

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, session_id: sessionId, history }),
      })

      if (!res.ok) {
        const err = await res.json()
        const errMsg: Message = {
          id: `e_${Date.now()}`,
          role: 'assistant',
          content: `Sorry, something went wrong: ${err.error ?? 'Unknown error'}`,
        }
        setMessages(prev => [...prev, errMsg])
        return
      }

      const data = await res.json() as { reply: string; actionResults?: string[] }
      const assistantMsg: Message = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: data.reply,
        actionResults: data.actionResults,
      }
      setMessages(prev => [...prev, assistantMsg])
    } catch (err) {
      const errMsg: Message = {
        id: `e_${Date.now()}`,
        role: 'assistant',
        content: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
      }
      setMessages(prev => [...prev, errMsg])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const suggestedPrompts = [
    'Who are the top scorers this season?',
    'What are our recent game results?',
    'How many goals does [player] have?',
    'Show me the current standings',
  ]

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Bot className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">AI Assistant</h1>
            <p className="text-xs text-muted-foreground">Ask about stats, results, or manage your team</p>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 pb-2">
        {messages.length === 0 ? (
          <div className="space-y-4 pt-4">
            <Card className="bg-card border-border">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-primary" />
                  </div>
                  <div className="text-sm text-foreground">
                    Hey! I'm your Ultimate Frisbee team assistant. I have access to your real-time game data, player stats, and season info. I can also add goals to games and create new games for you. What would you like to know?
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium px-1">Try asking:</p>
              {suggestedPrompts.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => { setInput(prompt); inputRef.current?.focus() }}
                  className="w-full text-left px-3 py-2.5 rounded-lg bg-card border border-border text-sm text-foreground hover:bg-accent transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className={`flex items-start gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-primary/10'
              }`}>
                {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4 text-primary" />}
              </div>
              <div className={`max-w-[80%] space-y-1.5 ${msg.role === 'user' ? 'items-end' : 'items-start'} flex flex-col`}>
                <div className={`px-3 py-2.5 rounded-2xl text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-tr-sm'
                    : 'bg-card border border-border text-foreground rounded-tl-sm'
                }`}>
                  {formatMessage(msg.content)}
                </div>
                {msg.actionResults && msg.actionResults.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {msg.actionResults.map((r, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 font-medium">
                        <Zap className="w-3 h-3" />
                        {r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {loading && (
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="px-3 py-2.5 rounded-2xl rounded-tl-sm bg-card border border-border">
              <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="pt-3 border-t border-border">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about stats, scores, or manage games..."
            disabled={loading}
            className="flex-1 bg-card border-border text-foreground"
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2 text-center">Powered by Gemini AI · Data updates in real-time</p>
      </div>
    </div>
  )
}
