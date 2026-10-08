-- hermes_instances is written only by the dashboard server, with the
-- service-role key (which bypasses RLS). No application path reads or writes it
-- with the anon key or a user JWT.
--
-- The "users manage own instances" policy (FOR ALL TO authenticated, from
-- 20260420162000) plus Supabase's default table grants let any caller holding a
-- JWT with role=authenticated insert, update and delete its own rows, including
-- the columns that the lifecycle crons act on (status, hetzner_server_id,
-- proxmox_vmid, gateway_url, resource tier). This migration removes every write
-- path for the API roles. Dropping that FOR ALL policy also removes the
-- authenticated read path; nothing uses it, because every read goes through the
-- service role.
--
-- Class: replace grants/policies. Backward compatible: the service role keeps
-- all of its privileges, so no deployed code changes behaviour.

alter table public.hermes_instances enable row level security;

-- The committed write policies: 20260325000003 created "users see own
-- instances" FOR ALL; 20260330130000 and 20260420162000 replaced it with
-- "users manage own instances" FOR ALL (PUBLIC, then authenticated).
drop policy if exists "users see own instances" on public.hermes_instances;
drop policy if exists "users manage own instances" on public.hermes_instances;

-- Any other write-capable policy for the API roles that a database picked up
-- out of band. Read-only (FOR SELECT) policies and service_role policies stay.
do $$
declare
  p record;
begin
  for p in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = 'hermes_instances'
       and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
       and roles && array['public', 'anon', 'authenticated']::name[]
  loop
    execute format('drop policy %I on public.hermes_instances', p.policyname);
  end loop;
end
$$;

-- Table privileges. anon and PUBLIC get nothing (anon already lost everything
-- in 20260420162000). authenticated keeps SELECT, which returns no rows unless a
-- read policy allows them.
revoke all on table public.hermes_instances from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.hermes_instances from authenticated;

-- MAINTAIN exists from PostgreSQL 17 and is part of Supabase's default grant.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on table public.hermes_instances from public, anon, authenticated';
  end if;
end
$$;

-- Fail the migration, rather than record it as applied, if a write path is left.
do $$
declare
  role_name text;
  privilege text;
  leftover text;
begin
  select string_agg(policyname, ', ')
    into leftover
    from pg_policies
   where schemaname = 'public'
     and tablename = 'hermes_instances'
     and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
     and roles && array['public', 'anon', 'authenticated']::name[];
  if leftover is not null then
    raise exception 'hermes_instances still has write policies for the API roles: %', leftover;
  end if;

  foreach role_name in array array['anon', 'authenticated'] loop
    foreach privilege in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(role_name, 'public.hermes_instances', privilege) then
        raise exception 'role % still holds % on public.hermes_instances', role_name, privilege;
      end if;
    end loop;
  end loop;
end
$$;
