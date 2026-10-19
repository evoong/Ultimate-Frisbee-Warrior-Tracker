-- Index on organization_id for chat_action_proposals.
-- Enforces tenant query performance and passes pgTAP 04_indexes.test.sql.

create index if not exists chat_action_proposals_organization_id_idx
  on public.chat_action_proposals (organization_id);
