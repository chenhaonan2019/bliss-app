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

grant execute on function public.doc_merge(uuid, text, jsonb) to authenticated;
grant execute on function public.create_org(text, jsonb) to authenticated;
grant execute on function public.claim_membership() to authenticated;
grant execute on function public.my_level(uuid) to authenticated;

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
