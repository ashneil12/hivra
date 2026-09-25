-- Close every remaining write path for the API roles (anon, authenticated and
-- PUBLIC) on public tables, keeping their existing read paths.
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
-- The dashboard writes every public table with the service-role key, which
-- bypasses RLS. So this migration:
-- - drops every PERMISSIVE write-capable policy (ALL/INSERT/UPDATE/DELETE) for
--   the API roles. RESTRICTIVE policies only narrow access and stay, as do
--   FOR SELECT and deny-only (USING/WITH CHECK false) policies;
-- - re-creates each dropped FOR ALL policy as a FOR SELECT policy with the same
--   roles and USING expression, so reads that relied on it (for example user-JWT
--   Realtime subscriptions on hermes_messages) behave exactly as before;
-- - revokes the API roles' write privileges (table and column level) on every
--   public table, view and foreign table, and from the postgres role's default
--   privileges so a new table fails closed;
-- - fails, rather than being recorded as applied, if a write path is left or
--   if the service role lost a write it held before.
--
-- Apply it as one transaction (the SQL editor, or psql -1 -v ON_ERROR_STOP=1)
-- so a failed assertion rolls everything back. Each dropped policy definition
-- is printed as a NOTICE for the record.
--
-- Class: replace grants/policies. Backward compatible for deployed code: the
-- service role keeps all of its privileges and every read path is unchanged.

set local lock_timeout = '5s';

do $$
declare
  p record;
  t record;
  col record;
  role_list text;
  read_policy text;
  svc_writable oid[];
  leftover text;
begin
  -- What the service role can write before any change, to prove it keeps it.
  select coalesce(array_agg(c.oid), '{}')
    into svc_writable
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p', 'v', 'f')
     and has_table_privilege('service_role', c.oid, 'INSERT')
     and has_table_privilege('service_role', c.oid, 'UPDATE')
     and has_table_privilege('service_role', c.oid, 'DELETE');

  for p in
    select tablename, policyname, cmd, roles, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and permissive = 'PERMISSIVE'
       and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
       and roles && array['public', 'anon', 'authenticated']::name[]
       -- Deny-only policies grant nothing.
       and not (coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false')
  loop
    raise notice 'dropping policy % on public.% (% to %) using (%) with check (%)',
      p.policyname, p.tablename, p.cmd, p.roles, p.qual, p.with_check;
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);

    -- A FOR ALL policy also granted reads. Keep those as a read-only policy.
    if p.cmd = 'ALL' and p.qual is not null then
      select string_agg(quote_ident(r), ', ') into role_list from unnest(p.roles) as r;
      read_policy := left(p.policyname, 55) || ' (read)';
      execute format('drop policy if exists %I on public.%I', read_policy, p.tablename);
      execute format(
        'create policy %I on public.%I as permissive for select to %s using (%s)',
        read_policy, p.tablename, role_list, p.qual
      );
    end if;
  end loop;

  for t in
    select c.oid, c.relname, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'f')
  loop
    if t.relkind in ('r', 'p') then
      execute format(
        'revoke insert, update, delete, truncate, references, trigger on table public.%I from public, anon, authenticated',
        t.relname
      );
      -- MAINTAIN exists from PostgreSQL 17 and is part of Supabase's default grant.
      if current_setting('server_version_num')::int >= 170000 then
        execute format('revoke maintain on table public.%I from public, anon, authenticated', t.relname);
      end if;
    else
      execute format('revoke insert, update, delete on table public.%I from public, anon, authenticated', t.relname);
    end if;

    -- Column-level grants survive a table-level REVOKE.
    for col in
      select a.attname
        from pg_attribute a
       where a.attrelid = t.oid
         and a.attnum > 0
         and not a.attisdropped
         and a.attacl is not null
    loop
      execute format(
        'revoke insert (%I), update (%I), references (%I) on table public.%I from public, anon, authenticated',
        col.attname, col.attname, col.attname, t.relname
      );
    end loop;
  end loop;

  -- Fail if a write path is left.
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into leftover
    from pg_policies
   where schemaname = 'public'
     and permissive = 'PERMISSIVE'
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
     and c.relkind in ('r', 'p', 'v', 'f')
     and (
       has_table_privilege(r.role_name, c.oid, 'INSERT, UPDATE, DELETE')
       or has_any_column_privilege(r.role_name, c.oid, 'INSERT, UPDATE')
     );
  if leftover is not null then
    raise exception 'API roles still hold write privileges on: %', leftover;
  end if;

  -- Fail if the service role lost a write it held before.
  select string_agg(c.relname, ', ')
    into leftover
    from pg_class c
   where c.oid = any (svc_writable)
     and not (
       has_table_privilege('service_role', c.oid, 'INSERT')
       and has_table_privilege('service_role', c.oid, 'UPDATE')
       and has_table_privilege('service_role', c.oid, 'DELETE')
     );
  if leftover is not null then
    raise exception 'service_role lost write privileges on: %', leftover;
  end if;
end
$$;

-- Tables the postgres role creates later start without write grants for the
-- API roles. FOR ROLE postgres applies whether this runs as postgres or as a
-- superuser; migrations create tables as postgres.
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from public, anon, authenticated;

do $$
declare
  leftover text;
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'alter default privileges for role postgres in schema public revoke maintain on tables from public, anon, authenticated';
  end if;

  select string_agg(format('%s:%s', a.grantee::regrole, a.privilege_type), ', ')
    into leftover
    from pg_default_acl d,
         aclexplode(d.defaclacl) a
   where d.defaclrole = 'postgres'::regrole
     and d.defaclnamespace = 'public'::regnamespace
     and d.defaclobjtype = 'r'
     and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
     and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if leftover is not null then
    raise exception 'postgres default privileges still grant writes on new public tables: %', leftover;
  end if;
end
$$;
