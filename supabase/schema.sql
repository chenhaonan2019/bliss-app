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
  select case split_part(p, '/', 1)
    when 'mgr'   then 3          -- wages, evaluations, scheduling priorities
    when 'owner' then 4          -- fixed costs, sales, profit inputs
    else 2 end
$$;

-- Minimum level to WRITE a path.
create or replace function public.write_level(p text) returns int
language sql stable as $$
  select case
    when split_part(p, '/', 1) = 'owner' then 4
    when split_part(p, '/', 1) in ('mgr','config','employees','links','shifts','training') then 3
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

-- Called after every sign-in. Links the signed-in email to any employee record
-- with the same email, then returns every business this person belongs to.
create or replace function public.claim_membership()
returns table(org_id uuid, org_name text, role text)
language plpgsql security definer set search_path = public as $$
declare em text := lower(auth.jwt() ->> 'email'); r record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if em is not null and em <> '' then
    for r in select i.org_id from public.invites i where lower(i.email) = em loop
      insert into public.members(org_id, user_id, role, email) values (r.org_id, auth.uid(), 'owner', em)
        on conflict (org_id, user_id) do update set role = 'owner';
      delete from public.invites i where i.org_id = r.org_id and lower(i.email) = em;
    end loop;
    for r in
      select d.org_id, d.doc_id, d.data from public.docs d
       where d.coll = 'employees' and lower(d.data ->> 'email') = em
         and coalesce((d.data ->> 'active')::boolean, true)
    loop
      insert into public.members(org_id, user_id, role, email)
        values (r.org_id, auth.uid(),
                case when r.data ->> 'role' = 'Manager' then 'manager' else 'staff' end, em)
        on conflict (org_id, user_id) do nothing;
      insert into public.docs(org_id, path, coll, doc_id, data)
        values (r.org_id, 'links/' || auth.uid()::text, 'links', auth.uid()::text,
                jsonb_build_object('empId', r.doc_id, 'at', now()))
        on conflict (org_id, path) do nothing;
    end loop;
  end if;
  return query
    select m.org_id, o.name, m.role from public.members m join public.orgs o on o.id = m.org_id
     where m.user_id = auth.uid() order by m.created_at;
end $$;

-- Keep a person's sign-in level in step with the Role on their employee record.
create or replace function public.sync_member_roles() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.coll = 'employees' then
    update public.members m
       set role = case when new.data ->> 'role' = 'Manager' then 'manager' else 'staff' end
     where m.org_id = new.org_id and m.role <> 'owner'
       and m.user_id in (select (l.doc_id)::uuid from public.docs l
                          where l.org_id = new.org_id and l.coll = 'links' and l.data ->> 'empId' = new.doc_id
                            and l.doc_id ~ '^[0-9a-f-]{36}$');
    if coalesce((new.data ->> 'active')::boolean, true) = false then
      delete from public.members m
       where m.org_id = new.org_id and m.role <> 'owner'
         and m.user_id in (select (l.doc_id)::uuid from public.docs l
                            where l.org_id = new.org_id and l.coll = 'links' and l.data ->> 'empId' = new.doc_id
                              and l.doc_id ~ '^[0-9a-f-]{36}$');
    end if;
  end if;
  return new;
end $$;
drop trigger if exists docs_sync_roles on public.docs;
create trigger docs_sync_roles after insert or update on public.docs
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

-- When a team member is deleted, they lose sign-in access to this business right away.
create or replace function public.employee_removed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.coll = 'employees' then
    delete from public.members m
     where m.org_id = old.org_id and m.role <> 'owner'
       and m.user_id in (select (l.doc_id)::uuid from public.docs l
                          where l.org_id = old.org_id and l.coll = 'links' and l.data ->> 'empId' = old.doc_id
                            and l.doc_id ~ '^[0-9a-f-]{36}$');
    delete from public.docs l
     where l.org_id = old.org_id and l.coll = 'links' and l.data ->> 'empId' = old.doc_id;
  end if;
  return old;
end $$;
drop trigger if exists docs_employee_removed on public.docs;
create trigger docs_employee_removed after delete on public.docs
  for each row execute function public.employee_removed();

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
