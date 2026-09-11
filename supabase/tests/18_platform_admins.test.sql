begin;
select plan(9);

select has_table('public', 'platform_admins', 'platform_admins exists');
select has_table('public', 'admin_audit_log', 'admin_audit_log exists');

-- Both tables are service-role-only: RLS on, zero policies, no grants.
select is_empty(
  $$ select p.polname::text from pg_policy p
       join pg_class c on c.oid = p.polrelid
      where c.relname in ('platform_admins', 'admin_audit_log') $$,
  'neither admin table has any policy'
);

select is_empty(
  $$ select c.relname::text from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('platform_admins', 'admin_audit_log')
        and not c.relrowsecurity $$,
  'both admin tables have RLS enabled'
);

select is_empty(
  $$ select c.relname::text from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relname in ('platform_admins', 'admin_audit_log')
        and a.grantee in ('anon'::regrole, 'authenticated'::regrole) $$,
  'neither anon nor authenticated holds any privilege on the admin tables'
);

-- An audit row must survive the deletion of the admin who wrote it.
select col_has_check('public', 'admin_audit_log', 'result',
  'result is constrained');

-- Append-only: the log accepts inserts and refuses everything else.
insert into public.admin_audit_log (admin_id, admin_role, operation, target, result)
select id, 'superadmin', 'test_op', '{"k":1}'::jsonb, 'ok'
  from auth.users limit 1;

select throws_ok(
  $$ update public.admin_audit_log set operation = 'tampered' $$,
  'admin_audit_log is append-only',
  'UPDATE on admin_audit_log is rejected'
);

select throws_ok(
  $$ delete from public.admin_audit_log $$,
  'admin_audit_log is append-only',
  'DELETE on admin_audit_log is rejected'
);

-- pgTAP's 3-arg throws_ok(sql, code, description) overload doesn't exist:
-- a bare 5-character second argument resolves to the (sql, errcode, errmsg)
-- overload, which compares that third string against the raised message
-- verbatim rather than treating it as a description -- so an explicit
-- errcode cast plus a NULL errmsg is needed to check the SQLSTATE only and
-- still get a readable description.
select throws_ok(
  $$ insert into public.platform_admins (user_id, role)
     select id, 'wizard' from auth.users limit 1 $$,
  '23514'::char(5),
  NULL,
  'an unknown admin role is rejected by the check constraint'
);

select * from finish();
rollback;
