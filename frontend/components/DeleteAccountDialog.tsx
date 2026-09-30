import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Trash, WarningCircle } from '@phosphor-icons/react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../lib/shadcn/dialog'
import { Button } from '../lib/shadcn/button'
import { Input } from '../lib/shadcn/input'
import { Skeleton } from '../lib/shadcn/skeleton'
import { useAuth } from '../contexts/AuthContext'

export type DeleteAccountDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  email: string | null
}

interface Blockers {
  deletable: boolean
  isPlatformAdmin: boolean
  soleCaptainTeams: { team_id: number; name: string | null }[]
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <WarningCircle className="mt-px size-3.5 shrink-0" weight="bold" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  )
}

export function DeleteAccountDialog({ open, onOpenChange, email }: DeleteAccountDialogProps) {
  const { logout } = useAuth()
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [blockers, setBlockers] = useState<Blockers | null>(null)
  const [confirmInput, setConfirmInput] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSubmitError(null)
    setBlockers(null)
    setConfirmInput('')

    fetch('/api/account/delete/blockers', { credentials: 'include' })
      .then(async res => {
        const body = await res.json().catch(() => null)
        if (!res.ok) {
          throw new Error(body?.error ?? `Could not check account status (${res.status})`)
        }
        return body as Blockers
      })
      .then(data => {
        if (!cancelled) {
          setBlockers(data)
        }
      })
      .catch(err => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Could not check account status')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open])

  const isConfirmed = email !== null && confirmInput.toLowerCase() === email.toLowerCase()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!isConfirmed || deleting) return
    setDeleting(true)
    setSubmitError(null)
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ confirmationEmail: confirmInput }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(body?.error ?? 'Account deletion failed')
      }
      await logout()
      onOpenChange(false)
      window.location.assign('/')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Account deletion failed')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash className="size-5 shrink-0" weight="bold" />
            Delete account
          </DialogTitle>
          <DialogDescription>
            {loading
              ? 'Checking account deletion status…'
              : blockers && !blockers.deletable
              ? 'This account cannot be deleted yet.'
              : 'Permanently delete your account and remove your access.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : loadError ? (
          <div className="space-y-4 pt-1">
            <ErrorNote>{loadError}</ErrorNote>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : blockers && !blockers.deletable ? (
          <div className="space-y-4 pt-1">
            <div className="space-y-3 rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-relaxed">
              {blockers.isPlatformAdmin && (
                <p className="text-foreground">
                  You are a <strong>platform administrator</strong>. Contact support to have your admin access removed first.
                </p>
              )}
              {blockers.soleCaptainTeams.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-foreground">
                    You are the only captain of:
                  </p>
                  <ul className="list-disc space-y-0.5 pl-4 text-foreground/90">
                    {blockers.soleCaptainTeams.map(t => (
                      <li key={t.team_id}>
                        <strong>{t.name ?? `Team #${t.team_id}`}</strong>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    Transfer captainship or delete these teams before deleting your account.
                  </p>
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 pt-1">
            <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                This action is <strong className="text-foreground">permanent and cannot be undone</strong>.
              </p>
              <p>
                You will be removed from all teams, your player links will be deleted, and your account data cannot be recovered.
              </p>
              <p>
                Your email <strong className="text-foreground">{email}</strong> can never be used to log in or sign up again.
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="confirm-delete-email" className="block text-xs font-medium text-foreground">
                Type your email to confirm:
              </label>
              <Input
                id="confirm-delete-email"
                type="email"
                placeholder={email ?? ''}
                value={confirmInput}
                onChange={e => setConfirmInput(e.target.value)}
                autoComplete="off"
                className="text-base sm:text-sm"
              />
            </div>

            {submitError && <ErrorNote>{submitError}</ErrorNote>}

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={deleting}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={!isConfirmed || deleting}
              >
                <Trash className="mr-1.5 size-4" weight="regular" />
                {deleting ? 'Deleting…' : 'Delete account'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
export default DeleteAccountDialog
