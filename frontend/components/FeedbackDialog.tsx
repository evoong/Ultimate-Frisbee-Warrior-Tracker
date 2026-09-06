import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ImagePlus, Loader2, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../lib/shadcn/dialog'
import { Button } from '../lib/shadcn/button'
import { Label } from '../lib/shadcn/label'
import { Input } from '../lib/shadcn/input'
import { Textarea } from '../lib/shadcn/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../lib/shadcn/select'
import { submitFeedback, type FeedbackType } from '../lib/feedbackClient'

type FeedbackDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Matches the server's multer limit for this route (server/index.ts).
const MAX_PHOTO_BYTES = 5 * 1024 * 1024

export default function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const [type, setType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issueUrl, setIssueUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setType('bug')
      setTitle('')
      setDescription('')
      setPhoto(null)
      setError(null)
      setIssueUrl(null)
    }
  }, [open])

  // Revokes the previous preview URL whenever the photo changes or the
  // dialog unmounts, so object URLs don't leak across submissions.
  useEffect(() => {
    if (!photo) {
      setPhotoPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(photo)
    setPhotoPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Only image files are allowed.')
      return
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError('That image is too large (5MB max).')
      return
    }
    setError(null)
    setPhoto(file)
  }

  async function handleSubmit() {
    if (!title.trim() || !description.trim()) {
      setError('Please fill in both a title and a description.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const { url } = await submitFeedback({
        type,
        title: title.trim(),
        description: description.trim(),
        photo: photo ?? undefined,
      })
      setIssueUrl(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit your report')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Report a bug or idea</DialogTitle>
          <DialogDescription>
            Tell us what's wrong or what you'd like to see. We track these as GitHub issues.
          </DialogDescription>
        </DialogHeader>

        {issueUrl ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-500" />
            <p className="text-sm">Thanks! Your report has been filed.</p>
            <a
              href={issueUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary underline underline-offset-2"
            >
              View the issue
            </a>
            <Button onClick={() => onOpenChange(false)} className="w-full mt-2">Close</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="space-y-2">
              <Label htmlFor="feedback-type">Type</Label>
              <Select value={type} onValueChange={v => setType(v as FeedbackType)}>
                <SelectTrigger id="feedback-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bug">Bug</SelectItem>
                  <SelectItem value="feature">Feature request</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="feedback-title">Title</Label>
              <Input
                id="feedback-title"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Short summary"
                maxLength={200}
                disabled={busy}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="feedback-description">Description</Label>
              <Textarea
                id="feedback-description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What happened, or what would you like to see?"
                rows={5}
                maxLength={5000}
                disabled={busy}
              />
            </div>

            <div className="space-y-2">
              <Label>Screenshot (optional)</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handlePhotoChange}
                className="hidden"
                disabled={busy}
              />
              {photo && photoPreviewUrl ? (
                <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                  <img src={photoPreviewUrl} alt="" className="h-10 w-10 rounded object-cover shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-sm">{photo.name}</span>
                  <button
                    type="button"
                    onClick={() => setPhoto(null)}
                    disabled={busy}
                    className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                    aria-label="Remove screenshot"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  className="w-full"
                >
                  <ImagePlus className="w-4 h-4 mr-2" />
                  Attach a screenshot
                </Button>
              )}
            </div>

            <Button onClick={handleSubmit} disabled={busy} className="w-full">
              {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Submit
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
