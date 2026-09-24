-- *** QUEUED: DO NOT APPLY BEFORE THE SLOT-LOCK CODE IS SERVING ***
--
-- Plan agent limit, migration B of two. It is intentionally OUTSIDE
-- `dashboard/supabase/migrations/`, so `supabase db push`, an "apply every
-- pending migration" run or the production schema catch-up at the first
-- Promote can never apply it early. Applied before the code that writes
-- Hivra-managed agents through insert_hivra_managed_agent() and
-- reserve_hivra_launch_model_request_v3() serves, this trigger refuses every
-- launch the old code makes.
--
-- To apply, per environment (docs/release/MANAGED-HOSTING-RELEASES.md,
-- "Queued database steps"):
--   1. Confirm migration A (`*_hivra_agent_slot_limit.sql`) is applied and the
--      code that calls it is SERVING there (Canary: the Git build of the merge
--      is live; production: after the owner's Promote).
--   2. Run the launch smoke test on the served revision.
--   3. Copy this file into dashboard/supabase/migrations/ with a timestamp later
--      than every existing file, regenerate the manifest
--      (node scripts/generate-migrations-manifest.cjs), merge that by PR, and
--      apply that one file with its ledger row.
--   4. Run the launch, start and restart smoke tests again.
--
-- Rollback: drop the trigger and function below and restore service_role
-- EXECUTE on the two reservation functions. Migration A stays.
--
-- Design: docs/superpowers/specs/2026-09-24-agent-computer-contract-and-attach.md
-- section 5.1 (rollout order) and threat T35.

-- The unlocked reservations can no longer be reached by the application. The
-- v3 wrapper still calls them inside its own locked transaction.
revoke execute on function public.reserve_hivra_launch_model_request(text,uuid,jsonb,uuid,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
revoke execute on function public.reserve_hivra_launch_model_request_v2(text,uuid,jsonb,uuid,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;

-- A new writer cannot skip the lock by accident: a Hivra-managed row that takes
-- a slot is refused unless the writing function counted it under the owner's
-- slot lock in this transaction. That covers an insert, and an update that
-- moves a row into a slot: into Hivra-managed mode, or from a status that holds
-- no slot (error, deleted) back into one that does (provisioning, running,
-- stopped), such as a restore or a retry. Moves between slot-holding statuses
-- (start, stop, restart) and every move out of a slot are left alone. The
-- trigger cannot check the limit itself; it cannot see the plan.
create or replace function public.guard_hivra_managed_agent_slot_writer()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if new.deployment_mode='hivra-managed'
    and new.status in ('provisioning','running','stopped')
    and (tg_op='INSERT'
      or old.deployment_mode is distinct from 'hivra-managed'
      or old.status is null or old.status not in ('provisioning','running','stopped'))
    and coalesce(current_setting('hivra.agent_slot_checked', true), '')<>'on' then
    raise exception 'Hivra-managed agents must be written under the plan slot lock'
      using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_hivra_managed_agent_slot_writer() from public,anon,authenticated,service_role;

drop trigger if exists hivra_managed_agent_slot_writer_guard on public.hivra_agents;
create trigger hivra_managed_agent_slot_writer_guard
before insert or update of deployment_mode, status on public.hivra_agents
for each row execute function public.guard_hivra_managed_agent_slot_writer();
