// Database access for the feedback triage pipeline. Kept separate from the
// judge (nondeterministic, network) and the rules (pure) so each can be read
// and tested on its own.

import { type ActionsConfig, sbGet, sbWrite } from './supabaseRest.js'
import type { VariantTally } from './feedbackTriage.js'

export interface StoredReport {
  id: number
  cluster_id: number | null
}

export interface OpenCluster {
  id: number
  type: 'bug' | 'feature'
  title: string
  summary: string
  github_issue_number: number | null
  status: string
  variant_labels: string[]
}

export async function insertReport(
  config: ActionsConfig,
  report: {
    reporterUserId: string
    type: 'bug' | 'feature'
    title: string
    description: string
    photoPath: string | null
    countsTowardThreshold: boolean
  }
): Promise<StoredReport> {
  const rows = await sbWrite(config, 'POST', '/feedback_reports', {
    reporter_user_id: report.reporterUserId,
    type: report.type,
    title: report.title,
    description: report.description,
    photo_path: report.photoPath,
    counts_toward_threshold: report.countsTowardThreshold,
  })
  return rows[0]
}

// Only clusters a new report could join. A dispatched or implemented cluster
// is deliberately still open to matching: the same bug reported again after
// dispatch belongs on the same issue, not on a new one.
export async function listOpenClusters(config: ActionsConfig): Promise<OpenCluster[]> {
  const clusters = await sbGet(
    config,
    '/feedback_clusters?select=id,type,title,summary,github_issue_number,status&status=neq.implemented'
  )
  const labels = await sbGet(
    config,
    '/feedback_reports?select=cluster_id,variant_label&variant_label=not.is.null'
  )
  return (clusters ?? []).map((c: any) => ({
    ...c,
    variant_labels: [
      ...new Set(
        (labels ?? [])
          .filter((l: any) => l.cluster_id === c.id)
          .map((l: any) => l.variant_label as string)
      ),
    ],
  }))
}

export async function attachReportToCluster(
  config: ActionsConfig,
  reportId: number,
  clusterId: number,
  variantLabel: string | null
): Promise<void> {
  await sbWrite(config, 'PATCH', `/feedback_reports?id=eq.${reportId}`, {
    cluster_id: clusterId,
    variant_label: variantLabel,
  })
}

export async function createCluster(
  config: ActionsConfig,
  cluster: {
    type: 'bug' | 'feature'
    title: string
    summary: string
    githubIssueNumber: number
  }
): Promise<number> {
  const rows = await sbWrite(config, 'POST', '/feedback_clusters', {
    type: cluster.type,
    title: cluster.title,
    summary: cluster.summary,
    github_issue_number: cluster.githubIssueNumber,
    status: 'open',
  })
  return rows[0].id
}

// The threshold is distinct reporters per variant. PostgREST cannot express
// count(distinct ...) grouped this way, so the distinct-ing happens here --
// which is also where the "one user submitting three times counts once" rule
// is enforced in exactly one place.
export async function tallyFor(
  config: ActionsConfig,
  clusterId: number
): Promise<VariantTally[]> {
  const rows = await sbGet(
    config,
    `/feedback_reports?select=reporter_user_id,variant_label&cluster_id=eq.${clusterId}&counts_toward_threshold=is.true`
  )
  const byLabel = new Map<string | null, Set<string>>()
  for (const row of rows ?? []) {
    const label = (row.variant_label ?? null) as string | null
    if (!byLabel.has(label)) byLabel.set(label, new Set())
    byLabel.get(label)!.add(row.reporter_user_id)
  }
  return [...byLabel.entries()].map(([label, reporters]) => ({
    label,
    reporters: reporters.size,
  }))
}

export async function setClusterStatus(
  config: ActionsConfig,
  clusterId: number,
  status: string,
  winningVariantLabel?: string | null
): Promise<void> {
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
  if (winningVariantLabel !== undefined) patch.winning_variant_label = winningVariantLabel
  if (status === 'dispatched') patch.dispatched_at = new Date().toISOString()
  await sbWrite(config, 'PATCH', `/feedback_clusters?id=eq.${clusterId}`, patch)
}
