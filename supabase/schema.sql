-- BLISS Manager · database schema
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again: it creates what is missing and replaces functions/policies.

create extension if not exists pgcrypto;

-- ───────────────────────── tables ─────────────────────────
-- One row per business (BLISS today; other shops later).
create table if not exists public.orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null
);

-- Who can sign in to which business, and at what level.
-- owner = sees everything incl. profit; manager = runs a store; staff = everyday tasks.
create table if not exists public.members (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner','manager','staff')),
  email       text,
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

-- All app data, stored as JSON documents at paths like "shifts/abc" or "config/settings".
-- coll = the collection part of the path ("shifts", "mgr/evals/items", …).
create table if not exists public.docs (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  path        text not null,
  coll        text not null,
  doc_id      text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  primary key (org_id, path)
);
create index if not exists docs_coll_idx on public.docs(org_id, coll);

-- ───────────────────────── access levels ─────────────────────────
-- Levels: 0 none · 2 staff · 3 manager · 4 owner
create or replace function public.my_level(o uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case role when 'owner' then 4 when 'manager' then 3 else 2 end
    from public.members where org_id = o and user_id = auth.uid()
  ), 0)
$$;

-- Minimum level to READ a path.
create or replace function public.read_level(p text) returns int
language sql immutable as $$
  select case
    when p = 'mgr/wages'                then 4   -- pay rates: owners only
    when split_part(p, '/', 1) = 'mgr'   then 3   -- evaluations, scheduling priorities, PINs
    when split_part(p, '/', 1) = 'owner' then 4   -- fixed costs, sales, profit inputs
    else 2 end
$$;

-- Minimum level to WRITE a path.
create or replace function public.write_level(p text) returns int
language sql stable as $$
  select case
    when split_part(p, '/', 1) in ('owner','schedpub') or p = 'mgr/wages' then 4   -- schedpub: only owners publish schedules
    when split_part(p, '/', 1) in ('mgr','config','employees','links','shifts','training','cover') then 3
    when split_part(p, '/', 1) = 'trainreq'
      then case when split_part(p, '/', 2) = auth.uid()::text then 2 else 4 end
    else 2 end
$$;

-- ───────────────────────── row level security ─────────────────────────
alter table public.orgs    enable row level security;
alter table public.members enable row level security;
alter table public.docs    enable row level security;

drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select to authenticated
  using (public.my_level(id) > 0);

drop policy if exists orgs_owner_update on public.orgs;
create policy orgs_owner_update on public.orgs for update to authenticated
  using (public.my_level(id) >= 4) with check (public.my_level(id) >= 4);

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated
  using (user_id = auth.uid() or public.my_level(org_id) >= 3);

drop policy if exists members_owner_write on public.members;
create policy members_owner_write on public.members for update to authenticated
  using (public.my_level(org_id) >= 4) with check (public.my_level(org_id) >= 4);

drop policy if exists members_owner_delete on public.members;
create policy members_owner_delete on public.members for delete to authenticated
  using (public.my_level(org_id) >= 4 and user_id <> auth.uid());

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated
  using (public.my_level(org_id) >= public.read_level(path));

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (public.my_level(org_id) >= greatest(public.write_level(path), public.read_level(path)));

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (public.my_level(org_id) >= greatest(public.write_level(path), public.read_level(path)))
  with check (public.my_level(org_id) >= greatest(public.write_level(path), public.read_level(path)));

drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated
  using (public.my_level(org_id) >= greatest(public.write_level(path), public.read_level(path)));

-- keep updated_at / updated_by current
create or replace function public.docs_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.docs_touch();

-- ───────────────────────── helpers called by the app ─────────────────────────
-- Deep-merge two JSON objects (nested objects merge, everything else replaces).
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language sql immutable as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      coalesce((
        select jsonb_object_agg(k,
          case when a ? k and b ? k then public.jsonb_deep_merge(a -> k, b -> k)
               when b ? k then b -> k
               else a -> k end)
        from (select jsonb_object_keys(a) as k union select jsonb_object_keys(b)) keys
      ), '{}'::jsonb)
    else b end
$$;

-- Merge fields into an existing document (like Firestore update()).
create or replace function public.doc_merge(o uuid, p text, patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.docs set data = public.jsonb_deep_merge(data, patch)
   where org_id = o and path = p;
  if not found then
    raise exception 'document % not found or not allowed', p using errcode = 'P0002';
  end if;
end $$;

-- Create a new business; the caller becomes its owner.
create or replace function public.create_org(org_name text, locations jsonb default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.orgs(name, created_by) values (coalesce(nullif(trim(org_name), ''), 'My business'), auth.uid())
    returning id into o;
  insert into public.members(org_id, user_id, role, email)
    values (o, auth.uid(), 'owner', auth.jwt() ->> 'email');
  insert into public.docs(org_id, path, coll, doc_id, data) values
    (o, 'config/settings', 'config', 'settings', jsonb_build_object(
      'prep1','11:30','prep2','16:00','closeBy','22:00','photoGrace',30,'lateGrace',5,'otWeekly',40,
      'location', coalesce(nullif(trim(org_name), ''), 'My business'),
      'locations', coalesce(locations, '[{"id":"main","name":"Main store"}]'::jsonb)));
  return o;
end $$;

-- Bring one person's access to one business in line with the team list:
-- an active employee record with their email (or the record their account is linked to) decides
-- manager vs staff; with no active record they lose access. Owners are never changed here.
create or replace function public.refresh_member(o uuid, uid uuid, em text) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare is_mgr boolean; n int; emp text; cur text;
begin
  em := lower(coalesce(em, ''));
  select m.role into cur from public.members m where m.org_id = o and m.user_id = uid;
  if cur = 'owner' then return; end if;
  select count(*), bool_or(d.data ->> 'role' = 'Manager'),
         (array_agg(d.doc_id order by (d.data ->> 'role' = 'Manager') desc, d.updated_at desc))[1]
    into n, is_mgr, emp
    from public.docs d
   where d.org_id = o and d.coll = 'employees' and em <> '' and lower(d.data ->> 'email') = em
     and coalesce((d.data ->> 'active')::boolean, true);
  if n = 0 then   -- no email match: keep a hand-made link if it points to an active employee
    select e.doc_id, e.data ->> 'role' = 'Manager' into emp, is_mgr
      from public.docs l join public.docs e on e.org_id = l.org_id and e.coll = 'employees' and e.doc_id = l.data ->> 'empId'
     where l.org_id = o and l.path = 'links/' || uid::text and coalesce((e.data ->> 'active')::boolean, true);
  end if;
  if emp is null then
    delete from public.members m where m.org_id = o and m.user_id = uid and m.role <> 'owner';
    delete from public.docs l where l.org_id = o and l.path = 'links/' || uid::text;
    return;
  end if;
  insert into public.members(org_id, user_id, role, email)
    values (o, uid, case when is_mgr then 'manager' else 'staff' end, nullif(em, ''))
    on conflict (org_id, user_id) do update
      set role = excluded.role, email = coalesce(excluded.email, public.members.email)
      where public.members.role <> 'owner';
  insert into public.docs(org_id, path, coll, doc_id, data)
    values (o, 'links/' || uid::text, 'links', uid::text, jsonb_build_object('empId', emp, 'at', now()))
    on conflict (org_id, path) do update set data = excluded.data
      where public.docs.data ->> 'empId' is distinct from emp;
end $$;
revoke all on function public.refresh_member(uuid, uuid, text) from public, anon, authenticated;

-- Called after every sign-in. Links the signed-in email to employee records with the same email,
-- brings their role up to date, then returns every business this person belongs to.
create or replace function public.claim_membership()
returns table(org_id uuid, org_name text, role text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare em text := lower(auth.jwt() ->> 'email'); r record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if em is not null and em <> '' then
    for r in select i.org_id from public.invites i where lower(i.email) = em loop
      insert into public.members(org_id, user_id, role, email) values (r.org_id, auth.uid(), 'owner', em)
        on conflict (org_id, user_id) do update set role = 'owner';
      delete from public.invites i where i.org_id = r.org_id and lower(i.email) = em;
    end loop;
  end if;
  for r in
    select distinct d.org_id from public.docs d
     where d.coll = 'employees' and em <> '' and lower(d.data ->> 'email') = em
    union
    select m.org_id from public.members m where m.user_id = auth.uid()
  loop
    perform public.refresh_member(r.org_id, auth.uid(), em);
  end loop;
  return query
    select m.org_id, o.name, m.role from public.members m join public.orgs o on o.id = m.org_id
     where m.user_id = auth.uid() order by m.created_at;
end $$;

-- Keep everyone's access in step with the team list whenever an employee record is added,
-- changed (role, email, active) or deleted.
create or replace function public.sync_member_roles() returns trigger
language plpgsql security definer set search_path = public as $$
declare o uuid; did text; ems text[]; r record;
begin
  if tg_op = 'DELETE' then o := old.org_id; did := old.doc_id; if old.coll <> 'employees' then return old; end if;
  else o := new.org_id; did := new.doc_id; if new.coll <> 'employees' then return new; end if; end if;
  ems := array_remove(array[
    lower(case when tg_op <> 'INSERT' then old.data ->> 'email' end),
    lower(case when tg_op <> 'DELETE' then new.data ->> 'email' end)], null);
  for r in
    select m.user_id, m.email from public.members m
     where m.org_id = o and m.role <> 'owner'
       and (lower(m.email) = any (ems)
            or m.user_id::text in (select l.doc_id from public.docs l
                                    where l.org_id = o and l.coll = 'links' and l.data ->> 'empId' = did))
  loop
    perform public.refresh_member(o, r.user_id, r.email);
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists docs_sync_roles on public.docs;
create trigger docs_sync_roles after insert or update or delete on public.docs
  for each row execute function public.sync_member_roles();

-- ───────────────────────── owners ─────────────────────────
-- Owners invited by email before they have ever signed in wait here until their first sign-in.
create table if not exists public.invites (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('owner')),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  primary key (org_id, email)
);
alter table public.invites enable row level security;   -- only reached through the functions below

-- Owners of a business, plus invited owners who have not signed in yet.
create or replace function public.list_owners(o uuid)
returns table(email text, is_me boolean, pending boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if public.my_level(o) < 4 then raise exception 'only owners can see this'; end if;
  return query
    select coalesce(u.email, m.email)::text, m.user_id = auth.uid(), false
      from public.members m left join auth.users u on u.id = m.user_id
     where m.org_id = o and m.role = 'owner'
    union all
    select i.email, false, true from public.invites i where i.org_id = o
    order by 3, 1;
end $$;

-- Make someone an owner by email. Works whether or not they have signed in before.
create or replace function public.add_owner(o uuid, owner_email text) returns text
language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(owner_email)); uid uuid;
begin
  if public.my_level(o) < 4 then raise exception 'only owners can add owners'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'not a valid email'; end if;
  select id into uid from auth.users where lower(email) = em limit 1;
  if uid is not null then
    insert into public.members(org_id, user_id, role, email) values (o, uid, 'owner', em)
      on conflict (org_id, user_id) do update set role = 'owner';
    delete from public.invites where org_id = o and email = em;
    return 'added';
  end if;
  insert into public.invites(org_id, email, role) values (o, em, 'owner') on conflict do nothing;
  return 'invited';
end $$;

-- Remove an owner (or a pending invite). You cannot remove yourself, and one owner always stays.
create or replace function public.remove_owner(o uuid, owner_email text) returns void
language plpgsql security definer set search_path = public as $$
declare em text := lower(trim(owner_email)); uid uuid;
begin
  if public.my_level(o) < 4 then raise exception 'only owners can remove owners'; end if;
  delete from public.invites where org_id = o and email = em;
  select m.user_id into uid from public.members m left join auth.users u on u.id = m.user_id
   where m.org_id = o and m.role = 'owner' and lower(coalesce(u.email, m.email)) = em limit 1;
  if uid is null then return; end if;
  if uid = auth.uid() then raise exception 'you cannot remove yourself'; end if;
  if (select count(*) from public.members where org_id = o and role = 'owner') <= 1 then
    raise exception 'a business needs at least one owner';
  end if;
  delete from public.members where org_id = o and user_id = uid;
end $$;

-- Mark team members' sign-in accounts as confirmed, so they get the normal sign-in code email
-- (not a "confirm your email" email). Only the "team" Edge Function can call this.
create or replace function public.confirm_team_emails(emails text[]) returns int
language sql security definer set search_path = public, auth as $$
  with u as (
    update auth.users set email_confirmed_at = now()
     where lower(email) = any (select lower(e) from unnest(emails) e) and email_confirmed_at is null
    returning 1)
  select count(*)::int from u
$$;
revoke all on function public.confirm_team_emails(text[]) from public, anon, authenticated;
grant execute on function public.confirm_team_emails(text[]) to service_role;

-- Rename the business (owners only). Keeps the name shown in the app header in step.
create or replace function public.rename_org(o uuid, new_name text) returns void
language plpgsql security definer set search_path = public as $$
declare n text := nullif(trim(new_name), '');
begin
  if public.my_level(o) < 4 then raise exception 'only owners can rename the business'; end if;
  if n is null then raise exception 'name is required'; end if;
  update public.orgs set name = left(n, 80) where id = o;
  update public.docs set data = jsonb_set(data, '{location}', to_jsonb(left(n, 80)))
   where org_id = o and path = 'config/settings';
end $$;

grant execute on function public.rename_org(uuid, text) to authenticated;
grant execute on function public.list_owners(uuid) to authenticated;
grant execute on function public.add_owner(uuid, text) to authenticated;
grant execute on function public.remove_owner(uuid, text) to authenticated;

grant execute on function public.doc_merge(uuid, text, jsonb) to authenticated;
grant execute on function public.create_org(text, jsonb) to authenticated;
grant execute on function public.claim_membership() to authenticated;
grant execute on function public.my_level(uuid) to authenticated;

-- Only owners can make someone a Manager or change a Manager's role.
-- (Changes made in the SQL Editor, with no signed-in user, are allowed.)
create or replace function public.guard_manager_role() returns trigger
language plpgsql security definer set search_path = public as $$
declare was text; now_role text;
begin
  if tg_op = 'DELETE' then
    if old.coll = 'employees' and auth.uid() is not null and public.my_level(old.org_id) < 4
       and old.data ->> 'role' = 'Manager' then
      raise exception 'Only an owner can remove a Manager' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.coll <> 'employees' or auth.uid() is null or public.my_level(new.org_id) >= 4 then return new; end if;
  now_role := new.data ->> 'role';
  was := case when tg_op = 'UPDATE' then old.data ->> 'role' else null end;
  if (now_role = 'Manager' and coalesce(was, '') <> 'Manager')
     or (was = 'Manager' and coalesce(now_role, '') <> 'Manager') then
    raise exception 'Only an owner can add or change a Manager' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists docs_guard_manager on public.docs;
create trigger docs_guard_manager before insert or update or delete on public.docs
  for each row execute function public.guard_manager_role();

-- (Removing access when a team member is deleted is handled by sync_member_roles.)
drop trigger if exists docs_employee_removed on public.docs;

-- ───────────────────────── shift cover ─────────────────────────
-- cover/<id> documents: someone can't make a shift (or wants to swap). Staff create and answer them
-- only through these functions, so they can't change the schedule directly.
create or replace function public.my_emp(o uuid) returns text
language sql stable security definer set search_path = public as $$
  select data ->> 'empId' from public.docs where org_id = o and path = 'links/' || auth.uid()::text
$$;
grant execute on function public.my_emp(uuid) to authenticated;

create or replace function public.emp_loc(o uuid, emp text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select data ->> 'loc' from public.docs where org_id = o and path = 'employees/' || emp),
    (select data -> 'locations' -> 0 ->> 'id' from public.docs where org_id = o and path = 'config/settings'))
$$;
revoke all on function public.emp_loc(uuid, text) from public, anon, authenticated;

create or replace function public.cover_log(d jsonb, ev text) returns jsonb
language sql immutable as $$
  select jsonb_set(d, '{log}', coalesce(d -> 'log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'ev', ev)))
$$;

-- Ask for cover on a shift (your own; managers can do it for anyone). Returns the cover id.
create or replace function public.cover_request(o uuid, shift_id text, reason text default '', kind text default 'cover',
  swap_to text default null, starts_at timestamptz default null, elig jsonb default '[]'::jsonb, by_name text default '',
  backup text default null)
returns text
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare lvl int := public.my_level(o); sh jsonb; me text := public.my_emp(o); cid text; cfg jsonb; uh numeric; ex text;
begin
  if lvl < 2 then raise exception 'not allowed' using errcode = '42501'; end if;
  select data into sh from public.docs where org_id = o and path = 'shifts/' || shift_id;
  if sh is null then raise exception 'That shift no longer exists'; end if;
  if lvl < 3 and (me is null or sh ->> 'empId' is distinct from me) then
    raise exception 'You can only ask for cover on your own shift' using errcode = '42501'; end if;
  if kind not in ('cover', 'swap') then kind := 'cover'; end if;
  if kind = 'swap' and (swap_to is null or swap_to = sh ->> 'empId') then raise exception 'Choose who to swap with'; end if;
  select doc_id into ex from public.docs where org_id = o and coll = 'cover' and data ->> 'shiftId' = shift_id and data ->> 'status' = 'open' limit 1;
  if ex is not null then return ex; end if;
  select data into cfg from public.docs where org_id = o and path = 'mgr/cover';
  uh := coalesce((cfg ->> 'urgentHours')::numeric, 4);
  cid := 'c' || to_char(now(), 'YYMMDD') || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  if kind = 'swap' then elig := jsonb_build_array(swap_to); end if;
  insert into public.docs(org_id, path, coll, doc_id, data) values (o, 'cover/' || cid, 'cover', cid,
    public.cover_log(jsonb_build_object(
      'shiftId', shift_id, 'empId', sh ->> 'empId', 'loc', coalesce(sh ->> 'loc', public.emp_loc(o, sh ->> 'empId')),
      'date', sh ->> 'date', 'start', sh ->> 'start', 'end', sh ->> 'end',
      'startsAt', coalesce(starts_at, ((sh ->> 'date') || ' ' || (sh ->> 'start'))::timestamp at time zone 'America/New_York'),
      'reason', left(coalesce(reason, ''), 300), 'kind', kind, 'swapTo', swap_to, 'backup', case when kind = 'swap' then null else backup end,
      'elig', coalesce(elig, '[]'::jsonb), 'volunteers', '{}'::jsonb, 'status', 'open', 'stage', 0, 'urgentHours', uh,
      'createdAt', now(), 'createdBy', auth.uid(), 'createdByName', left(coalesce(by_name, ''), 80), 'byMgr', lvl >= 3 and (me is null or sh ->> 'empId' <> me)),
    case when kind = 'swap' then 'Swap requested' when lvl >= 3 and (me is null or sh ->> 'empId' <> me) then 'Marked as can''t come by ' || coalesce(nullif(by_name, ''), 'a manager')
         else 'Asked for cover' end));
  return cid;
end $$;
grant execute on function public.cover_request(uuid, text, text, text, text, timestamptz, jsonb, text, text) to authenticated;

-- Put someone on the shift and close the request.
create or replace function public.cover_fill(o uuid, cid text, emp text, how text) returns void
language plpgsql security definer set search_path = public as $$
declare d jsonb; nm text;
begin
  select data into d from public.docs where org_id = o and path = 'cover/' || cid;
  select data ->> 'name' into nm from public.docs where org_id = o and path = 'employees/' || emp;
  update public.docs set data = data || jsonb_build_object('empId', emp, 'loc', coalesce(public.emp_loc(o, emp), data ->> 'loc'),
      'coveredFrom', d ->> 'empId', 'coverId', cid)
   where org_id = o and path = 'shifts/' || (d ->> 'shiftId');
  update public.docs set data = public.cover_log(data || jsonb_build_object('status', 'filled', 'assigned', emp, 'filledAt', now(), 'filledHow', how),
      coalesce(nm, 'Someone') || ' took the shift (' || how || ')')
   where org_id = o and path = 'cover/' || cid;
end $$;
revoke all on function public.cover_fill(uuid, text, text, text) from public, anon, authenticated;

-- "I can take it": urgent → first eligible person gets it; otherwise it's an offer the manager picks from.
create or replace function public.cover_take(o uuid, cid text, emp text, via text) returns text
language plpgsql security definer set search_path = public as $$
declare d jsonb; e jsonb; urgent boolean;
begin
  select data into d from public.docs where org_id = o and path = 'cover/' || cid for update;
  if d is null or d ->> 'status' <> 'open' then return 'closed'; end if;
  if emp is null or emp = d ->> 'empId' then return 'not_allowed'; end if;
  select data into e from public.docs where org_id = o and path = 'employees/' || emp;
  if e is null or not coalesce((e ->> 'active')::boolean, true) then return 'not_allowed'; end if;
  if d ->> 'kind' = 'swap' and emp is distinct from d ->> 'swapTo' then return 'not_allowed'; end if;
  if coalesce(public.emp_loc(o, emp), '') <> coalesce(d ->> 'loc', '') then return 'not_allowed'; end if;
  urgent := now() >= (d ->> 'startsAt')::timestamptz - make_interval(secs => coalesce((d ->> 'urgentHours')::numeric, 4) * 3600);
  if d ->> 'kind' <> 'swap' and urgent and coalesce(d -> 'elig', '[]'::jsonb) ? emp then
    update public.docs set data = jsonb_set(data, array['volunteers', emp], jsonb_build_object('at', now(), 'via', via))
     where org_id = o and path = 'cover/' || cid;
    perform public.cover_fill(o, cid, emp, 'first to accept, via ' || via);
    return 'assigned';
  end if;
  update public.docs set data = public.cover_log(jsonb_set(data, array['volunteers', emp], jsonb_build_object('at', now(), 'via', via)),
      coalesce(e ->> 'name', 'Someone') || case when d ->> 'kind' = 'swap' then ' agreed to swap' else ' offered to cover' end || ' (' || via || ')')
   where org_id = o and path = 'cover/' || cid;
  return 'volunteered';
end $$;
revoke all on function public.cover_take(uuid, text, text, text) from public, anon, authenticated;

create or replace function public.cover_respond(o uuid, cid text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if public.my_level(o) < 2 then raise exception 'not allowed' using errcode = '42501'; end if;
  return public.cover_take(o, cid, public.my_emp(o), 'app');
end $$;
grant execute on function public.cover_respond(uuid, text) to authenticated;

-- Shared store phone (signed in as a manager): answer for the staff member who tapped their name.
create or replace function public.cover_respond_for(o uuid, cid text, emp text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if public.my_level(o) < 3 then raise exception 'not allowed' using errcode = '42501'; end if;
  return public.cover_take(o, cid, emp, 'store phone');
end $$;
grant execute on function public.cover_respond_for(uuid, text, text) to authenticated;

-- Used by the "cover" Edge Function for text-message and phone-call answers.
create or replace function public.cover_respond_as(o uuid, cid text, emp text, via text) returns text
language sql security definer set search_path = public as $$ select public.cover_take(o, cid, emp, via) $$;
revoke all on function public.cover_respond_as(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.cover_respond_as(uuid, text, text, text) to service_role;

create or replace function public.cover_withdraw(o uuid, cid text) returns void
language plpgsql security definer set search_path = public as $$
declare me text := public.my_emp(o);
begin
  update public.docs set data = public.cover_log(data #- array['volunteers', me], 'An offer was withdrawn')
   where org_id = o and path = 'cover/' || cid and data ->> 'status' = 'open' and data -> 'volunteers' ? me;
end $$;
grant execute on function public.cover_withdraw(uuid, text) to authenticated;

-- Managers: give the shift to someone (usually one of the people who offered).
create or replace function public.cover_assign(o uuid, cid text, emp text, by_name text default '') returns text
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if public.my_level(o) < 3 then raise exception 'Only a manager can assign the shift' using errcode = '42501'; end if;
  select data into d from public.docs where org_id = o and path = 'cover/' || cid for update;
  if d is null or d ->> 'status' <> 'open' then return 'closed'; end if;
  if emp = d ->> 'empId' then raise exception 'That is the person who can''t come'; end if;
  perform public.cover_fill(o, cid, emp, case when d ->> 'kind' = 'swap' then 'swap approved by ' else 'picked by ' end || coalesce(nullif(by_name, ''), 'a manager'));
  return 'assigned';
end $$;
grant execute on function public.cover_assign(uuid, text, text, text) to authenticated;

-- The person who asked, or a manager, can call it off (e.g. they can come after all).
create or replace function public.cover_cancel(o uuid, cid text, by_name text default '') returns void
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  select data into d from public.docs where org_id = o and path = 'cover/' || cid;
  if d is null then return; end if;
  if public.my_level(o) < 3 and d ->> 'empId' is distinct from public.my_emp(o) then
    raise exception 'not allowed' using errcode = '42501'; end if;
  update public.docs set data = public.cover_log(data || jsonb_build_object('status', 'cancelled', 'cancelledAt', now()),
      'Called off by ' || coalesce(nullif(by_name, ''), 'someone'))
   where org_id = o and path = 'cover/' || cid and data ->> 'status' = 'open';
end $$;
grant execute on function public.cover_cancel(uuid, text, text) to authenticated;

-- Phone push notifications: each phone/browser that turned them on.
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  sub        jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subs(user_id);
alter table public.push_subs enable row level security;
drop policy if exists push_own on public.push_subs;
create policy push_own on public.push_subs for select to authenticated using (user_id = auth.uid());

create or replace function public.push_save(sub jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(sub ->> 'endpoint', '') !~ '^https://' then raise exception 'bad subscription'; end if;
  insert into public.push_subs(endpoint, user_id, sub) values (sub ->> 'endpoint', auth.uid(), sub)
    on conflict (endpoint) do update set user_id = excluded.user_id, sub = excluded.sub;
end $$;
grant execute on function public.push_save(jsonb) to authenticated;

create or replace function public.push_remove(ep text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subs where endpoint = ep and user_id = auth.uid()
$$;
grant execute on function public.push_remove(text) to authenticated;

-- Keys only the server can see (the phone-push signing key). No one signed in can read this table.
create table if not exists public.app_secrets (k text primary key, v text not null);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- ───────────────────────── realtime ─────────────────────────
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- ───────────────────────── photo storage ─────────────────────────
-- Photos are stored under "<org id>/<random id>.jpg". Only members of that business can upload;
-- files are served from long random names.
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
  on conflict (id) do nothing;

drop policy if exists photos_upload on storage.objects;
create policy photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'photos'
              and public.my_level(((storage.foldername(name))[1])::uuid) >= 2);

drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos'
         and public.my_level(((storage.foldername(name))[1])::uuid) >= 3);

-- ───────────────────────── Menusifu hourly sales sync ─────────────────────────
-- The GitHub Action in .github/workflows/menusifu-sync.yml calls these functions with a shared secret
-- (stored here as app_secrets k='menusifu_sync'). It never gets the service key, and it can only write:
--   owner/hourly_<store>   hourly sales, tips, tax, receivable (owners only can read)
--   mgr/fcneeds_<store>    people needed per hour for the next weeks, no money (managers use it to schedule)
--   mgr/hourly_sync        last run status
-- If you run more than one business in this project, also store the business id as app_secrets k='menusifu_org'.
create or replace function public.bliss_menusifu_org(p_secret text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare s text;
begin
  select v into s from app_secrets where k = 'menusifu_sync';
  if s is null or length(s) < 20 or p_secret is distinct from s then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((select v::uuid from app_secrets where k = 'menusifu_org'),
                  (select id from orgs order by created_at limit 1));
end $$;

create or replace function public.bliss_menusifu_put(p_secret text, p_loc text, p_days jsonb, p_status jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o uuid := public.bliss_menusifu_org(p_secret); cur jsonb;
begin
  if p_loc is not null then
    if p_loc !~ '^[a-z0-9_-]{1,20}$' or p_loc = 'sync' or jsonb_typeof(p_days) is distinct from 'object' then
      raise exception 'bad input' using errcode = '22023';
    end if;
    -- sales are owner-only; an older copy under mgr/ is moved here and removed
    select data into cur from docs where org_id = o and path = 'owner/hourly_' || p_loc;
    if cur is null then select data into cur from docs where org_id = o and path = 'mgr/hourly_' || p_loc; end if;
    insert into docs (org_id, path, coll, doc_id, data)
      values (o, 'owner/hourly_' || p_loc, 'owner', 'hourly_' || p_loc,
              jsonb_build_object('days', coalesce(cur -> 'days', '{}'::jsonb) || p_days, 'updatedAt', now()))
      on conflict (org_id, path) do update set data = excluded.data;
    delete from docs where org_id = o and path = 'mgr/hourly_' || p_loc;
  end if;
  if p_status is not null then
    insert into docs (org_id, path, coll, doc_id, data) values (o, 'mgr/hourly_sync', 'mgr', 'hourly_sync', p_status)
      on conflict (org_id, path) do update set data = excluded.data;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- staffing needs for managers (people per hour, weather label; no sales figures)
create or replace function public.bliss_menusifu_needs(p_secret text, p_loc text, p_dates jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o uuid := public.bliss_menusifu_org(p_secret);
begin
  if p_loc !~ '^[a-z0-9_-]{1,20}$' or jsonb_typeof(p_dates) is distinct from 'object' then
    raise exception 'bad input' using errcode = '22023';
  end if;
  insert into docs (org_id, path, coll, doc_id, data)
    values (o, 'mgr/fcneeds_' || p_loc, 'mgr', 'fcneeds_' || p_loc, jsonb_build_object('dates', p_dates, 'at', now()))
    on conflict (org_id, path) do update set data = excluded.data;
  return jsonb_build_object('ok', true);
end $$;

-- latest saved date per store, plus the settings the forecast needs
create or replace function public.bliss_menusifu_last(p_secret text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o uuid := public.bliss_menusifu_org(p_secret);
begin
  return jsonb_build_object(
    'last', coalesce((select jsonb_object_agg(substr(doc_id, 8), (select max(k) from jsonb_object_keys(data -> 'days') k))
                      from docs where org_id = o and doc_id like 'hourly\_%' and doc_id <> 'hourly_sync'
                        and coll in ('owner', 'mgr')), '{}'::jsonb),
    'staffing', (select data -> 'staffing' from docs where org_id = o and path = 'config/settings'),
    'forecast', (select data -> 'forecast' from docs where org_id = o and path = 'mgr/sched'));
end $$;

-- owner-only: hourly sales for the forecast (used by the Menusifu sync to compute managers' staffing needs)
create or replace function public.bliss_menusifu_hourly(p_secret text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o uuid := public.bliss_menusifu_org(p_secret);
begin
  return coalesce((select jsonb_object_agg(substr(doc_id, 8), data -> 'days') from docs
                   where org_id = o and coll = 'owner' and doc_id like 'hourly\_%'), '{}'::jsonb);
end $$;

revoke all on function public.bliss_menusifu_org(text) from public, anon, authenticated;
revoke all on function public.bliss_menusifu_put(text, text, jsonb, jsonb) from public;
revoke all on function public.bliss_menusifu_needs(text, text, jsonb) from public;
revoke all on function public.bliss_menusifu_last(text) from public;
revoke all on function public.bliss_menusifu_hourly(text) from public;
grant execute on function public.bliss_menusifu_put(text, text, jsonb, jsonb) to anon;
grant execute on function public.bliss_menusifu_needs(text, text, jsonb) to anon;
grant execute on function public.bliss_menusifu_last(text) to anon;
grant execute on function public.bliss_menusifu_hourly(text) to anon;
