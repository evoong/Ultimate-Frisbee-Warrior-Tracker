begin;
select plan(6);

select tests.login_as('captain@local.test');
select is(public.my_member_team_ids(),  array[1]::bigint[], 'captain is a member of team 1');
select is(public.my_captain_team_ids(), array[1]::bigint[], 'captain holds captaincy of team 1');
select tests.logout();

select tests.login_as('editor@local.test');
select is(public.my_manage_team_ids(),  array[1]::bigint[], 'editor holds manage rights on team 1');
select is(public.my_captain_team_ids(), '{}'::bigint[],     'editor holds no captaincy');
select tests.logout();

select tests.login_as('member@local.test');
select is(public.my_manage_team_ids(),  '{}'::bigint[],     'member holds no manage rights');
select tests.logout();

select tests.login_as_guest();
select is(public.my_member_team_ids(),  '{}'::bigint[],     'a guest belongs to no team');

select tests.logout();
select * from finish();
rollback;
