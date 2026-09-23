-- Retention and deletion for Hivra agent activity records.
--
-- WHY
-- hivra_agent_events (lifecycle events plus the content-free run/tool records
-- from the guest reporter) and hivra_activity_collectors (per-computer
-- reporter state) were kept forever: nothing pruned them, deleting a computer
-- left its whole history behind, and account deletion missed both tables. The
-- Privacy Policy promises activity records are kept for up to 90 days and that
-- a computer's data is removed when the computer is deleted.
--
-- WHAT
-- 1. Per-computer deletion (always on). When a computer reaches the terminal
--    status 'deleted' (only after verified teardown, on every delete path), its
--    activity events (up to 20,000; the job removes any rest) and its
--    reporter-state row are deleted in the same transaction. There is no audit reason to keep them: billing reads its own
--    ledgers, and ops keeps its own ops_events. The 'deleted' lifecycle event
--    that the app logs after the flip remains as a content-free tombstone and
--    ages out with the retention window.
-- 2. prune_hivra_activity(cutoff, batch_size, dry_run): one bounded batch of
--    the retention job (dashboard/src/lib/ops/activity-retention.ts, cron
--    /api/cron/prune-hivra-activity, OFF unless ACTIVITY_RETENTION_ENABLED=true).
--    It deletes events older than the cutoff, and leftovers of computers deleted
--    before (1) existed. dry_run only counts.
-- 3. An index on created_at so the age-based scan does not seq-scan.
--
-- Additive and idempotent. The trigger deletes only rows of computers whose
-- status changes to 'deleted' after this migration; existing leftovers are
-- removed only by the env-gated job, never by applying this file.

create index if not exists hivra_agent_events_created_at_idx
  on public.hivra_agent_events using btree (created_at);

create or replace function public.delete_hivra_activity_after_agent_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status is distinct from 'deleted' and new.status = 'deleted' then
    -- Bounded so a computer with a long history cannot push its delete
    -- finalization past the statement timeout; anything beyond the bound is a
    -- leftover that prune_hivra_activity removes.
    delete from public.hivra_agent_events e
     using (
       select id from public.hivra_agent_events
        where agent_id = new.id
        limit 20000
     ) doomed
     where e.id = doomed.id;
    -- Tolerate a database that predates the collectors table: a failure here
    -- would abort the computer's delete finalization.
    if to_regclass('public.hivra_activity_collectors') is not null then
      delete from public.hivra_activity_collectors where agent_id = new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists delete_hivra_activity_after_agent_delete on public.hivra_agents;
create trigger delete_hivra_activity_after_agent_delete
after update of status on public.hivra_agents
for each row execute function public.delete_hivra_activity_after_agent_delete();

revoke all on function public.delete_hivra_activity_after_agent_delete() from public, anon, authenticated;

create or replace function public.prune_hivra_activity(
  p_cutoff timestamptz,
  p_batch_size integer,
  p_dry_run boolean
)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_expired bigint := 0;
  v_deleted_agent_events bigint := 0;
  v_deleted_agent_collectors bigint := 0;
begin
  if p_cutoff is null or p_cutoff > now() - interval '1 day' then
    raise exception 'prune_hivra_activity: cutoff must be at least one day in the past';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 10000 then
    raise exception 'prune_hivra_activity: batch size must be between 1 and 10000';
  end if;

  if p_dry_run then
    select count(*) into v_expired
      from public.hivra_agent_events where created_at < p_cutoff;
    select count(*) into v_deleted_agent_events
      from public.hivra_agent_events e
      join public.hivra_agents a on a.id = e.agent_id
     where a.status = 'deleted' and e.created_at >= p_cutoff and e.event <> 'deleted';
    if to_regclass('public.hivra_activity_collectors') is not null then
      select count(*) into v_deleted_agent_collectors
        from public.hivra_activity_collectors c
        join public.hivra_agents a on a.id = c.agent_id
       where a.status = 'deleted';
    end if;
  else
    with doomed as (
      select id from public.hivra_agent_events
       where created_at < p_cutoff
       order by created_at
       limit p_batch_size
       for update skip locked
    )
    delete from public.hivra_agent_events e using doomed where e.id = doomed.id;
    get diagnostics v_expired = row_count;

    with doomed as (
      select e.id from public.hivra_agent_events e
        join public.hivra_agents a on a.id = e.agent_id
       where a.status = 'deleted' and e.event <> 'deleted'
       limit p_batch_size
       for update of e skip locked
    )
    delete from public.hivra_agent_events e using doomed where e.id = doomed.id;
    get diagnostics v_deleted_agent_events = row_count;

    if to_regclass('public.hivra_activity_collectors') is not null then
      with doomed as (
        select c.agent_id from public.hivra_activity_collectors c
          join public.hivra_agents a on a.id = c.agent_id
         where a.status = 'deleted'
         limit p_batch_size
         for update of c skip locked
      )
      delete from public.hivra_activity_collectors c using doomed where c.agent_id = doomed.agent_id;
      get diagnostics v_deleted_agent_collectors = row_count;
    end if;
  end if;

  return jsonb_build_object(
    'expiredEvents', v_expired,
    'deletedComputerEvents', v_deleted_agent_events,
    'deletedComputerCollectors', v_deleted_agent_collectors
  );
end;
$$;

revoke all on function public.prune_hivra_activity(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.prune_hivra_activity(timestamptz, integer, boolean) to service_role;

comment on function public.prune_hivra_activity(timestamptz, integer, boolean) is
  'One bounded batch of Hivra activity retention (or counts when dry_run). Service role only.';
