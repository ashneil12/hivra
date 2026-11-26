-- Repair the Classic holder sleep lifecycle after the feature flag or host
-- sleep policy changes, and let the sweep skip hosts already busy without
-- weakening the generation fence. Placement accounting is intentionally not
-- replaced here; the 20261125030000 version remains authoritative.

drop function if exists public.claim_classic_holder_idle(uuid,text,boolean);

create or replace function public.claim_classic_holder_idle(
  p_id uuid, p_owner text, p_allow_sleep boolean, p_exclude_hosts text[] default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  r record;
  t timestamptz := clock_timestamp();
begin
  if (p_id is null) <> (p_owner is null) then return null; end if;
  -- An owner opening the running workspace races on the same row lock as
  -- the cron. Either access refreshes the clock first, or it sees the claim
  -- and requests a fenced wake. Background readiness polling never calls this.
  if p_id is not null then
    update public.hermes_instances set last_activity_at=greatest(last_activity_at,t)
    where id=p_id and user_id=p_owner and seat_funding='holder' and status='running'
      and lifecycle_state='active' and entitlement_state is distinct from 'suspended'
      and deleted_at is null and paused_reason is null;
    if found then return jsonb_build_object('action','already_awake'); end if;
  end if;
  select h.*, choice.action, wake_state.wake_reconciliation into r
  from public.hermes_instances h
  cross join lateral (select
    (p_allow_sleep and exists(select 1 from public.proxmox_hosts host
      where host.id=h.proxmox_node and host.sleep_mode in ('on','canary')
        and host.status = 'active')) as nap_allowed,
    (p_allow_sleep and exists(select 1 from public.proxmox_hosts host
      where host.id=h.proxmox_node and host.sleep_mode in ('on','canary')
        and host.status in ('active','draining'))) as save_allowed
  ) policy
  cross join lateral (select case
    when h.lifecycle_state='paused' and h.status='stopped' and h.paused_reason='holder_idle' then
      case
        when h.lifecycle_substate='holder_wake' and h.holder_idle_claimed_at > t-interval '6 minutes' then null
        when p_id is not null then 'wake'
        when h.lifecycle_substate in ('holder_nap','holder_save','holder_wake')
          and h.holder_idle_claimed_at <= t-interval '6 minutes' then 'wake'
        when h.lifecycle_substate='holder_retry' and h.holder_idle_claimed_at <= t-interval '30 seconds' then 'wake'
        when h.lifecycle_substate in ('holder_napping','holder_hibernated') and h.holder_idle_claimed_at <= t-interval '30 seconds' and
          (greatest(h.last_activity_at,h.last_agent_activity_at) > h.holder_napped_at
           or exists(select 1 from public.channel_connections c where c.target_kind='hermes' and c.target_id=h.id::text)) then 'wake'
        -- A nap never released its memory, so resuming it is the safe exit when
        -- automatic sleep is switched off or this host may no longer accept a
        -- save. Draining is still safe for the save itself: no new placement is
        -- allowed there, but existing VMs keep running and evacuation needs the
        -- memory write to finish. Maintenance, a missing row, observe/off, and a
        -- disabled feature flag are not safe to deepen, so those naps resume.
        when h.lifecycle_substate='holder_napping' and h.holder_idle_claimed_at <= t-interval '30 seconds'
          and not policy.save_allowed then 'wake'
        when h.lifecycle_substate='holder_napping' and h.holder_napped_at <= t-interval '12 minutes'
          and h.holder_idle_claimed_at <= t-interval '30 seconds' then 'hibernate'
      end
    when p_id is null and h.lifecycle_state='active' and h.status='running'
      and h.paused_reason is null and h.lifecycle_substate is null
      and h.last_activity_at is not null and h.created_at is not null
      and greatest(h.created_at,h.last_activity_at,h.last_agent_activity_at) <= t-interval '4 minutes'
      and (h.holder_idle_claimed_at is null or h.holder_idle_claimed_at <= t-interval '1 minute')
      and not exists(select 1 from public.channel_connections c where c.target_kind='hermes' and c.target_id=h.id::text)
      and policy.nap_allowed
      then 'nap'
  end as action) choice
  cross join lateral (select
    coalesce((
      h.lifecycle_state='paused' and h.status='stopped' and h.paused_reason='holder_idle'
      and h.lifecycle_substate in ('holder_wake','holder_retry')
      and h.holder_idle_claimed_at is not null
    ), false) as wake_reconciliation
  ) wake_state
  cross join lateral (select exists(select 1 from public.hermes_instances busy
    where busy.id <> h.id
      and busy.proxmox_node = h.proxmox_node
      and busy.seat_funding='holder'
      and busy.lifecycle_state='paused'
      and busy.status='stopped'
      and busy.paused_reason='holder_idle'
      and busy.lifecycle_substate in ('holder_nap','holder_save','holder_wake')
      and busy.holder_idle_claimed_at > t-interval '6 minutes'
      and busy.deleted_at is null) as occupied
  ) occupancy
  where h.seat_funding='holder' and h.deleted_at is null and h.archive_uri is null
    and not occupancy.occupied
    and h.scheduled_deletion_at is null and h.entitlement_state is distinct from 'suspended'
    and (p_id is null or (h.id=p_id and h.user_id=p_owner))
    and h.proxmox_node is not null and h.proxmox_vmid is not null
    and not (h.proxmox_node = any(coalesce(p_exclude_hosts, array[]::text[])))
    and ((
      h.config->'infrastructure'->>'provider'='proxmox'
      and jsonb_typeof(h.config->'infrastructure'->'vmid')='number'
      and h.config->'infrastructure'->>'vmid'=h.proxmox_vmid::text
      and coalesce(nullif(h.config->'infrastructure'->>'hostSlug',''),h.config->'infrastructure'->>'node',
                   h.config->'infrastructure'->>'proxmoxNode')=h.proxmox_node
      and nullif(h.config->'infrastructure'->>'privateIpv4','') is not null
      and nullif(h.config->'infrastructure'->>'gatewayHost','') is not null
    ) or (
      -- Earlier seats have the same lifecycle handle in dedicated columns.
      h.config->>'infrastructure' is null and h.config->>'infrastructureReleased' is null
      and h.infrastructure_provider='proxmox' and nullif(h.ipv4_address,'') is not null
      and h.gateway_url like 'https://%'
    ))
    and (
      exists(select 1 from public.holder_admissions a where a.user_id=h.user_id and a.state='admitted')
      or (p_id is not null and choice.action='wake' and wake_state.wake_reconciliation)
    )
    and not exists (select 1 from public.hermes_computer_moves m where m.instance_id=h.id
      and m.state in ('queued','launching','packing','uploading','unpacking','finishing','undoing'))
    and choice.action is not null
    and (choice.action='wake'
      or (choice.action='nap' and policy.nap_allowed)
      or (choice.action='hibernate' and policy.save_allowed))
  order by (choice.action='wake') desc,h.holder_idle_claimed_at nulls first,h.id
  limit 1 for update of h skip locked;
  if not found then
    -- An owner wake must not confuse a released reservation with a transient
    -- restore. The owner is already authenticated against this row before the
    -- route calls us, so naming the reservation state here leaks nothing.
    if p_id is not null
      and exists(select 1 from public.hermes_instances h
        where h.id=p_id and h.user_id=p_owner and h.seat_funding='holder'
          and h.lifecycle_state='paused' and h.status='stopped' and h.paused_reason='holder_idle'
          and h.deleted_at is null)
      and not exists(select 1 from public.holder_admissions a where a.user_id=p_owner and a.state='admitted')
    then
      return jsonb_build_object('action','reservation_released');
    end if;
    return null;
  end if;
  -- Serialize the check and claim across sweep and owner requests, including
  -- wake recovery when the host is missing from the inventory. Never wait
  -- behind the transaction while holding the selected instance row.
  if not pg_try_advisory_xact_lock(hashtextextended('classic-holder-idle-host:' || r.proxmox_node, 0)) then
    return null;
  end if;
  t := clock_timestamp();
  -- The selection snapshot can predate a transaction that just committed.
  -- The persisted claim keeps this host fenced after that transaction ends.
  if exists(select 1 from public.hermes_instances busy
    where busy.id <> r.id
      and busy.proxmox_node = r.proxmox_node
      and busy.seat_funding='holder'
      and busy.lifecycle_state='paused'
      and busy.status='stopped'
      and busy.paused_reason='holder_idle'
      and busy.lifecycle_substate in ('holder_nap','holder_save','holder_wake')
      and busy.holder_idle_claimed_at > t-interval '6 minutes'
      and busy.deleted_at is null
  ) then
    return null;
  end if;
  if not (
      r.wake_reconciliation
      and not exists(
        select 1 from public.holder_admissions a
        where a.user_id = r.user_id and a.state = 'admitted'
      )
    )
    -- Nap/save validation may span hosts because those transitions do not consume
    -- unlaunched backing. A wake does consume it, so its admission host must match.
    and (
      not public.holder_seat_funding_valid(r.user_id,r.cpu_limit,r.ram_limit,null,r.id)
      or (
        r.action = 'wake'
        and not exists(
          select 1 from public.holder_admissions a
          where a.user_id = r.user_id and a.state = 'admitted'
            and public.holder_admission_normalize_host_id(a.assigned_host_id)
              = public.holder_admission_normalize_host_id(r.proxmox_node)
        )
      )
    ) then
    update public.hermes_instances set holder_idle_claimed_at=t where id=r.id;
    -- An ineligible seat must not end this tick before other seats are visited.
    if p_id is null then return jsonb_build_object('action','skipped'); end if;
    return jsonb_build_object('action','reservation_ineligible');
  end if;
  update public.hermes_instances set lifecycle_state='paused', status='stopped', paused_reason='holder_idle',
    lifecycle_substate=case r.action when 'nap' then 'holder_nap' when 'hibernate' then 'holder_save' else 'holder_wake' end,
    holder_idle_generation=r.holder_idle_generation+1, holder_idle_claimed_at=t,
    last_activity_at=case when p_owner is not null then greatest(last_activity_at,t) else last_activity_at end,
    updated_at=t, last_lifecycle_transition_at=t where id=r.id;
  return jsonb_build_object('id',r.id,'owner',r.user_id,'action',r.action,'generation',r.holder_idle_generation+1,
    'node',r.proxmox_node,'vmid',r.proxmox_vmid,'host_id',r.host_id,'infrastructure',r.config->'infrastructure',
    'ipv4_address',r.ipv4_address,'gateway_url',r.gateway_url);
end;
$$;

create or replace function public.holder_admission_has_active_wake(p_user_id text)
returns boolean
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select exists (
    select 1
    from public.hermes_instances h
    where h.user_id = p_user_id
      and h.seat_funding = 'holder'
      and h.lifecycle_state = 'paused'
      and h.status = 'stopped'
      and h.paused_reason = 'holder_idle'
      and h.lifecycle_substate = 'holder_wake'
      and h.holder_idle_claimed_at > now() - interval '6 minutes'
      and h.deleted_at is null
  );
$$;

revoke all on function public.holder_admission_has_active_wake(text) from public,anon,authenticated,service_role;
grant execute on function public.holder_admission_has_active_wake(text) to service_role;

create or replace function public.enforce_hermes_instance_seat_funding()
returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
declare
  holder_idle_awake_reconciliation boolean := false;
begin
  if tg_op = 'UPDATE' then
    holder_idle_awake_reconciliation := coalesce((
      old.seat_funding = 'holder'
      and new.seat_funding = 'holder'
      and old.lifecycle_state = 'paused'
      and old.status = 'stopped'
      and old.paused_reason = 'holder_idle'
      and old.lifecycle_substate = 'holder_wake'
      and old.holder_idle_generation is not null
      and old.holder_idle_claimed_at is not null
      and new.holder_idle_generation is not distinct from old.holder_idle_generation
      and new.user_id is not distinct from old.user_id
      and new.cpu_limit is not distinct from old.cpu_limit
      and new.ram_limit is not distinct from old.ram_limit
      and new.proxmox_node is not distinct from old.proxmox_node
      and new.proxmox_vmid is not distinct from old.proxmox_vmid
      and new.lifecycle_state = 'active'
      and new.status = 'running'
      and new.paused_reason is null
      and new.lifecycle_substate is null
    ), false);
  end if;

  if tg_op = 'UPDATE'
    and new.seat_funding is distinct from old.seat_funding
    and coalesce(current_setting('hivra.seat_funding_writer', true), 'off') <> 'on'
  then
    raise exception 'seat_funding is immutable after provisioning';
  end if;

  if new.seat_funding='holder' and not holder_idle_awake_reconciliation and (
    tg_op='INSERT' or new.seat_funding is distinct from old.seat_funding
    or new.user_id is distinct from old.user_id
    or new.cpu_limit > coalesce(old.cpu_limit,0) or new.ram_limit > coalesce(old.ram_limit,0)
    or (public.holder_hermes_allocated(new.status,new.lifecycle_state)
        and not public.holder_hermes_allocated(old.status,old.lifecycle_state))
    or (new.lifecycle_state in ('active','provisioning','restoring') and old.lifecycle_state in ('paused','suspended','cold_archived'))
    or (new.status in ('running','provisioning') and old.status='stopped')
  ) then
    if not public.holder_seat_funding_valid(new.user_id,new.cpu_limit,new.ram_limit,null,new.id) then
      raise exception using errcode='P0057', message='holder seat funding is not admitted or exceeds the reserved seat resources';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.claim_classic_holder_idle(uuid,text,boolean,text[]) from public,anon,authenticated;
grant execute on function public.claim_classic_holder_idle(uuid,text,boolean,text[]) to service_role;
