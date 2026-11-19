-- Explicit state transitions, phases 2 and 3.
--
-- Phase 2: a Hermes computer's lifecycle_state is the one source of truth.
-- The older `status` column and the deletion dates now follow it, in the
-- database, whenever lifecycle_state changes. About 60 writers set these
-- fields by hand and several set only one of them, which is how rows ended up
-- "deleted" with no deleted_at, or active again while still carrying a
-- deletion deadline.
--
--  * When an update changes lifecycle_state but does not change `status`, the
--    status is set to match (active -> running, deleted -> deleted, and so on).
--    An update that changes status too keeps the value it set. A row awaiting teardown
--    (status 'scheduled_for_deletion') keeps that marker until it becomes
--    active again or deleted.
--  * Becoming deleted stamps deleted_at if it is missing.
--  * Becoming active clears scheduled_deletion_at, as
--    buildInstanceLifecyclePatch already does for the writers that use it.
--  * Rows already deleted without a deleted_at get one.
--
-- Phase 3: billing status columns that had no check get one, listing the
-- values the code writes.
--
-- Additive and rerun-safe.

-- Phase 2 --------------------------------------------------------------------

create or replace function public.hermes_instance_status_for_lifecycle(p_lifecycle text, p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_lifecycle = 'deleted' then 'deleted'
    when p_lifecycle = 'active' then 'running'
    when p_status = 'scheduled_for_deletion' then p_status
    when p_lifecycle = 'failed' then case when p_status in ('failed', 'error') then p_status else 'failed' end
    when p_lifecycle in ('pending', 'provisioning') then case when p_status in ('provisioning', 'redeploying') then p_status else 'provisioning' end
    when p_lifecycle in ('paused', 'suspended', 'archiving', 'cold_archived', 'pending_deletion', 'restoring', 'deleting') then 'stopped'
    else p_status
  end;
$$;

create or replace function public.hermes_instance_follow_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.lifecycle_state is distinct from old.lifecycle_state then
    if new.status is not distinct from old.status then
      new.status := public.hermes_instance_status_for_lifecycle(new.lifecycle_state, new.status);
    end if;
    if new.lifecycle_state = 'deleted' and new.deleted_at is null then
      new.deleted_at := now();
    end if;
    if new.lifecycle_state = 'active' then
      new.scheduled_deletion_at := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists hermes_instances_follow_lifecycle on public.hermes_instances;
create trigger hermes_instances_follow_lifecycle
  before update of lifecycle_state on public.hermes_instances
  for each row execute function public.hermes_instance_follow_lifecycle();

-- Backfill: deleted rows without a deleted_at. Writes only deleted_at, so
-- neither the lifecycle triggers nor the watch fire.
update public.hermes_instances
set deleted_at = coalesce(last_lifecycle_transition_at, updated_at, now())
where lifecycle_state = 'deleted'
  and deleted_at is null;

-- Phase 3 --------------------------------------------------------------------

-- Values written by the Stripe webhook service, the subscription reconcile
-- functions and the pool sync. 'trialing' is mapped to 'active' today and is
-- listed only so a direct pass-through can never break a webhook.
alter table public.hermes_subscriptions drop constraint if exists hermes_subscriptions_status_check;
alter table public.hermes_subscriptions
  add constraint hermes_subscriptions_status_check
  check (status in ('active', 'trialing', 'past_due', 'pending', 'inactive', 'canceled')) not valid;
alter table public.hermes_subscriptions validate constraint hermes_subscriptions_status_check;

alter table public.pools drop constraint if exists pools_status_check;
alter table public.pools
  add constraint pools_status_check
  check (status in ('active', 'past_due', 'pending', 'inactive', 'canceled')) not valid;
alter table public.pools validate constraint pools_status_check;

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check
  check (status in ('creating', 'running', 'stopped')) not valid;
alter table public.profiles validate constraint profiles_status_check;
