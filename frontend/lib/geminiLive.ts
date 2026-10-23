// Gemini Live (full-duplex voice) client wrapper for the team assistant.
// The server mints a locked ephemeral token (/api/chat/voice/session); this
// module connects the browser directly to Gemini Live with it, streams mic
// audio in (16 kHz PCM16 base64) and plays model audio out (24 kHz PCM16).
// Tool calls other than confirm/cancel_pending_action round-trip through
// /api/chat/voice/tool server-side, which enforces the same role gates and
// propose -> confirm flow as text chat.
import { GoogleGenAI } from '@google/genai'
import type { ChatProposal } from '../components/chat/ActionCard'

export const INPUT_SAMPLE_RATE = 16000
export const OUTPUT_SAMPLE_RATE = 24000

export interface VoiceTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface VoiceSessionEvents {
  /** User speech transcript, accumulated per turn. */
  onUserTranscript?: (text: string) => void
  /** Assistant speech transcript (partial or final chunks). */
  onAssistantTranscript?: (text: string) => void
  /** A proposal returned by a server-side tool call; renders as ActionCard. */
  onProposal?: (proposal: ChatProposal) => void
  /** Non-fatal problem (permission denied, tool error) shown in the UI. */
  onError?: (message: string) => void
  /** Turn finished (turnComplete or interrupted): flush transcripts. */
  onTurnComplete?: (turns: VoiceTurn[]) => void
  /** Socket closed / goAway: return to text mode. */
  onClose?: (reason: string) => void
}

export interface VoiceSession {
  sendAudio: (base64Pcm16: string) => void
  close: () => void
}

// --- PCM16 <-> base64 ---------------------------------------------------------
// Float32 [-1,1] @ INPUT_SAMPLE_RATE -> Int16 -> base64. Exposed for tests.
export function float32ToPcm16Base64(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let binary = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// base64 PCM16 @ OUTPUT_SAMPLE_RATE -> Float32 [-1,1], for AudioContext playback.
export function base64ToFloat32Pcm16(base64: string): Float32Array {
  const binary = atob(base64)
  const len = binary.length / 2
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const lo = binary.charCodeAt(i * 2)
    const hi = binary.charCodeAt(i * 2 + 1)
    const v = (hi << 8) | lo
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000
  }
  return out
}

// --- Transcript accumulation ---------------------------------------------------
// Accumulates input/output transcriptions across a turn and flushes them as
// user/assistant chat messages on turnComplete/interrupted. Exposed for tests.
export class TranscriptBuffer {
  private input = ''
  private output = ''

  pushInput(text: string) { this.input += text }
  pushOutput(text: string) { this.output += text }

  /** Drain and return the completed turn pair (empty entries omitted). */
  flush(): VoiceTurn[] {
    const turns: VoiceTurn[] = []
    if (this.input.trim()) turns.push({ role: 'user', content: this.input.trim() })
    if (this.output.trim()) turns.push({ role: 'assistant', content: this.output.trim() })
    this.input = ''
    this.output = ''
    return turns
  }
}

// --- Mic capture: getUserMedia + AudioWorklet (inline blob URL) ------------------
const WORKLET_SRC = `
class PcmSender extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('pcm-sender', PcmSender)
`

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null

  constructor(private onChunk: (samples: Float32Array) => void) {}

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await this.ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'pcm-sender')
    this.node.port.onmessage = (e) => this.onChunk(e.data as Float32Array)
    source.connect(this.node)
  }

  stop() {
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}

// --- Speaker playback: queue 24 kHz PCM16, schedulable + clearable --------------
export class Speaker {
  private ctx: AudioContext | null = null
  private queue: { buffer: AudioBuffer; at: number }[] = []
  private nextAt = 0

  constructor(private sampleRate = OUTPUT_SAMPLE_RATE) {}

  private ensureCtx() {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: this.sampleRate })
    return this.ctx
  }

  /** Enqueue one base64 PCM16 chunk; returns its scheduled start time. */
  play(base64: string): number {
    const ctx = this.ensureCtx()
    const samples = base64ToFloat32Pcm16(base64)
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const now = ctx.currentTime
    if (this.nextAt < now) this.nextAt = now + 0.02
    const at = this.nextAt
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.start(at)
    this.nextAt = at + buffer.duration
    this.queue.push({ buffer, at })
    return at
  }

  /** Stop everything and clear the queue (barge-in / interrupt). */
  clear() {
    for (const _ of this.queue) { /* sources are one-shot; times below stop them */ }
    if (this.ctx) {
      // Close and recreate so any scheduled chunks die with the old context.
      const old = this.ctx
      this.ctx = null
      void old.close().catch(() => {})
    }
    this.queue = []
    this.nextAt = 0
  }

  close() { this.clear() }
}

// --- Session --------------------------------------------------------------------
export async function startVoiceSession(opts: {
  organization_id: number
  session_id: string
  voiceName?: string
  events: VoiceSessionEvents
}): Promise<VoiceSession> {
  const res = await fetch('/api/chat/voice/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: opts.organization_id, session_id: opts.session_id, voiceName: opts.voiceName }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error ?? `Voice session failed (${res.status})`)
  }
  const { token, model } = (await res.json()) as { token: string; model: string }

  const client = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })

  const events = opts.events
  const transcripts = new TranscriptBuffer()
  const speaker = new Speaker()
  let closed = false
  let toolCallId: string | null = null
  let toolName: string | null = null
  let toolArgs: Record<string, unknown> = {}
  let apiToolCall = false // true when the toolCall needs a server round-trip

  const flushTurn = () => {
    const turns = transcripts.flush()
    if (turns.length > 0) {
      events.onTurnComplete?.(turns)
      void fetch('/api/chat/voice/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: opts.organization_id, session_id: opts.session_id, turns }),
      }).catch(() => {})
    }
  }

  const session = await client.live.connect({
    model: `models/${model}`,
    callbacks: {
      onmessage: (msg: any) => {
        // Model audio out.
        const parts = msg?.serverContent?.modelTurn?.parts ?? []
        for (const p of parts) {
          if (p.inlineData?.data) speaker.play(p.inlineData.data)
        }
        if (msg?.serverContent?.outputTranscription?.text) {
          const t = msg.serverContent.outputTranscription.text
          transcripts.pushOutput(t)
          events.onAssistantTranscript?.(t)
        }
        if (msg?.serverContent?.inputTranscription?.text) {
          const t = msg.serverContent.inputTranscription.text
          transcripts.pushInput(t)
          events.onUserTranscript?.(t)
        }
        // Barge-in: stop and clear queued audio.
        if (msg?.serverContent?.interrupted) {
          speaker.clear()
          flushTurn()
        }
        if (msg?.serverContent?.turnComplete) flushTurn()
        if (msg?.serverContent?.generationComplete) { /* audio-only bookkeeping */ }

        // Server-side tool call: needs a toolResponse.
        if (msg?.toolCall) {
          toolCallId = msg.toolCall.id
          for (const call of msg.toolCall.functionCalls ?? []) {
            toolName = call.name
            toolArgs = call.args ?? {}
          }
          apiToolCall = toolName !== 'confirm_pending_action' && toolName !== 'cancel_pending_action'
        }
      },
      onerror: (err: unknown) => {
        events.onError?.('Voice connection error. Returning to text chat.')
        close('error')
      },
      onclose: (ev: unknown) => {
        const reason = (ev as { reason?: string } | undefined)?.reason
        close(reason ?? 'closed')
      },
    },
  })

  // Client-handled tools are resolved in the UI; everything else goes to the
  // server, which enforces role gates and returns the proposal (never writes).
  const resolveToolCall = async () => {
    if (!toolCallId || !toolName) return
    const id = toolCallId
    const name = toolName
    toolCallId = null
    toolName = null
    if (name === 'confirm_pending_action' || name === 'cancel_pending_action') return // handled by caller via onToolCall
    try {
      const res = await fetch('/api/chat/voice/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: opts.organization_id,
          session_id: opts.session_id,
          name,
          args: toolArgs,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.proposal) events.onProposal?.(data.proposal as ChatProposal)
      const output = { result: data?.output ?? data ?? { error: 'tool failed' } }
      session.sendToolResponse({ functionResponses: [{ id, name, response: output }] })
    } catch {
      session.sendToolResponse({ functionResponses: [{ id, name, response: { error: 'tool call failed' } }] })
    }
  }

  // Polling is ugly but the SDK delivers toolCall and audio in one onmessage
  // stream; a microtask after each message resolves any pending tool call.
  // ponytail: replace with a proper per-message hook if the SDK grows one.
  const tick = setInterval(() => { if (apiToolCall) { apiToolCall = false; void resolveToolCall() } }, 100)

  let mic: MicCapture | null = null

  async function connectMic() {
    mic = new MicCapture(samples => {
      try { session.sendRealtimeInput({ media: { data: float32ToPcm16Base64(samples), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` } }) } catch { /* socket closing */ }
    })
    await mic.start()
  }

  function close(reason: string) {
    if (closed) return
    closed = true
    clearInterval(tick)
    mic?.stop()
    speaker.close()
    flushTurn()
    try { session.close() } catch { /* already closed */ }
    events.onClose?.(reason)
  }

  await connectMic()

  return {
    sendAudio: () => { /* mic pipeline sends directly */ },
    close: () => close('user'),
  }
}
