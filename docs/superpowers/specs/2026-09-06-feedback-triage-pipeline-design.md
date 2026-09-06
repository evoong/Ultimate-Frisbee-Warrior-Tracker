# Feedback triage pipeline: design

## Summary

The in-app feedback form (`POST /api/feedback`, shipped 2026-09-06) files
every submission as a new GitHub issue. Nothing dedupes them, nothing counts
them, and nothing acts on them. Ten people hitting the same bug produce ten
issues; a bug reported by one person and a bug reported by fifty look
identical in the tracker.

This design replaces that with a triage pipeline:

- **Consolidation.** A new report is compared against existing open clusters
  at submit time. A match attaches to the existing cluster and comments on
  its GitHub issue instead of filing a new one, so duplicates never reach the
  tracker at all.
- **Counting.** Each cluster tracks how many *distinct reporters* have hit
  it. The count drives escalation and is visible in the issue body.
- **Conflict handling.** Reports that want mutually exclusive outcomes
  ("sidebar on the left" vs "sidebar on the right") cluster together but are
  tagged with opposing `variant_label`s. A variant only wins with a decisive
  margin; otherwise a human decides.
- **Automated implementation.** A cluster that crosses the report threshold
  dispatches a Claude Code agent (Sonnet 5) that implements the change and
  opens a PR. Bugs dispatch automatically. Features never dispatch without
  explicit human approval, so no agent tokens are spent on work that might be
  rejected.

The constraint that drives the risk decisions below: **this pipeline converts
user-submitted text into code that merges to production.** Every design choice
about trust boundaries follows from that.

## Goals

- A duplicate report never creates a second GitHub issue.
- The number of distinct people affected by an issue is a first-class,
  queryable fact rather than something inferred by reading comments.
- Agent runs are spent only on work that is either objectively broken (bugs)
  or explicitly wanted (human-approved features).
- Conflicting requests are never silently resolved by a coin-flip margin.
- No submitter can escalate their own report into unreviewed production code
  by submitting it repeatedly or from throwaway accounts.

## Non-goals

- Embedding/vector search. Deferred until open cluster count makes prompt
  size a real problem (see "Matching mechanism").
- An in-app admin queue UI. Approval happens via GitHub labels.
- Automatic closing of clusters when a PR merges beyond GitHub's own
  `Fixes #n` linkage.

## Decisions taken (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Dedup timing | Synchronous, at submit | Reporter gets immediate "already tracked" feedback; the tracker never accumulates duplicates that later need merging. |
| Matching mechanism | LLM judge (Gemini), no embeddings | Embeddings cannot distinguish opposing variants — "sidebar left" and "sidebar right" are near-identical vectors. Conflict detection requires semantic judgment. |
| Dispatch threshold | 3 distinct reporters | Chosen by the repo owner. |
| Conflict resolution | Majority wins, needs ≥2× runner-up and ≥3 reporters | Majority chosen by the repo owner; the margin guard prevents a 4-vs-3 split shipping unreviewed. |
| Bug autonomy | Full — implement and auto-merge on green CI, any file class | Chosen by the repo owner after the CI-coverage limitation was raised explicitly. Phase 0 exists to make that gate meaningful. |
| Feature autonomy | Human approval required before any agent run | Chosen by the repo owner to avoid spending agent tokens on features that may be rejected. |
| Feature merge policy | Safe-class diffs auto-merge; others open a PR for review | The human approved the *feature*, not the *diff*. |
| Approval mechanism | `agent-approved` GitHub label | No new UI, works from mobile, and the label is its own audit trail. |

## Matching mechanism

One Gemini call per submission (`gemini-flash-lite-latest`, the model already
wired for chat). Input: the new report, plus every open cluster's id, type,
title, summary, and known variant labels. Output, as strict JSON:

```json
{
  "relation": "same" | "conflicting_variant" | "new",
  "match_cluster_id": 42,
  "variant_label": "sidebar-right",
  "suggested_title": "...",
  "suggested_summary": "..."
}
```

`conflicting_variant` means "same subject as that cluster, incompatible
desired outcome" — it attaches to the cluster and records the opposing label.

The report's own text is inserted into the prompt inside an explicit
untrusted-data boundary, mirroring the convention already used for the AI
chat's team context. A malformed or unparseable response falls back to
`relation: "new"` — filing an extra issue is a strictly better failure than
silently attaching a report to the wrong cluster.

**Upgrade path (not built now):** when open clusters exceed roughly 100, the
prompt grows unwieldy. At that point add `pgvector`, embed cluster summaries,
and shortlist the top 5 candidates before the judging call. The judge's
interface does not change, so this is an internal swap.

## Data model

Two new tables. Both are service-role-only: the pipeline is entirely
server-side, so `authenticated` and `anon` get no policies and no grants.

```sql
feedback_clusters
  id                        bigserial primary key
  created_at, updated_at    timestamptz
  type                      text check (type in ('bug','feature'))
  title                     text
  summary                   text
  github_issue_number       integer
  status                    text check (status in
                              ('open','awaiting_approval','decision_needed',
                               'dispatched','implemented'))
  winning_variant_label     text null
  dispatched_at             timestamptz null
  agent_run_url             text null

feedback_reports
  id                        bigserial primary key
  created_at                timestamptz
  reporter_user_id          uuid          -- auth.users
  type                      text
  title, description        text
  photo_path                text null     -- feedback-attachments object path
  cluster_id                bigint refs feedback_clusters
  variant_label             text null
  github_comment_id         bigint null
  counts_toward_threshold   boolean       -- see "Abuse surface"
```

The occurrence count is `count(distinct reporter_user_id) where
counts_toward_threshold`. It is computed, never stored — a stored counter is
a cache that can disagree with its source.

## Submission flow

Inside the existing `POST /api/feedback` handler, after the current auth
check and attachment upload:

1. Insert the `feedback_reports` row.
2. Load open clusters (id, type, title, summary, variant labels).
3. Judge call (above).
4. **`new`** → create the GitHub issue via the existing code path, insert the
   cluster row, link the report.
   **`same` / `conflicting_variant`** → link the report to the matched
   cluster, post a comment on that cluster's issue carrying this reporter's
   description and screenshot, and rewrite the issue body's tally line.
5. Recompute the cluster's distinct-reporter count and apply the escalation
   rules.
6. Return to the client: the issue URL, whether it was newly filed or
   attached, and the current report count.

Reporter-visible result: *"Filed — here's your issue"* or *"Already tracked —
we added your report (now 3 reports)"* with a link either way.

**Failure isolation:** if the judge call or the GitHub call fails, the report
row is already persisted with `cluster_id` null. The endpoint returns an error
to the reporter, but the signal is not lost. Losing a user's bug report
because an LLM call timed out is the worst available outcome.

**Reconciliation:** orphaned rows (`cluster_id` null, or a cluster whose
`github_issue_number` is null because the GitHub call failed) are retried by
the existing daily cron — `/api/cron/sync-jam`'s schedule already runs at
10:00 UTC in both runtimes, and this adds a second task beside it rather than
a new scheduling mechanism. The retry runs the same judge-and-attach path as
a live submission.

## Escalation rules

Evaluated after every report attaches.

The three constants — dispatch threshold (3), conflict margin (2×), and
conflict minimum (3) — live as named module constants beside the rule
function, not scattered through the call sites, so tuning them is a one-line
change with the tests naming what each value means.

**No conflict present** (cluster has ≤1 distinct variant label):

- `distinct reporters < 3` → stay `open`, do nothing.
- `≥3` and `type = 'bug'` → set `dispatched`, fire the agent.
- `≥3` and `type = 'feature'` → set `awaiting_approval`, add the
  `awaiting-approval` label, comment on the issue explaining that a human
  must approve. **No agent run.** When a human adds `agent-approved`, the
  workflow dispatches.

**Conflict present** (≥2 distinct variant labels):

- Winner needs `≥3` distinct reporters **and** `≥2×` the runner-up's distinct
  reporters. If satisfied, record `winning_variant_label` and proceed by type
  as above (a feature still needs approval).
- Otherwise → `decision_needed`, label the issue, comment with the tally per
  variant, and dispatch nothing until a human resolves it.

Resolving a `decision_needed` cluster never involves hand-editing the
database. The human adds `agent-approved`; the agent is given the per-variant
tally and implements the leading variant. To choose the *minority* variant
instead, the human says so in an issue comment before labelling — issue
comments authored by users with write access to the repo are included in the
agent's prompt as instructions, unlike report text, which is always untrusted
data.

## Agent dispatch

`.github/workflows/feedback-agent.yml`, using `anthropics/claude-code-action`
with model `claude-sonnet-5`. Two triggers:

- `repository_dispatch` (event type `feedback-agent`) — sent by the server
  when a bug auto-escalates.
- `issues.labeled` with `agent-approved` — the human-approval path.

The job checks out `main`, creates `agent/issue-<n>`, and prompts the agent
with the cluster's title, summary, and each report's text **inside an
explicit untrusted-data boundary**, framed as evidence to diagnose from, never
as instructions to follow. It opens a PR with `Fixes #<n>`.

## Merge policy

A `safe-class` CI check inspects the PR diff and passes only if it touches
none of: `supabase/migrations/**`, `gateway/**`, `server/**`,
`supabase-migrations/**`, or `.github/workflows/**`.

- **Bug PRs** — auto-merge on green CI regardless of the safe-class result.
- **Feature PRs** — auto-merge on green CI only when safe-class passes;
  otherwise the PR stays open for human review.

The distinction is enforced by the workflow reading the issue's `bug` /
`enhancement` label, not by the agent asserting which kind of change it made.

## Phase 0: CI hardening (prerequisite)

`ci.yml` today runs `npm run build` and `npm run test:gateway:offline`, and
its own comments record that the pgTAP suite and integration tests are
deliberately excluded. Bug PRs are now permitted to auto-merge changes to
migrations, RLS policies, and gateway auth — precisely the classes that
suite covers and the current CI does not.

Phase 0 therefore stands up the local Supabase stack in CI and runs
`npm run db:test` (pgTAP) plus the excluded integration suites, so that
"green CI" gates what it is now being trusted to gate. This phase ships
before any agent is permitted to dispatch.

## Abuse surface

Signup is open and guest sessions exist. Bug fixes auto-merge every file
class. Absent a control, three throwaway accounts filing the same crafted
"bug report" is a cheap path to agent-written authentication code reaching
production unreviewed.

Controls, in order of load-bearing-ness:

1. **Only established team members count toward the threshold.**
   `counts_toward_threshold` is true only when the reporter is a non-guest
   member of at least one team. Guests and unaffiliated accounts may still
   file reports — they simply do not escalate. This removes the cheap
   sockpuppet path.
2. **Distinct reporters, never raw submissions.** One user submitting three
   times counts once.
3. **Untrusted-data framing** in both the judge prompt and the agent prompt.
   Report text is evidence, never instruction.
4. **The safe-class check reads the diff, not the agent's claims.** For
   feature PRs a fully hijacked agent still cannot auto-merge a change to
   auth or migrations.

**Residual risk, stated plainly:** for *bugs*, control 4 does not apply by
explicit decision — a bug PR auto-merges any file class. The remaining
barriers are controls 1–3 plus whatever Phase 0's CI actually catches. Three
colluding real team members, or one compromised member account plus two
others, can still steer an agent at `gateway/`. Accepted by the repo owner
with the tradeoff named.

## Testing

- **pgTAP** — the two new tables reject `authenticated` and `anon` entirely;
  the distinct-reporter count ignores repeat submissions from one user and
  ignores reports where `counts_toward_threshold` is false.
- **Offline unit tests** — escalation rules as a pure function over
  (type, per-variant reporter counts): below threshold, at threshold, bug vs
  feature, conflict with a decisive margin, conflict without one. No LLM, no
  network.
- **Judge-call tests** — mocked Gemini responses covering `same`,
  `conflicting_variant`, `new`, and a malformed response falling back to
  `new`.
- **Integration** — submit two similar reports against the local stack and
  assert one cluster, one issue, two reports, count of 2.

## Phasing

| Phase | Contents | Ships behind |
|---|---|---|
| 0 | CI hardening: pgTAP + integration suites in `ci.yml` | — |
| 1 | Tables, migrations, report persistence. No behavior change: every report still files its own issue. | — |
| 2 | Judge call, clustering, issue comments and tally, reporter-facing "already tracked" response | — |
| 3 | Escalation rules, labels, `awaiting-approval` / `decision-needed` states | — |
| 4 | Agent workflow, `repository_dispatch`, safe-class check, merge policy | Phase 0 complete |

Phase 1 is deliberately inert: it establishes the data foundation while
leaving current behavior identical, so it can ship and be observed before any
clustering logic changes what reporters see.
