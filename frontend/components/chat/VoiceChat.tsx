import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Loader2, Volume2 } from 'lucide-react'
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
          onTurnComplete: turns => {
            if (turns.length > 0) onTurnComplete(turns)
          },
          onError: msg => setError(msg),
          onClose: () => {
            sessionRef.current = null
            setActive(false)
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
    <div className="flex items-center gap-2">
      <Select value={voiceName} onValueChange={setVoiceName} disabled={active}>
        <SelectTrigger
          size="sm"
          className="w-[140px] h-8 bg-card border-border text-foreground"
          aria-label="Assistant voice"
        >
          <div className="flex items-center gap-1.5">
            <Volume2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <SelectValue />
          </div>
        </SelectTrigger>
        <SelectContent className="bg-popover text-popover-foreground">
          {VOICES.map(v => (
            <SelectItem key={v.name} value={v.name}>{v.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        onClick={active ? stop : start}
        disabled={connecting}
        size="sm"
        variant="outline"
        className={`h-8 shrink-0 ${active ? 'border-primary/50 text-primary' : 'text-muted-foreground'}`}
        aria-pressed={active}
        title={active ? 'Stop voice mode' : 'Talk to the assistant'}
      >
        {connecting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : active ? (
          <MicOff className="w-4 h-4" />
        ) : (
          <Mic className="w-4 h-4" />
        )}
        <span className="ml-1.5 hidden sm:inline">{active ? 'Stop' : 'Talk'}</span>
      </Button>
      {error && <span className="text-xs text-destructive max-w-[220px] truncate" role="alert">{error}</span>}
    </div>
  )
}
