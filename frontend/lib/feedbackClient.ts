export type FeedbackType = 'bug' | 'feature'

export interface FeedbackReport {
  type: FeedbackType
  title: string
  description: string
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
export async function submitFeedback(report: FeedbackReport): Promise<{ url: string }> {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}
