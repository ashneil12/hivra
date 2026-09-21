-- migration-drift-check (added 2026-05-12) tries to read
-- supabase_migrations.schema_migrations via PostgREST schema() escape
-- hatch. PostgREST refuses with "Invalid schema: supabase_migrations"
-- because that schema isn't in db.schemas; the cron has been throwing
-- 500s on every run (444 occurrences in ops_events as of 2026-05-18).
--
-- Exposing the supabase_migrations schema to PostgREST is overkill and
-- noisy. A SECURITY DEFINER RPC in public, locked to service_role,
-- gives the cron the read it needs without widening the API surface.

create or replace function public.list_applied_supabase_migrations()
returns table (version text, name text)
language sql
security definer
set search_path = supabase_migrations, pg_temp
as $$
  select version, name
  from supabase_migrations.schema_migrations
  order by version;
$$;

revoke all on function public.list_applied_supabase_migrations() from public;
revoke all on function public.list_applied_supabase_migrations() from anon, authenticated;
grant execute on function public.list_applied_supabase_migrations() to service_role;

comment on function public.list_applied_supabase_migrations() is
  'Read-only view of supabase_migrations.schema_migrations for the migration-drift cron. service_role only.';
