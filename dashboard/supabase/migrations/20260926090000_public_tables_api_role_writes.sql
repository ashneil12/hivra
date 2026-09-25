-- Close every remaining write path for the API roles (anon, authenticated and
-- PUBLIC) on public tables.
--
-- 20260925174500 closed hermes_instances. The same FOR ALL policies keyed on
-- the JWT sub, plus Supabase's default table grants, remain on hermes_hosts,
-- profiles, user_api_keys, hermes_conversations, hermes_messages,
-- _deprecated_hermes_scheduled_tasks_20260511, instances and
-- hermes_chat_stream_jobs (and prod carries more under other names). Any caller
-- holding a JWT with role=authenticated could write them directly through
-- PostgREST. hermes_hosts is the sharpest case: DELETE /api/hosts/[id] deletes
-- the Hetzner server named by hermes_hosts.hetzner_server_id, so a forged host
-- row pointing at another tenant's server is the same cross-tenant deletion
-- 20260925174500 closed for hermes_instances.
--
-- The dashboard reads and writes every public table with the service-role key,
-- which bypasses RLS; edge logs on Canary and prod show no anon-key or user-JWT
-- PostgREST traffic. So this migration drops every write-capable policy for the
-- API roles on public tables and revokes their write privileges. Read-only
-- (FOR SELECT) policies, deny-only policies (USING/WITH CHECK false) and
-- service_role privileges stay.
--
-- Class: replace grants/policies. Backward compatible for deployed code: the
-- service role keeps all of its privileges.

do $$
declare
  p record;
begin
  for p in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
       and roles && array['public', 'anon', 'authenticated']::name[]
       -- Keep deny-only policies: they grant nothing.
       and not (coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end
$$;

do $$
declare
  t record;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on table public.%I from public, anon, authenticated',
      t.relname
    );
    -- MAINTAIN exists from PostgreSQL 17 and is part of Supabase's default grant.
    if current_setting('server_version_num')::int >= 170000 then
      execute format('revoke maintain on table public.%I from public, anon, authenticated', t.relname);
    end if;
  end loop;
end
$$;

-- Tables created later by this role start without write grants for the API
-- roles, so a new table fails closed instead of inheriting them.
alter default privileges in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from public, anon, authenticated;

-- Fail the migration, rather than record it as applied, if a write path is left.
do $$
declare
  leftover text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into leftover
    from pg_policies
   where schemaname = 'public'
     and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
     and roles && array['public', 'anon', 'authenticated']::name[]
     and not (coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false');
  if leftover is not null then
    raise exception 'public tables still have write policies for the API roles: %', leftover;
  end if;

  select string_agg(format('%s:%s', c.relname, r.role_name), ', ')
    into leftover
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as r(role_name)
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and has_table_privilege(r.role_name, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE');
  if leftover is not null then
    raise exception 'API roles still hold write privileges on: %', leftover;
  end if;
end
$$;
