import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '../../lib/shadcn/button'

// Browser speech-to-text (Web Speech API): fills the text box, nothing is sent.
// Not in lib.dom for every TS version, hence the loose typing.
const Recognition: any =
  typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

type Props = { value: string; onChange: (text: string) => void; disabled?: boolean }

export default function DictateButton({ value, onChange, disabled }: Props) {
  const [listening, setListening] = useState(false)
  const recRef = useRef<any>(null)
  const baseRef = useRef('')
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => () => recRef.current?.abort(), [])

  // Firefox has no SpeechRecognition; a dead button is worse than none.
  if (!Recognition) return null

  const start = () => {
    const rec = new Recognition()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || 'en-US'
    baseRef.current = value && !/\s$/.test(value) ? `${value} ` : value
    rec.onresult = (e: any) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      onChangeRef.current(baseRef.current + text.trim())
    }
    rec.onend = () => {
      recRef.current = null
      setListening(false)
    }
    rec.onerror = () => rec.stop()
    recRef.current = rec
    rec.start()
    setListening(true)
  }

  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      disabled={disabled}
      onClick={() => (listening ? recRef.current?.stop() : start())}
      aria-pressed={listening}
      aria-label={listening ? 'Stop dictation' : 'Dictate a message'}
      title={listening ? 'Stop dictation' : 'Dictate — speak into the message box'}
      className={`shrink-0 ${listening ? 'border-primary/50 text-primary bg-primary/5' : 'text-muted-foreground'}`}
    >
      {listening ? <Square className="w-3.5 h-3.5 fill-current" /> : <Mic className="w-4 h-4" />}
    </Button>
  )
}
