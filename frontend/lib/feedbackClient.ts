export type FeedbackType = 'bug' | 'feature'

export interface FeedbackReport {
  type: FeedbackType
  title: string
  description: string
  photo?: File
}

export interface FeedbackResult {
  url: string
  alreadyTracked: boolean
  reportCount: number
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    return data?.error || `request failed (${res.status})`
  } catch {
    return `request failed (${res.status})`
  }
}

// Files the report as a GitHub issue via the server (see POST /api/feedback);
// the returned URL lets the reporter jump straight to the tracked issue.
// multipart/form-data throughout (not just when a photo is attached) so the
// server always parses the same way regardless of whether one was sent.
export async function submitFeedback(report: FeedbackReport): Promise<FeedbackResult> {
  const body = new FormData()
  body.set('type', report.type)
  body.set('title', report.title)
  body.set('description', report.description)
  if (report.photo) body.set('photo', report.photo)

  const res = await fetch('/api/feedback', {
    method: 'POST',
    credentials: 'include',
    body,
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}
