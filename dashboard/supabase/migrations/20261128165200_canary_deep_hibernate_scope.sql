set local lock_timeout='2s';

create schema hivra_deep_hibernate_qa_private;
revoke all on schema hivra_deep_hibernate_qa_private from public, anon, authenticated, service_role;

create table hivra_deep_hibernate_qa_private.scope (
  singleton boolean primary key default true check (singleton),
  agent_id uuid not null references public.hivra_agents(id) on delete cascade,
  owner_id text not null,
  host_id text not null,
  vmid integer not null check (vmid between 100 and 999999999 and vmid <> 9302),
  allocation_operation_id uuid not null,
  binding_token_hash text not null check (binding_token_hash ~ '^[0-9a-f]{64}$'),
  armed_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (isfinite(armed_at) and isfinite(expires_at) and expires_at > armed_at
    and expires_at <= armed_at + interval '2 hours')
);
alter table hivra_deep_hibernate_qa_private.scope enable row level security;
revoke all on hivra_deep_hibernate_qa_private.scope from public, anon, authenticated, service_role;

create function public.hivra_canary_deep_hibernate_candidate()
returns table (id uuid, proxmox_host text)
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select a.id,a.proxmox_host
    from hivra_deep_hibernate_qa_private.scope s
    join public.hivra_agents a on (a.id,a.user_id,a.proxmox_host,a.vmid,a.allocation_operation_id,
      a.infrastructure_binding_token_hash) = (s.agent_id,s.owner_id,s.host_id,s.vmid,s.allocation_operation_id,s.binding_token_hash)
    join public.proxmox_hosts h on h.id=s.host_id and h.status='active'
      and h.sleep_mode in ('canary','on') and h.decommissioned_at is null
   where s.armed_at <= statement_timestamp() and s.expires_at > statement_timestamp()
     and (a.canary_qa_holder_expires_at is null or a.canary_qa_holder_expires_at >= s.expires_at)
     and a.infrastructure_binding_token_enforced is true and a.seat_funding='holder'
     and a.deployment_mode='hivra-managed' and a.computer_substrate='proxmox-kvm'
     and a.deployment_target_id is null and a.type='hermes'
     and a.status='running' and a.desired_state='running' and a.operation_id is null
     and a.sleep_state='hibernated' and a.sleep_memory_dropped_at >= a.sleep_tier_changed_at
     and a.sleep_memory_dropped_at <= statement_timestamp() - interval '1 minute'
     and a.sleep_stored_at is null and a.sleep_store_job_id is null
     and a.sleep_unstore_requested_at is null and a.sleep_unstore_job_id is null
     and (a.sleep_store_tried_at is null or a.sleep_store_tried_at < s.armed_at)
     and (a.next_wake_at is null or (a.next_wake_at > statement_timestamp() + interval '10 minutes'
          and a.next_wake_at < s.expires_at - interval '5 minutes'))
     and not exists (select 1 from canary_qa_writer_private.scope w where w.owner_id=s.owner_id);
$$;

create function public.claim_hivra_canary_deep_hibernate_store(p_agent_id uuid,p_job_id uuid)
returns boolean
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id for update;
  if not found then return false; end if;
  perform 1 from hivra_deep_hibernate_qa_private.scope where agent_id=p_agent_id for share;
  if not found then return false; end if;
  perform 1 from public.hivra_computer_backups j where
    (j.id,j.agent_id,j.user_id,j.proxmox_host,j.vmid,j.kind,j.status)
      = (p_job_id,a.id,a.user_id,a.proxmox_host,a.vmid,'store','running') for share;
  if not found or not exists (select 1 from public.hivra_canary_deep_hibernate_candidate() c where c.id=a.id)
  then return false; end if;
  update public.hivra_agents set sleep_store_job_id=p_job_id,sleep_store_tried_at=clock_timestamp()
    where id=a.id;
  return true;
end;
$$;

revoke all on function public.hivra_canary_deep_hibernate_candidate(),
  public.claim_hivra_canary_deep_hibernate_store(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.hivra_canary_deep_hibernate_candidate(),
  public.claim_hivra_canary_deep_hibernate_store(uuid,uuid) to service_role;
