begin;
select plan(7);

-- Seed while running as postgres (bypasses RLS): one row owned by the
-- org-1 editor, one legacy row with no owner, both in the private org 1.
insert into public.chat_logs (session_id, user_id, role, content, organization_id)
select 'seed-editor', u.id::text, 'user', 'editor thread', 1
  from auth.users u where u.email = 'editor@local.test';
insert into public.chat_logs (session_id, user_id, role, content, organization_id)
values ('seed-legacy', null, 'user', 'legacy thread', 1);

-- chat_logs.user_id is text (baseline schema); auth.uid() is uuid, so every
-- comparison/insert casts uuid -> text on the auth side.
select tests.login_as('editor@local.test');
select is_empty(
  $$ select id from public.chat_logs where session_id = 'seed-legacy' $$,
  'a legacy row with null user_id is invisible to every client'
);
select lives_ok(
  $$ insert into public.chat_logs (session_id, user_id, role, content, organization_id)
     values ('seed-editor-2', auth.uid()::text, 'user', 'own row', 1) $$,
  'the owner can insert a chat row as themselves'
);

select tests.logout();
select tests.login_as('member@local.test');
select is_empty(
  $$ select id from public.chat_logs where session_id = 'seed-editor' $$,
  'a teammate cannot read another member''s chat thread'
);
select throws_ok(
  $$ insert into public.chat_logs (session_id, user_id, role, content, organization_id)
     select 'spoof', (select id::text from auth.users where email = 'editor@local.test'), 'user', 'spoofed', 1 $$,
  '42501', null,
  'a member cannot insert a chat row attributed to another user'
);
-- RLS-filtered DELETE is a silent no-op, not a 42501: a policy USING
-- clause hides the row, so the statement affects 0 rows and raises
-- nothing. Assert the affected row count instead of the exception
-- (results_eq runs the string as a top-level statement, which is where
-- a data-modifying CTE is allowed).
select results_eq(
  $$ with gone as (
     delete from public.chat_logs where session_id = 'seed-editor' returning id
   ) select count(*)::text from gone $$,
  $$ select '0'::text $$,
  'a member cannot delete a teammate''s thread'
);

select tests.logout();
select tests.login_as('outsider@local.test');
select is_empty(
  $$ select id from public.chat_logs where organization_id = 1 $$,
  'an org-2 captain cannot read org-1 chat logs'
);

select tests.logout();
select tests.login_as('editor@local.test');
select lives_ok(
  $$ delete from public.chat_logs where session_id = 'seed-editor' $$,
  'the owner can delete their own thread'
);

select * from finish();
rollback;
