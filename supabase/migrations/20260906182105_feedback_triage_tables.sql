-- Source of truth for in-app feedback (POST /api/feedback). GitHub issues
-- become a projection of feedback_clusters rather than the store itself, so
-- "how many distinct people hit this" is a queryable fact instead of
-- something inferred by reading issue comments.
--
-- Both tables are service-role-only. The pipeline is entirely server-side:
-- the browser never reads or writes these, so RLS is enabled and NO policies
-- are created. Enabled-with-no-policies is default-deny for every role that
-- is not the service role, which is the intent -- not an oversight to be
-- "fixed" later by adding a permissive policy.

create table public.feedback_clusters (
  id                    bigint generated always as identity primary key,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  type                  text not null check (type in ('bug', 'feature')),
  title                 text not null,
  summary               text not null default '',
  github_issue_number   integer,
  status                text not null default 'open'
                          check (status in ('open', 'awaiting_approval',
                                            'decision_needed', 'dispatched',
                                            'implemented')),
  winning_variant_label text,
  dispatched_at         timestamptz,
  agent_run_url         text
);

create table public.feedback_reports (
  id                      bigint generated always as identity primary key,
  created_at              timestamptz not null default now(),
  reporter_user_id        uuid not null references auth.users(id) on delete cascade,
  type                    text not null check (type in ('bug', 'feature')),
  title                   text not null,
  description             text not null,
  photo_path              text,
  cluster_id              bigint references public.feedback_clusters(id) on delete set null,
  variant_label           text,
  github_comment_id       bigint,
  -- False for guests and users on no team. Such reports are still stored --
  -- the signal is real -- they simply cannot escalate anything on their own.
  -- This is what stops three throwaway accounts from dispatching an agent.
  counts_toward_threshold boolean not null default false
);

-- The reconciliation pass looks for orphans; the escalation check counts by
-- cluster. Both are cheap here and both run on every submission.
create index feedback_reports_cluster_idx on public.feedback_reports (cluster_id);
create index feedback_reports_orphan_idx on public.feedback_reports (created_at)
  where cluster_id is null;

alter table public.feedback_clusters enable row level security;
alter table public.feedback_reports  enable row level security;
