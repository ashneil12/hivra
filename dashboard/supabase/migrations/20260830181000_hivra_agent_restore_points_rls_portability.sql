-- Keep the restore-point owner policy portable to the embedded PostgreSQL
-- verification harness as well as Supabase/PostgREST. This is equivalent to
-- auth.jwt()->>'sub' without requiring the auth schema to exist at migration
-- parse time.

drop policy if exists hivra_agent_snapshots_owner_select
  on public.hivra_agent_snapshots;
create policy hivra_agent_snapshots_owner_select
  on public.hivra_agent_snapshots
  for select
  to authenticated
  using (user_id = current_setting('request.jwt.claims', true)::json ->> 'sub');
