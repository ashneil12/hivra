-- The ordinary paused/stopped lifecycle gives the owner a Start action and
-- fences background live mutations. holder_idle is distinct from inactivity
-- (the latter authorizes eventual reclaim). Only confirmed saves free compute.
alter table public.hermes_instances
  add column if not exists holder_idle_generation bigint not null default 0,
  add column if not exists holder_napped_at timestamptz;

create index if not exists hermes_holder_idle_scan on public.hermes_instances
  (holder_idle_claimed_at nulls first) where seat_funding='holder' and deleted_at is null;

-- Writes from separate browser/terminal workers can arrive out of order.
create or replace function public.keep_classic_holder_activity_watermark()
returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  new.last_activity_at := greatest(old.last_activity_at,new.last_activity_at);
  return new;
end;
$$;
drop trigger if exists keep_classic_holder_activity_watermark on public.hermes_instances;
create trigger keep_classic_holder_activity_watermark before update of last_activity_at
  on public.hermes_instances for each row when (new.seat_funding='holder')
  execute function public.keep_classic_holder_activity_watermark();

-- Claim exactly one operation. Explicit wakes can supersede sleep claims.
-- An expired operation recovers toward awake, including after lost SSH or a
-- missing finish write. The generation also fences delayed commands on-host.
create or replace function public.claim_classic_holder_idle(
  p_id uuid, p_owner text, p_allow_sleep boolean
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
  select h.*, choice.action into r
  from public.hermes_instances h
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
        when h.lifecycle_substate='holder_napping' and h.holder_napped_at <= t-interval '12 minutes'
          and h.holder_idle_claimed_at <= t-interval '30 seconds' then 'hibernate'
      end
    when p_id is null and h.lifecycle_state='active' and h.status='running'
      and h.paused_reason is null and h.lifecycle_substate is null
      and h.last_activity_at is not null and h.created_at is not null
      and greatest(h.created_at,h.last_activity_at,h.last_agent_activity_at) <= t-interval '4 minutes'
      and (h.holder_idle_claimed_at is null or h.holder_idle_claimed_at <= t-interval '1 minute')
      and not exists(select 1 from public.channel_connections c where c.target_kind='hermes' and c.target_id=h.id::text)
      then 'nap'
  end as action) choice
  where h.seat_funding='holder' and h.deleted_at is null and h.archive_uri is null
    and h.scheduled_deletion_at is null and h.entitlement_state is distinct from 'suspended'
    and (p_id is null or (h.id=p_id and h.user_id=p_owner))
    and h.proxmox_node is not null and h.proxmox_vmid is not null
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
    and exists(select 1 from public.holder_admissions a where a.user_id=h.user_id and a.state='admitted')
    and not exists (select 1 from public.hermes_computer_moves m where m.instance_id=h.id
      and m.state in ('queued','launching','packing','uploading','unpacking','finishing','undoing'))
    and choice.action is not null
    and (choice.action='wake' or (p_allow_sleep and exists(select 1 from public.proxmox_hosts host
      where host.id=h.proxmox_node and host.sleep_mode in ('on','canary') and host.status='active')))
  order by (choice.action='wake') desc,h.holder_idle_claimed_at nulls first,h.id
  limit 1 for update of h skip locked;
  if not found then return null; end if;
  if not public.holder_seat_funding_valid(r.user_id,r.cpu_limit,r.ram_limit,null,r.id) then
    update public.hermes_instances set holder_idle_claimed_at=t where id=r.id;
    -- An ineligible seat must not end this tick before other seats are visited.
    if p_id is null then return jsonb_build_object('action','skipped'); end if;
    return null;
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

create or replace function public.finish_classic_holder_idle(
  p_id uuid,p_generation bigint,p_node text,p_vmid integer,p_state text
) returns text language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  r public.hermes_instances;
  t timestamptz := clock_timestamp();
  stage text;
begin
  select * into r from public.hermes_instances where id=p_id and holder_idle_generation=p_generation
    and proxmox_node=p_node and proxmox_vmid=p_vmid and seat_funding='holder'
    and lifecycle_state='paused' and status='stopped' and paused_reason='holder_idle'
    and lifecycle_substate in ('holder_nap','holder_save','holder_wake')
    and deleted_at is null and archive_uri is null and scheduled_deletion_at is null
    and entitlement_state is distinct from 'suspended' for update;
  if not found then return null; end if;
  if p_state not in ('awake','napping','hibernated','retry') or p_state is null
    or (r.lifecycle_substate='holder_nap' and p_state='hibernated')
    or (r.lifecycle_substate='holder_wake' and p_state='napping') then return null; end if;
  stage := 'holder_' || p_state;
  if p_state in ('napping','hibernated') and
    (greatest(r.last_activity_at,r.last_agent_activity_at)>r.holder_idle_claimed_at or
     exists(select 1 from public.channel_connections c where c.target_kind='hermes' and c.target_id=r.id::text))
    then stage := 'holder_retry'; end if;
  update public.hermes_instances set
    lifecycle_state=case when stage='holder_awake' then 'active' else 'paused' end,
    status=case when stage='holder_awake' then 'running' else 'stopped' end,
    paused_reason=case when stage='holder_awake' then null else 'holder_idle' end,
    lifecycle_substate=case when stage='holder_awake' then null else stage end,
    holder_napped_at=case when stage='holder_awake' then null
      when r.lifecycle_substate='holder_nap' and stage='holder_napping' then t else holder_napped_at end,
    last_activity_at=case when stage='holder_awake' and r.lifecycle_substate='holder_wake'
      then greatest(last_activity_at,t) else last_activity_at end,
    last_lifecycle_transition_at=t,updated_at=t
  where id=r.id;
  return substr(stage,length('holder_')+1);
end;
$$;

revoke all on function public.claim_classic_holder_idle(uuid,text,boolean),public.finish_classic_holder_idle(uuid,bigint,text,integer,text) from public,anon,authenticated;
grant execute on function public.claim_classic_holder_idle(uuid,text,boolean),public.finish_classic_holder_idle(uuid,bigint,text,integer,text) to service_role;

-- Same registry-scoped rows as rankProxmoxHostsForPlacement. Every Hivra
-- row on these nodes counts, including a stopped VM's disk. Deep sleep can
-- release compute without releasing disk.
create or replace function public.holder_placement_accounting(p_targets text[], p_skip_sleep boolean)
returns table(host_id text, owner_id text, holder boolean, cpu numeric, ram_mb numeric, disk_gb numeric, launching integer, launched_cpu numeric, launched_ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with hosts as (
    select c.host_id, h.placement_skip_deep_sleep
    from public.holder_admission_host_capacity(p_targets) c
    join public.proxmox_hosts h on h.id = c.host_id
  )
  select h.proxmox_node, h.user_id, h.seat_funding = 'holder',
         case when saved.reusable then 0 else h.cpu_limit::numeric end,
         case when saved.reusable then 0 else h.ram_limit::numeric end, coalesce(h.disk_size_gb,30)::numeric, 0, h.cpu_limit::numeric, h.ram_limit::numeric
  from public.hermes_instances h join hosts on hosts.host_id = h.proxmox_node
  cross join lateral (select h.seat_funding='holder' and h.lifecycle_state='paused' and h.paused_reason='holder_idle'
    and h.lifecycle_substate='holder_hibernated' and (p_skip_sleep or hosts.placement_skip_deep_sleep) as reusable) saved
  where h.lifecycle_state in ('provisioning','active') or
    (h.lifecycle_state='paused' and h.seat_funding='holder' and h.paused_reason='holder_idle')
  union all
  select a.proxmox_host, a.user_id, a.seat_funding = 'holder',
         case when powered.holds_compute then a.cpu else 0 end,
         case when powered.holds_compute then a.ram::numeric * 1024 else 0 end,
         40::numeric, case when a.status = 'provisioning' then 1 else 0 end,
         case when a.status in ('running','provisioning') then a.cpu else 0 end,
         case when a.status in ('running','provisioning') then a.ram::numeric * 1024 else 0 end
  from public.hivra_agents a join hosts on hosts.host_id = a.proxmox_host
  cross join lateral (select a.status in ('running','provisioning')
    and not (a.sleep_state is not distinct from 'hibernated'
             and (p_skip_sleep or coalesce(hosts.placement_skip_deep_sleep,false))) as holds_compute) powered
  where a.status <> 'deleted' and (a.status in ('running','provisioning') or a.vmid is not null);
$$;
