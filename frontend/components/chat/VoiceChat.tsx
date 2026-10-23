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
    <div className="relative flex gap-2 shrink-0">
      {/* Status floats above the row so it never shifts the input. */}
      {(heard || error) && (
        <span
          className={`absolute bottom-full right-0 mb-1 text-xs max-w-[240px] truncate ${error ? 'text-destructive' : 'text-muted-foreground italic'}`}
          title={error ?? heard}
          role={error ? 'alert' : undefined}
        >
          {error ?? `"${heard}"`}
        </span>
      )}
      <Select value={voiceName} onValueChange={setVoiceName} disabled={active}>
        <SelectTrigger
          className="h-9 w-9 justify-center px-0 bg-card border-border text-muted-foreground [&>svg:last-child]:hidden"
          aria-label="Assistant voice"
          title={`Voice: ${voiceName}`}
        >
          <Volume2 className="w-4 h-4" />
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
        size="icon"
        variant="outline"
        className={`shrink-0 ${active ? 'border-primary/50 text-primary bg-primary/5' : 'text-muted-foreground'}`}
        aria-pressed={active}
        aria-label={active ? 'Stop voice mode' : 'Talk to the assistant'}
        title={active ? 'Stop voice mode' : 'Talk to the assistant'}
      >
        {connecting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : active ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
          </span>
        ) : (
          <Mic className="w-4 h-4" />
        )}
      </Button>
    </div>
  )
}
