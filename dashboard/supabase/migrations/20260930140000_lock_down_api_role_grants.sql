-- Lock the API roles (anon, authenticated and PUBLIC) out of the public schema
-- by default, and close the hermes-attachments bucket to user JWTs.
--
-- Why
-- The dashboard reaches the database only as the service role, from the
-- server. Every script, cron and test helper in the repository builds its
-- client with the service-role key, and no application source reads the anon
-- key. Nothing needs the anon role to hold any privilege, and the authenticated
-- role needs only the table reads that a policy describes, so the rest is
-- exposure with no use:
--   * Canary's postgres default privileges grant anon and authenticated SELECT
--     on every new table, USAGE on every new sequence and EXECUTE on every new
--     function. The same defaults exposed the five functions that
--     20260923001301 closed, and a table or SECURITY DEFINER function shipped
--     without its own revoke is reachable through PostgREST until someone
--     notices.
--   * anon held SELECT on 32 Canary tables when this was written, and
--     authenticated on 70, 28 of them with no policy that lets it read a row.
--     Row level security denies every row today; one future `using (true)`
--     policy, or one table without RLS, would turn such a grant into a leak.
--   * PostgreSQL grants EXECUTE on every new function to PUBLIC. Revoking from
--     anon and authenticated by name leaves that grant, so anon and
--     authenticated keep EXECUTE through PUBLIC. Only a default privilege
--     change that is not limited to one schema removes it.
--   * Eight trigger functions are executable by PUBLIC, anon and authenticated.
--     PostgreSQL checks EXECUTE on a trigger function when the trigger is
--     created, not when it fires, so no role needs it.
--   * Four trigger functions have a mutable search_path (the Supabase
--     function_search_path_mutable lint).
--   * The hermes-attachments bucket carries two storage.objects policies for
--     role PUBLIC keyed on the JWT sub. Nothing in the repository reads or
--     writes the bucket with a user JWT: upload-migration, instance-service and
--     delete-user-account all use the service-role client, which bypasses RLS.
--     The policies only let a caller who holds any JWT with a sub claim store
--     files in the bucket, past the upload route's zip check, size check and
--     rate limit.
--
-- What it does
--   1. Drops every storage.objects policy for PUBLIC, anon or authenticated
--      that names the hermes-attachments bucket, and sets the bucket's limits
--      to what its one upload path already enforces: 52428800 bytes (50 MiB,
--      the route's own cap) and the application/zip content type (the route
--      always uploads with that type). Bucket limits apply to service-role
--      uploads too, so both values match the route exactly.
--   2. Pins search_path on the four trigger functions the lint names. A body
--      that matches the one the repository migrations create (it calls only
--      built-in functions) gets an empty search_path. Any other body keeps the
--      behaviour it has today, with search_path = public, pg_temp.
--   3. Removes every anon and PUBLIC privilege on the tables, views, sequences
--      and functions of schema public, and every authenticated privilege on
--      sequences, on functions and on the tables and views it has no use for.
--      authenticated keeps a table or view when a permissive SELECT or ALL
--      policy for PUBLIC or authenticated applies to it, or when another
--      table's policy or a view depends on it (hermes_instances, which the
--      hermes_messages policy reads, is one). That keeps the hermes_messages
--      Realtime path and every policy subquery working. Functions that a row
--      level security policy or a view calls (today only requesting_user_id())
--      and functions that belong to an extension are left as they are. The
--      service role keeps everything it could use before, including EXECUTE it
--      held only through PUBLIC.
--   4. Removes anon, authenticated and PUBLIC from the postgres role's default
--      privileges for new tables, sequences and functions, including the
--      default that is not limited to one schema. service_role keeps its
--      default grants, so new objects stay usable by the dashboard.
--   5. Fails, rather than being recorded as applied, if any of that did not
--      take effect or if the service role lost anything.
--
-- Not handled here. Default privileges that PostgreSQL keeps for objects
-- created by supabase_admin (a platform role) cannot be changed by postgres.
-- Nothing in this repository creates objects as that role.
--
-- A correction to two earlier comments. 20260625120000 and 20260922172439 call
-- NEXT_PUBLIC_SUPABASE_ANON_KEY "shipped to the browser". An import check found
-- no client component that reaches a client built with it, and the script
-- bundles the audit fetched from the two sites held no Supabase key.
-- Migrations are append-only, so the wording stays there; the anon-key client
-- export is removed from src/lib/supabase.ts in the same change.
--
-- Future migrations. A new table, sequence or function now starts with no grant
-- for anon, authenticated or PUBLIC, and service_role keeps its grants. A
-- function that a row level security policy calls, or that an authenticated
-- caller must run, needs an explicit `grant execute ... to authenticated`. A
-- SECURITY DEFINER function no longer needs `revoke ... from public, anon,
-- authenticated` to be closed to the API roles, but the revoke is harmless.
--
-- Apply it as one transaction (the SQL editor, or psql -1 -v ON_ERROR_STOP=1)
-- so a failed assertion rolls everything back. Each dropped policy definition
-- and each function left alone is printed as a NOTICE for the record.
--
-- Storage ownership. storage.objects and storage.buckets belong to
-- supabase_storage_admin. On hosted Supabase the postgres role may still drop
-- policies on storage.objects (supautils.policy_grants lists it) and update
-- storage.buckets, which is how the two policies were created. A database
-- where that is not so fails at step 1 and rolls everything back; drop the two
-- policies in the dashboard (Storage, Policies) and run the file again.
--
-- Class: replace grants and policies. Backward compatible for deployed code: it
-- uses the service role only, which keeps every privilege it has today.

set local lock_timeout = '5s';

-- 1. hermes-attachments: no policy for the API roles, and the bucket's limits.
do $$
declare
  p record;
  leftover text;
begin
  for p in
    select policyname, cmd, roles, qual, with_check
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and roles && array['public', 'anon', 'authenticated']::name[]
       and (
         coalesce(qual, '') like '%hermes-attachments%'
         or coalesce(with_check, '') like '%hermes-attachments%'
       )
  loop
    raise notice 'dropping policy % on storage.objects (% to %) using (%) with check (%)',
      p.policyname, p.cmd, p.roles, p.qual, p.with_check;
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;

  update storage.buckets
     set file_size_limit = 52428800,
         allowed_mime_types = array['application/zip']
   where id = 'hermes-attachments'
     and (
       file_size_limit is distinct from 52428800
       or allowed_mime_types is distinct from array['application/zip']
     );

  select string_agg(policyname, ', ')
    into leftover
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and roles && array['public', 'anon', 'authenticated']::name[]
     and (
       coalesce(qual, '') like '%hermes-attachments%'
       or coalesce(with_check, '') like '%hermes-attachments%'
     );
  if leftover is not null then
    raise exception 'storage.objects still has API-role policies for hermes-attachments: %', leftover;
  end if;

  select string_agg(id, ', ')
    into leftover
    from storage.buckets
   where id = 'hermes-attachments'
     and (
       file_size_limit is distinct from 52428800
       or allowed_mime_types is distinct from array['application/zip']
     );
  if leftover is not null then
    raise exception 'the hermes-attachments bucket limits were not applied';
  end if;
end
$$;

-- 2. search_path on the four trigger functions the lint names.
-- The hashes are md5(prosrc) of the bodies the repository migrations create.
-- Those bodies call only built-in functions, so an empty search_path cannot
-- change what they do. A database whose body differs (an edit made outside the
-- repository) cannot be shown to be safe that way, so it is pinned to the path
-- a caller normally has, which keeps whatever it calls resolving as before.
do $$
declare
  fn record;
  leftover text;
begin
  for fn in
    select p.oid, p.proname, md5(p.prosrc) = known.body_md5 as known_body
      from pg_proc p
      join (values
        ('hermes_instances_canonicalize_hetzner_gateway_url', '80a0ed8e7f606c5bb252e9c53507834c'),
        ('hermes_instances_track_first_active', 'fdfe1fc373f9434be85b20eb2aea9579'),
        ('set_current_timestamp_updated_at', '9b1889f56258bf9d6554213c05019c76'),
        ('touch_vm_response_seconds_daily_updated_at', '5bdc21b8fa8fb1231bdb021e09a5bc8e')
      ) as known(name, body_md5) on known.name = p.proname
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and p.prorettype = 'trigger'::regtype
       and p.pronargs = 0
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as setting
          where setting like 'search_path=%'
       )
  loop
    if fn.known_body then
      execute format('alter function %s set search_path = %L', fn.oid::regprocedure, '');
    else
      raise notice '% has a body that differs from the repository; pinning search_path = public, pg_temp', fn.proname;
      execute format('alter function %s set search_path = public, pg_temp', fn.oid::regprocedure);
    end if;
  end loop;

  select string_agg(p.proname, ', ')
    into leftover
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prokind = 'f'
     and p.prorettype = 'trigger'::regtype
     and p.pronargs = 0
     and p.proname in (
       'hermes_instances_canonicalize_hetzner_gateway_url',
       'hermes_instances_track_first_active',
       'set_current_timestamp_updated_at',
       'touch_vm_response_seconds_daily_updated_at'
     )
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as setting
        where setting like 'search_path=%'
     );
  if leftover is not null then
    raise exception 'search_path is still mutable on: %', leftover;
  end if;
end
$$;

-- 3. Existing privileges.
do $$
declare
  anon_role constant oid := 'anon'::regrole;
  authenticated_role constant oid := 'authenticated'::regrole;
  kept oid[];
  readable oid[];
  service_readable oid[];
  service_writable oid[];
  t record;
  s record;
  col record;
  f record;
  k record;
  leftover text;
begin
  -- Functions the API roles may still need: anything a policy or a view calls.
  select coalesce(array_agg(distinct p.oid), '{}'::oid[])
    into kept
    from pg_depend d
    join pg_proc p on d.refclassid = 'pg_proc'::regclass and d.refobjid = p.oid
   where d.classid in ('pg_policy'::regclass, 'pg_rewrite'::regclass)
     and p.pronamespace = 'public'::regnamespace;

  for k in
    select p.oid::regprocedure::text as signature, p.prosecdef
      from pg_proc p
     where p.oid = any (kept)
     order by 1
  loop
    raise notice 'leaving EXECUTE on % as it is (used by a policy or a view; security definer: %)',
      k.signature, k.prosecdef;
  end loop;

  -- Tables and views authenticated may keep reading: one that a permissive
  -- SELECT or ALL policy for PUBLIC or authenticated applies to, and one that
  -- another table's policy or a view depends on (a policy subquery, or a view
  -- that authenticated reads). Every policy depends on its own table, so a
  -- table's own policies do not count as a dependency.
  select coalesce(array_agg(c.oid), '{}'::oid[])
    into readable
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and (
       exists (
         select 1
           from pg_policy pol
          where pol.polrelid = c.oid
            and pol.polpermissive
            and pol.polcmd in ('r', '*')
            and (0 = any (pol.polroles) or authenticated_role = any (pol.polroles))
       )
       or exists (
         select 1
           from pg_depend d
           join pg_policy pol on d.classid = 'pg_policy'::regclass and d.objid = pol.oid
          where d.refclassid = 'pg_class'::regclass
            and d.refobjid = c.oid
            and pol.polrelid <> c.oid
       )
       or exists (
         select 1
           from pg_depend d
           join pg_rewrite r on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid
          where d.refclassid = 'pg_class'::regclass
            and d.refobjid = c.oid
            and r.ev_class <> c.oid
       )
     );

  -- What the service role can use before any change, to prove it keeps it.
  select coalesce(array_agg(c.oid), '{}'::oid[])
    into service_readable
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege('service_role', c.oid, 'SELECT');
  select coalesce(array_agg(c.oid), '{}'::oid[])
    into service_writable
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'f')
     and has_table_privilege('service_role', c.oid, 'INSERT')
     and has_table_privilege('service_role', c.oid, 'UPDATE')
     and has_table_privilege('service_role', c.oid, 'DELETE');

  -- Tables, views, materialized views and foreign tables: nothing for anon or
  -- PUBLIC, and nothing for authenticated unless it reads the table through a
  -- policy or something depends on it. Column-level grants survive a
  -- table-level REVOKE, so they go too.
  for t in
    select c.oid, c.relname, c.oid = any (readable) as authenticated_reads
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke all on table public.%I from public, anon', t.relname);
    if not t.authenticated_reads then
      execute format('revoke all on table public.%I from authenticated', t.relname);
    end if;
    for col in
      select a.attname
        from pg_attribute a
       where a.attrelid = t.oid
         and a.attnum > 0
         and not a.attisdropped
         and a.attacl is not null
    loop
      execute format('revoke all (%I) on table public.%I from public, anon', col.attname, t.relname);
      if not t.authenticated_reads then
        execute format('revoke all (%I) on table public.%I from authenticated', col.attname, t.relname);
      end if;
    end loop;
  end loop;

  -- Sequences: nothing for the API roles. They write no table, so they draw no
  -- sequence value.
  for s in
    select c.relname
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'S'
  loop
    execute format('revoke all on sequence public.%I from public, anon, authenticated', s.relname);
  end loop;

  -- Functions, procedures and aggregates.
  for f in
    select p.oid, has_function_privilege('service_role', p.oid, 'execute') as service_had
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.oid <> all (kept)
       and not exists (
         select 1 from pg_depend e
          where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e'
       )
  loop
    execute format('revoke all on routine %s from public, anon, authenticated', f.oid::regprocedure);
    -- The service role may have held EXECUTE only through PUBLIC.
    if f.service_had and not has_function_privilege('service_role', f.oid, 'execute') then
      execute format('grant execute on routine %s to service_role', f.oid::regprocedure);
    end if;
  end loop;

  -- Fail if anon or PUBLIC still holds anything on a table.
  select string_agg(c.relname, ', ' order by c.relname)
    into leftover
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and (
       exists (
         select 1
           from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
          where a.grantee in (0, anon_role)
       )
       or exists (
         select 1
           from pg_attribute at,
                aclexplode(at.attacl) a
          where at.attrelid = c.oid
            and at.attnum > 0
            and not at.attisdropped
            and at.attacl is not null
            and a.grantee in (0, anon_role)
       )
     );
  if leftover is not null then
    raise exception 'anon or PUBLIC still holds table privileges on: %', leftover;
  end if;

  -- Fail if authenticated still holds anything on a table it has no use for.
  select string_agg(c.relname, ', ' order by c.relname)
    into leftover
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and c.oid <> all (readable)
     and (
       exists (
         select 1
           from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
          where a.grantee = authenticated_role
       )
       or exists (
         select 1
           from pg_attribute at,
                aclexplode(at.attacl) a
          where at.attrelid = c.oid
            and at.attnum > 0
            and not at.attisdropped
            and at.attacl is not null
            and a.grantee = authenticated_role
       )
     );
  if leftover is not null then
    raise exception 'authenticated still holds table privileges on tables no policy lets it read: %', leftover;
  end if;

  -- Fail if the API roles still hold anything on a sequence.
  select string_agg(c.relname, ', ' order by c.relname)
    into leftover
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'S'
     and exists (
       select 1
         from aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
        where a.grantee in (0, anon_role, authenticated_role)
     );
  if leftover is not null then
    raise exception 'the API roles still hold sequence privileges on: %', leftover;
  end if;

  -- Fail if a function outside the kept set is still callable by the API roles.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into leftover
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.oid <> all (kept)
     and not exists (
       select 1 from pg_depend e
        where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e'
     )
     and (
       has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute')
       or exists (
         select 1
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
     );
  if leftover is not null then
    raise exception 'the API roles can still execute: %', leftover;
  end if;

  -- Fail if the service role lost something it could use before.
  select string_agg(c.relname, ', ' order by c.relname)
    into leftover
    from pg_class c
   where (c.oid = any (service_readable) and not has_table_privilege('service_role', c.oid, 'SELECT'))
      or (
        c.oid = any (service_writable)
        and not (
          has_table_privilege('service_role', c.oid, 'INSERT')
          and has_table_privilege('service_role', c.oid, 'UPDATE')
          and has_table_privilege('service_role', c.oid, 'DELETE')
        )
      );
  if leftover is not null then
    raise exception 'service_role lost table privileges on: %', leftover;
  end if;
end
$$;

-- 4. Privileges of objects the postgres role creates later. FOR ROLE postgres
-- applies whether this runs as postgres or as a superuser; migrations create
-- objects as postgres.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

-- PostgreSQL's built-in default grants EXECUTE on every new function to PUBLIC.
-- A default that names a schema is added to that built-in default, so it cannot
-- take the grant away; only this form, without IN SCHEMA, can.
alter default privileges for role postgres
  revoke execute on functions from public;

-- Make the service role's default explicit, so that the change above cannot
-- leave a database without it. Canary and Production already carry this row.
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

do $$
declare
  leftover text;
begin
  select string_agg(format('%s:%s:%s', d.defaclobjtype, coalesce(nullif(a.grantee, 0)::regrole::text, 'public'), a.privilege_type), ', ')
    into leftover
    from pg_default_acl d,
         aclexplode(d.defaclacl) a
   where d.defaclrole = 'postgres'::regrole
     and d.defaclnamespace = 'public'::regnamespace
     and d.defaclobjtype in ('r', 'S', 'f')
     and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole);
  if leftover is not null then
    raise exception 'postgres default privileges still grant the API roles on new public objects: %', leftover;
  end if;

  -- The default that is not limited to one schema must exist and must not
  -- grant EXECUTE to PUBLIC.
  if not exists (
    select 1
      from pg_default_acl d
     where d.defaclrole = 'postgres'::regrole
       and d.defaclnamespace = 0
       and d.defaclobjtype = 'f'
  ) or exists (
    select 1
      from pg_default_acl d,
           aclexplode(d.defaclacl) a
     where d.defaclrole = 'postgres'::regrole
       and d.defaclnamespace = 0
       and d.defaclobjtype = 'f'
       and a.grantee = 0
  ) then
    raise exception 'new functions would still be executable by PUBLIC';
  end if;

  if not exists (
    select 1
      from pg_default_acl d,
           aclexplode(d.defaclacl) a
     where d.defaclrole = 'postgres'::regrole
       and d.defaclnamespace = 'public'::regnamespace
       and d.defaclobjtype = 'f'
       and a.grantee = 'service_role'::regrole
       and a.privilege_type = 'EXECUTE'
  ) then
    raise exception 'new public functions would not be executable by service_role';
  end if;
end
$$;
