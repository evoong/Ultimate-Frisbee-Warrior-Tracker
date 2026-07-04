import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../lib/shadcn/dialog'
import { Button } from '../lib/shadcn/button'
import { Skeleton } from '../lib/shadcn/skeleton'
import { deletePasskey, listPasskeys, registerPasskey, type PasskeyInfo } from '../lib/authClient'
import { isCeremonyCancelled } from '../lib/passkeys'

type PasskeysDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Lists the signed-in user's passkeys with add and delete actions. Only
// reachable on the passkey host (see passkeysAvailable), so it can assume the
// WebAuthn ceremony works here.
export default function PasskeysDialog({ open, onOpenChange }: PasskeysDialogProps) {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setPasskeys(await listPasskeys())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load passkeys')
      setPasskeys([])
    }
  }, [])

  useEffect(() => {
    if (open) {
      setPasskeys(null)
      setError(null)
      void reload()
    }
  }, [open, reload])

  async function handleAdd() {
    setError(null)
    setBusy(true)
    try {
      await registerPasskey()
      await reload()
    } catch (err) {
      if (!isCeremonyCancelled(err)) {
        const message = err instanceof Error ? err.message : 'Could not add a passkey'
        setError(
          /exists/i.test(message)
            ? 'This device already has a passkey for your account.'
            : message
        )
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setError(null)
    setBusy(true)
    try {
      await deletePasskey(id)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the passkey')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Passkeys</DialogTitle>
          <DialogDescription>
            Sign in with Face ID, Touch ID, or a security key instead of your password.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="space-y-2">
          {passkeys === null ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : passkeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys yet.</p>
          ) : (
            passkeys.map(pk => (
              <div
                key={pk.id}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{pk.friendly_name || 'Passkey'}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {new Date(pk.created_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(pk.id)}
                  disabled={busy}
                  className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                  aria-label="Delete passkey"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>

        <Button onClick={handleAdd} disabled={busy || passkeys === null} className="w-full">
          {busy ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 mr-2" />
          )}
          Add a passkey
        </Button>
      </DialogContent>
    </Dialog>
  )
}
