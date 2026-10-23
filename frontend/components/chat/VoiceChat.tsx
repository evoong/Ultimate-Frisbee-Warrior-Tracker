import { useEffect, useRef, useState } from 'react'
import { Mic, Loader2, Volume2 } from 'lucide-react'
import { Button } from '../../lib/shadcn/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../lib/shadcn/select'
import { startVoiceSession, type VoiceSession, type VoiceTurn } from '../../lib/geminiLive'
import type { ChatProposal } from './ActionCard'

// Hardcoded list — Gemini Live has no list-voices endpoint; these are the
// documented prebuilt voices for gemini-3.8-live (see Live API speech config).
export const VOICES = [
  { name: 'Charon', label: 'Charon — informative' },
  { name: 'Puck', label: 'Puck — upbeat' },
  { name: 'Kore', label: 'Kore — firm' },
  { name: 'Fenrir', label: 'Fenrir — excitable' },
  { name: 'Aoede', label: 'Aoede — breezy' },
] as const

const VOICE_STORAGE_KEY = 'ufwt_voice_name'

type Props = {
  organizationId: number
  sessionId: string
  onProposal: (proposal: ChatProposal) => void
  onTurnComplete: (turns: VoiceTurn[]) => void
}

export default function VoiceChat({ organizationId, sessionId, onProposal, onTurnComplete }: Props) {
  const [voiceName, setVoiceName] = useState<string>(() => localStorage.getItem(VOICE_STORAGE_KEY) ?? 'Charon')
  const [active, setActive] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [heard, setHeard] = useState('')
  const sessionRef = useRef<VoiceSession | null>(null)

  useEffect(() => {
    localStorage.setItem(VOICE_STORAGE_KEY, voiceName)
  }, [voiceName])

  // Close the live session on unmount so the mic and socket never outlive the page.
  useEffect(() => () => sessionRef.current?.close(), [])

  const start = async () => {
    setError(null)
    setConnecting(true)
    try {
      const session = await startVoiceSession({
        organization_id: organizationId,
        session_id: sessionId,
        voiceName,
        events: {
          onProposal,
          onUserTranscript: text => setHeard(text),
          onTurnComplete: turns => {
            setHeard('')
            if (turns.length > 0) onTurnComplete(turns)
          },
          onError: msg => setError(msg),
          onClose: () => {
            sessionRef.current = null
            setActive(false)
            setHeard('')
          },
        },
      })
      sessionRef.current = session
      setActive(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start voice mode.')
    } finally {
      setConnecting(false)
    }
  }

  const stop = () => {
    sessionRef.current?.close()
    sessionRef.current = null
    setActive(false)
  }

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      {heard && (
        <span className="text-xs text-muted-foreground italic max-w-[180px] truncate" title={heard}>
          "{heard}"
        </span>
      )}
      <Select value={voiceName} onValueChange={setVoiceName} disabled={active}>
        <SelectTrigger
          className="w-[130px] h-8 bg-card border-border text-foreground text-xs"
          aria-label="Assistant voice"
        >
          <div className="flex items-center gap-1.5 truncate">
            <Volume2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <SelectValue />
          </div>
        </SelectTrigger>
        <SelectContent className="bg-popover text-popover-foreground">
          {VOICES.map(v => (
            <SelectItem key={v.name} value={v.name} className="text-xs">{v.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        onClick={active ? stop : start}
        disabled={connecting}
        size="sm"
        variant="outline"
        className={`h-8 shrink-0 text-xs ${active ? 'border-primary/50 text-primary bg-primary/5' : 'text-muted-foreground'}`}
        aria-pressed={active}
        title={active ? 'Stop voice mode' : 'Talk to the assistant'}
      >
        {connecting ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : active ? (
          <span className="relative flex h-2 w-2 mr-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
        ) : (
          <Mic className="w-3.5 h-3.5 mr-1.5" />
        )}
        <span>{active ? 'Listening…' : 'Talk'}</span>
      </Button>
      {error && <span className="text-xs text-destructive max-w-[200px] truncate" role="alert">{error}</span>}
    </div>
  )
}
