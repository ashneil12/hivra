-- Plan agent limit, migration B of two. BLOCKING ROLLOUT STEP.
--
-- Apply only after the code that writes Hivra-managed agents through
-- insert_hivra_managed_agent() and reserve_hivra_launch_model_request_v3() is
-- SERVING on the environment (Canary: the Git build of the merge is live;
-- production: after the owner's Promote). Applied earlier, this trigger refuses
-- every launch the old code makes. Run the launch smoke test on the served
-- revision before and after applying it.
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

-- A new writer cannot skip the lock by accident: a Hivra-managed row is refused
-- unless the writing function counted it under the owner's slot lock in this
-- transaction. The trigger cannot check the limit itself; it cannot see the plan.
create or replace function public.guard_hivra_managed_agent_slot_writer()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if new.deployment_mode='hivra-managed'
    and coalesce(current_setting('hivra.agent_slot_checked', true), '')<>'on' then
    raise exception 'Hivra-managed agents must be written under the plan slot lock'
      using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_hivra_managed_agent_slot_writer() from public,anon,authenticated,service_role;

drop trigger if exists hivra_managed_agent_slot_writer_guard on public.hivra_agents;
create trigger hivra_managed_agent_slot_writer_guard before insert on public.hivra_agents
for each row execute function public.guard_hivra_managed_agent_slot_writer();
