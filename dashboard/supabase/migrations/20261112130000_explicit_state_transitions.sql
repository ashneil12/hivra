-- Explicit state transitions, phase 1.
--
-- Several tables keep a lifecycle in a status column that any writer (a route,
-- a cron, hand-written SQL) could set to anything. This migration writes down
-- which moves are allowed, in the database, so every writer is held to the
-- same list:
--
--  1. hivra_bridge_requests: the full list is enforced, and the timestamps
--     must agree with the status (finished rows have finished_at, and so on).
--     Mirrors BRIDGE_TRANSITIONS in src/lib/local-bridge/states.ts.
--  2. hermes_computer_moves: the full list is enforced. Mirrors
--     MOVE_TRANSITIONS in src/lib/hermes-move/orchestrator.ts.
--  3. hivra_agents: status must be one of the five known values, and a
--     deleted agent stays deleted.
--  4. hermes_instances: the lifecycle list is WATCHED, not enforced. A move
--     outside it is recorded once per pair on the ops page
--     (source 'lifecycle-transition-watch') and still goes through. Mirrors
--     ALLOWED_TRANSITIONS in src/lib/instance-lifecycle.ts. Enforcing comes in
--     a later migration, once the watch has run long enough to show every
--     real move.
--
-- Additive and rerun-safe.

-- 1. Bridge requests ---------------------------------------------------------

create or replace function public.hivra_bridge_request_guard_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
     and (old.status, new.status) not in (
       ('pending','approved'), ('pending','denied'), ('pending','expired'),
       ('approved','running'), ('approved','expired'),
       ('running','done'), ('running','failed')
     ) then
    raise exception 'bridge request % cannot move % -> %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists hivra_bridge_requests_guard_transition on public.hivra_bridge_requests;
create trigger hivra_bridge_requests_guard_transition
  before update of status on public.hivra_bridge_requests
  for each row execute function public.hivra_bridge_request_guard_transition();

alter table public.hivra_bridge_requests
  drop constraint if exists hivra_bridge_requests_finished_shape_check,
  drop constraint if exists hivra_bridge_requests_dispatched_shape_check,
  drop constraint if exists hivra_bridge_requests_decided_shape_check;

alter table public.hivra_bridge_requests
  add constraint hivra_bridge_requests_finished_shape_check
    check ((finished_at is not null) = (status in ('done', 'denied', 'expired', 'failed'))),
  add constraint hivra_bridge_requests_dispatched_shape_check
    check (status not in ('running', 'done', 'failed') or dispatched_at is not null),
  add constraint hivra_bridge_requests_decided_shape_check
    check (status not in ('approved', 'running', 'done', 'failed', 'denied') or decided_at is not null);

-- 2. Hermes computer moves ---------------------------------------------------

create or replace function public.hermes_computer_move_guard_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state is distinct from old.state
     and (old.state, new.state) not in (
       ('queued','launching'), ('queued','failed'), ('queued','needs_attention'),
       ('launching','packing'), ('launching','failed'), ('launching','needs_attention'),
       ('packing','uploading'), ('packing','failed'), ('packing','needs_attention'),
       ('uploading','unpacking'), ('uploading','failed'), ('uploading','needs_attention'),
       ('unpacking','finishing'), ('unpacking','failed'), ('unpacking','needs_attention'),
       ('finishing','done'), ('finishing','failed'), ('finishing','needs_attention'),
       ('undoing','undone'), ('undoing','needs_attention'),
       ('done','undoing')
     ) then
    raise exception 'move % cannot change state % -> %', old.id, old.state, new.state
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists hermes_computer_moves_guard_transition on public.hermes_computer_moves;
create trigger hermes_computer_moves_guard_transition
  before update of state on public.hermes_computer_moves
  for each row execute function public.hermes_computer_move_guard_transition();

-- 3. Hivra agents ------------------------------------------------------------

alter table public.hivra_agents drop constraint if exists hivra_agents_status_check;
alter table public.hivra_agents
  add constraint hivra_agents_status_check
  check (status in ('provisioning', 'running', 'stopped', 'error', 'deleted')) not valid;
alter table public.hivra_agents validate constraint hivra_agents_status_check;

create or replace function public.hivra_agent_guard_deleted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'deleted' and new.status is distinct from 'deleted' then
    raise exception 'agent % is deleted and cannot become %', old.id, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists hivra_agents_guard_deleted on public.hivra_agents;
create trigger hivra_agents_guard_deleted
  before update of status on public.hivra_agents
  for each row execute function public.hivra_agent_guard_deleted();

-- 4. Hermes instances (watch only) -------------------------------------------

create or replace function public.hermes_instance_lifecycle_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_from = p_to or (p_from, p_to) in (
    ('pending','provisioning'), ('pending','failed'), ('pending','deleting'), ('pending','deleted'),
    ('provisioning','active'), ('provisioning','paused'), ('provisioning','failed'), ('provisioning','deleting'), ('provisioning','deleted'),
    ('active','provisioning'), ('active','paused'), ('active','suspended'), ('active','failed'), ('active','deleting'), ('active','deleted'),
    ('paused','provisioning'), ('paused','active'), ('paused','suspended'), ('paused','failed'), ('paused','deleting'), ('paused','deleted'), ('paused','archiving'),
    ('suspended','provisioning'), ('suspended','active'), ('suspended','paused'), ('suspended','failed'), ('suspended','deleting'), ('suspended','deleted'),
    ('failed','provisioning'), ('failed','active'), ('failed','paused'), ('failed','deleting'), ('failed','deleted'),
    ('deleting','deleted'), ('deleting','failed'),
    ('archiving','paused'), ('archiving','cold_archived'), ('archiving','failed'),
    ('cold_archived','restoring'), ('cold_archived','pending_deletion'), ('cold_archived','deleted'),
    ('pending_deletion','restoring'), ('pending_deletion','deleted'),
    ('restoring','active'), ('restoring','cold_archived'), ('restoring','pending_deletion'), ('restoring','failed')
  );
$$;

create or replace function public.hermes_instance_watch_lifecycle_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lifecycle_state is distinct from old.lifecycle_state
     and not public.hermes_instance_lifecycle_allowed(old.lifecycle_state, new.lifecycle_state) then
    begin
      insert into public.ops_events (fingerprint, source, severity, title, message, instance_id, user_id, environment, metadata)
      values (
        'lifecycle-transition-watch:' || old.lifecycle_state || '->' || new.lifecycle_state,
        'lifecycle-transition-watch',
        'warn',
        'Computer lifecycle moved outside the allowed list',
        'A Hermes computer moved ' || old.lifecycle_state || ' -> ' || new.lifecycle_state
          || '. Not blocked yet; this is watched before the list is enforced.',
        new.id::text,
        new.user_id::text,
        'database',
        jsonb_build_object('from', old.lifecycle_state, 'to', new.lifecycle_state,
          'status_from', old.status, 'status_to', new.status)
      )
      on conflict (fingerprint) do update
        set occurrence_count = public.ops_events.occurrence_count + 1,
            last_seen_at = now(),
            instance_id = excluded.instance_id,
            user_id = excluded.user_id,
            metadata = excluded.metadata,
            archived_at = null;
    exception when others then
      -- Watching must never stop a real write.
      null;
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.hermes_instance_watch_lifecycle_transition() from public, anon, authenticated;

drop trigger if exists hermes_instances_watch_lifecycle_transition on public.hermes_instances;
create trigger hermes_instances_watch_lifecycle_transition
  after update of lifecycle_state on public.hermes_instances
  for each row execute function public.hermes_instance_watch_lifecycle_transition();
