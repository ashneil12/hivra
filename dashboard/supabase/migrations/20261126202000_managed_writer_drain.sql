alter table managed_launch_bridge_private.contract
  add column writer_closed_xact xid8;

create function managed_launch_bridge_private.writer_drain_operator()
returns boolean language sql stable set search_path=pg_catalog,pg_temp as $$
  select session_user = pg_get_userbyid(relowner)
    and current_setting('role',true) in ('none',session_user)
    and current_setting('transaction_isolation')='read committed'
  from pg_class where oid='managed_launch_bridge_private.contract'::regclass;
$$;

create function managed_launch_bridge_private.writer_drain_maintenance()
returns boolean language sql volatile set search_path=pg_catalog,pg_temp as $$
  select managed_launch_bridge_private.writer_drain_operator() and (
    coalesce(current_setting('hivra.managed_launch_bridge_transition',true),'') like pg_current_xact_id()::text||':%'
    or current_setting('hivra.managed_writer_reconcile',true) is not distinct from pg_current_xact_id()::text
  );
$$;

create function managed_launch_bridge_private.lock_writer_gate()
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_closed boolean;
begin
  select writer_closed_xact is not null into strict v_closed from managed_launch_bridge_private.contract where singleton;
  if not v_closed then
    select writer_closed_xact is not null into strict v_closed from managed_launch_bridge_private.contract where singleton for share;
  end if;
  if v_closed and not managed_launch_bridge_private.writer_drain_maintenance() then
    raise exception 'managed writer drain is closed' using errcode='P0059';
  end if;
end;
$$;

create function managed_launch_bridge_private.guard_writer_drain()
returns trigger language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform managed_launch_bridge_private.lock_writer_gate();
  return null;
end;
$$;

create trigger guard_managed_writer_drain before insert or update or delete or truncate on public.hermes_instances
  for each statement execute function managed_launch_bridge_private.guard_writer_drain();
create trigger guard_managed_writer_drain before insert or update or delete or truncate on public.hivra_agents
  for each statement execute function managed_launch_bridge_private.guard_writer_drain();
create trigger guard_managed_writer_drain before insert or update or delete or truncate on public.hivra_launch_operations
  for each statement execute function managed_launch_bridge_private.guard_writer_drain();
create trigger guard_managed_writer_drain before insert or update or delete or truncate on public.hivra_launch_model_requests
  for each statement execute function managed_launch_bridge_private.guard_writer_drain();
create trigger guard_managed_writer_drain before insert or update or delete or truncate on public.hivra_model_key_operations
  for each statement execute function managed_launch_bridge_private.guard_writer_drain();
create trigger guard_managed_writer_drain before insert or update or delete or truncate on public.hermes_computer_moves
  for each statement execute function managed_launch_bridge_private.guard_writer_drain();

create function managed_launch_bridge_private.writer_drain_pending()
returns jsonb language sql stable set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object(
    'native', (select count(*) from public.hivra_launch_operations where phase in ('reserved','reconciling','bound')),
    'modelAttempts', (select count(*) from public.hivra_launch_model_requests
      where phase='admitting' or (phase='waiting' and attempt_id is not null)),
    'modelDeliveries', (select count(*) from public.hivra_model_key_operations where phase='pending'),
    'moves', (select count(*) from public.hermes_computer_moves where state not in ('done','failed','undone')),
    'managed', (select count(*) from public.hivra_agents
      where status='provisioning' or operation_kind is not null),
    'classicLifecycle', (select count(*) from public.hermes_instances
      where lifecycle_state in ('provisioning','restoring','archiving','deleting')
        or lifecycle_substate in ('holder_nap','holder_save','holder_wake','holder_retry','classic_start')
        or to_jsonb(hermes_instances)->>'resize_operation_id' is not null),
    'classicStart', (select count(*) from managed_launch_bridge_private.classic_start where outcome is null)
  );
$$;

create function managed_launch_bridge_private.require_empty_writer_drain()
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select 1 from jsonb_each_text(managed_launch_bridge_private.writer_drain_pending()) where value<>'0') then
    raise exception 'managed writer drain has unresolved operations' using errcode='P0059';
  end if;
end;
$$;

create function managed_launch_bridge_private.set_writer_drain(p_epoch text,p_closed boolean)
returns jsonb language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_contract managed_launch_bridge_private.contract%rowtype;
begin
  if not managed_launch_bridge_private.writer_drain_operator() or p_closed is null then
    raise exception 'writer drain requires the migration owner in READ COMMITTED' using errcode='42501';
  end if;
  select * into strict v_contract from managed_launch_bridge_private.contract where singleton for update;
  if v_contract.epoch is distinct from p_epoch
    or managed_launch_bridge_private.schema_epoch() is distinct from p_epoch then
    raise exception 'managed writer drain epoch does not match the reviewed schema';
  end if;
  if not p_closed then perform managed_launch_bridge_private.require_empty_writer_drain(); end if;
  update managed_launch_bridge_private.contract
    set writer_closed_xact=case when p_closed then coalesce(writer_closed_xact,pg_current_xact_id()) end
    where singleton;
  return managed_launch_bridge_private.writer_drain_pending();
end;
$$;

create function managed_launch_bridge_private.begin_writer_reconciliation(p_epoch text)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  if not managed_launch_bridge_private.writer_drain_operator() then
    raise exception 'writer reconciliation requires the migration owner' using errcode='42501';
  end if;
  if not exists(select 1 from managed_launch_bridge_private.contract
      where singleton and writer_closed_xact<>pg_current_xact_id() and epoch=p_epoch for update)
    or managed_launch_bridge_private.schema_epoch() is distinct from p_epoch then
    raise exception 'writer reconciliation requires the closed, matching epoch';
  end if;
  perform set_config('hivra.managed_writer_reconcile',pg_current_xact_id()::text,true);
end;
$$;

create function managed_launch_bridge_private.release_expired_custody_attempt(
  p_user_id text,p_request_id uuid,p_attempt_id uuid
) returns boolean language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  if not managed_launch_bridge_private.writer_drain_operator()
    or current_setting('hivra.managed_writer_reconcile',true) is distinct from pg_current_xact_id()::text
    or not exists(select 1 from managed_launch_bridge_private.contract
      where singleton and writer_closed_xact<>pg_current_xact_id()) then
    raise exception 'custody lease release requires closed writer reconciliation' using errcode='42501';
  end if;
  update public.hivra_launch_model_requests q
  set attempt_id=null,attempt_expires_at=null
  where q.user_id=p_user_id and q.request_id=p_request_id and q.attempt_id=p_attempt_id
    and q.phase='waiting' and q.attempt_expires_at<=clock_timestamp()
    and not exists(select 1 from public.hivra_model_key_operations k where k.operation_id=q.model_operation_id);
  return found;
end;
$$;

create or replace function managed_launch_bridge_private.lock_epoch()
returns text language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
declare
  v_epoch text;
begin
  perform managed_launch_bridge_private.lock_writer_gate();
  select epoch into strict v_epoch from managed_launch_bridge_private.contract where singleton for share;
  if v_epoch is distinct from managed_launch_bridge_private.schema_epoch() then
    raise exception 'managed launch bridge epoch does not match the reviewed schema';
  end if;
  return v_epoch;
end;
$$;

create or replace function managed_launch_bridge_private.begin_transition(p_expected text,p_next text)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  if not managed_launch_bridge_private.writer_drain_operator() then
    raise exception 'managed launch bridge transition requires the migration owner' using errcode='42501';
  end if;
  if ((p_expected='legacy' and p_next='funding') or (p_expected='funding' and p_next='placement')) is not true then
    raise exception 'invalid managed launch bridge transition';
  end if;
  if not exists(select 1 from managed_launch_bridge_private.contract
      where singleton and writer_closed_xact<>pg_current_xact_id() and epoch=p_expected for update)
    or managed_launch_bridge_private.schema_epoch() is distinct from p_expected then
    raise exception 'managed launch bridge transition requires the closed, matching predecessor';
  end if;
  perform managed_launch_bridge_private.require_empty_writer_drain();
  perform set_config('hivra.managed_launch_bridge_transition',
    pg_current_xact_id()::text||':'||p_expected||':'||p_next,true);
end;
$$;

create or replace function managed_launch_bridge_private.finish_transition(p_expected text,p_next text)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  if not managed_launch_bridge_private.writer_drain_operator() then
    raise exception 'managed launch bridge transition requires the migration owner' using errcode='42501';
  end if;
  if ((p_expected='legacy' and p_next='funding') or (p_expected='funding' and p_next='placement')) is not true
    or current_setting('hivra.managed_launch_bridge_transition',true) is distinct from
      (pg_current_xact_id()::text||':'||p_expected||':'||p_next) then
    raise exception 'managed launch bridge transition must be locked in this transaction';
  end if;
  if managed_launch_bridge_private.schema_epoch() is distinct from p_next then
    raise exception 'managed launch bridge transition successor does not match';
  end if;
  update managed_launch_bridge_private.contract set epoch=p_next
    where singleton and epoch=p_expected and writer_closed_xact<>pg_current_xact_id();
  if not found then raise exception 'managed launch bridge transition requires the closed, matching predecessor'; end if;
  perform set_config('hivra.managed_launch_bridge_transition','',true);
end;
$$;

revoke all on all functions in schema managed_launch_bridge_private from public,anon,authenticated,service_role;
