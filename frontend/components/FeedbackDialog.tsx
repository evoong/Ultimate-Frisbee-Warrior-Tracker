import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
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

export default function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const [type, setType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issueUrl, setIssueUrl] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setType('bug')
      setTitle('')
      setDescription('')
      setError(null)
      setIssueUrl(null)
    }
  }, [open])

  async function handleSubmit() {
    if (!title.trim() || !description.trim()) {
      setError('Please fill in both a title and a description.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const { url } = await submitFeedback({ type, title: title.trim(), description: description.trim() })
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
