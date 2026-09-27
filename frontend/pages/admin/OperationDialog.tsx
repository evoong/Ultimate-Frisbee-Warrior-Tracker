import { useCallback, useEffect, useState } from 'react'
import { AdminRequestError, adminOp } from '../../lib/adminClient'

interface Props {
  name: string
  title: string
  input: Record<string, unknown>
  confirmPhrase?: string
  onDone: () => void
  onCancel: () => void
}

type Stage = 'previewing' | 'ready' | 'applying' | 'failed'

export default function OperationDialog({
  name, title, input, confirmPhrase, onDone, onCancel,
}: Props) {
  const [stage, setStage] = useState<Stage>('previewing')
  const [preview, setPreview] = useState<unknown>(null)
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null)
  const [typed, setTyped] = useState('')

  const runPreview = useCallback(async () => {
    setStage('previewing')
    setError(null)
    try {
      const res = await adminOp<{ preview: unknown }>(name, input, 'preview')
      setPreview(res.preview)
      setStage('ready')
    } catch (err) {
      const e = err as AdminRequestError
      setError({ message: e.message, requestId: e.requestId })
      setStage('failed')
    }
  }, [name, JSON.stringify(input)])

  useEffect(() => { void runPreview() }, [runPreview])

  async function runApply() {
    setStage('applying')
    setError(null)
    try {
      await adminOp(name, input, 'apply')
      onDone()
    } catch (err) {
      const e = err as AdminRequestError
      setError({ message: e.message, requestId: e.requestId })
      setStage('failed')
    }
  }

  const phraseSatisfied = !confirmPhrase || typed === confirmPhrase

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
      <div className="w-full max-w-lg rounded-md border bg-background p-5 shadow-none">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Operation <code>{name}</code>
        </p>

        <div className="mt-4 max-h-72 overflow-auto rounded border bg-muted/40 p-3">
          {stage === 'previewing' && <p className="text-sm text-muted-foreground">Checking…</p>}
          {preview !== null && (
            <pre className="whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(preview, null, 2)}
            </pre>
          )}
        </div>

        {error && (
          <div className="mt-3 text-sm text-destructive">
            {error.message}
            {error.requestId && <code className="ml-1">{error.requestId}</code>}
          </div>
        )}

        {confirmPhrase && (
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              Type <code>{confirmPhrase}</code> to confirm
            </p>
            <input
              type="text"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              className="mt-1 w-full rounded border bg-background px-2 py-1 text-sm"
              placeholder={confirmPhrase}
            />
          </div>
        )}

        <div className="mt-4 flex gap-2 justify-end">
          <button
            type="button"
            className="rounded border px-3 py-1.5 text-sm"
            onClick={onCancel}
            disabled={stage === 'applying'}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            onClick={runApply}
            disabled={stage !== 'ready' || !phraseSatisfied}
          >
            {stage === 'applying' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}