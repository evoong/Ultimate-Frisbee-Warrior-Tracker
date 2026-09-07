// Pure escalation rules for the feedback triage pipeline. No network, no
// database, no clock: these are the decisions that turn user-submitted text
// into automated production changes, so they are kept trivially testable and
// every threshold is named rather than inlined at a call site.
//
// See docs/superpowers/specs/2026-09-06-feedback-triage-pipeline-design.md.

export const DISPATCH_THRESHOLD = 3
export const CONFLICT_MARGIN = 2
export const CONFLICT_MINIMUM = 3

export type ClusterType = 'bug' | 'feature'

export interface VariantTally {
  label: string | null
  reporters: number
}

export type TriageOutcome =
  | { action: 'hold' }
  | { action: 'dispatch'; variantLabel: string | null }
  | { action: 'await_approval'; variantLabel: string | null }
  | { action: 'decision_needed'; tally: VariantTally[] }

// A cluster is "in conflict" when reports disagree about the desired outcome,
// which the judge records as two or more distinct variant labels. One label
// (or none) means everyone wants the same thing.
function labelledVariants(tallies: VariantTally[]): VariantTally[] {
  return tallies.filter(t => t.label !== null)
}

function byReportersDesc(a: VariantTally, b: VariantTally): number {
  return b.reporters - a.reporters
}

export function decideEscalation(
  type: ClusterType,
  tallies: VariantTally[]
): TriageOutcome {
  const variants = labelledVariants(tallies)

  if (variants.length >= 2) {
    const [winner, runnerUp] = [...variants].sort(byReportersDesc)
    const decisive =
      winner.reporters >= CONFLICT_MINIMUM &&
      winner.reporters >= runnerUp.reporters * CONFLICT_MARGIN
    if (!decisive) {
      // Under the reporter minimum there is no signal worth a human's
      // attention yet; at or above it, the split is real and needs a call.
      return winner.reporters >= CONFLICT_MINIMUM
        ? { action: 'decision_needed', tally: [...variants].sort(byReportersDesc) }
        : { action: 'hold' }
    }
    return type === 'bug'
      ? { action: 'dispatch', variantLabel: winner.label }
      : { action: 'await_approval', variantLabel: winner.label }
  }

  const total = tallies.reduce((sum, t) => sum + t.reporters, 0)
  if (total < DISPATCH_THRESHOLD) return { action: 'hold' }
  return type === 'bug'
    ? { action: 'dispatch', variantLabel: null }
    : { action: 'await_approval', variantLabel: null }
}
