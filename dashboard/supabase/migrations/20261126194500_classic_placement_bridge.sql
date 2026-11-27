create function managed_launch_bridge_private.check_classic_host(p_host_id text,p_workspace boolean)
returns void language plpgsql volatile set search_path=pg_catalog,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  if not exists(select 1 from public.proxmox_hosts where id=p_host_id) and (
      exists(select 1 from public.proxmox_hosts
        where public.holder_admission_normalize_host_id(id)=public.holder_admission_normalize_host_id(p_host_id))
      or (not p_workspace and exists(select 1 from public.proxmox_hosts))) then
    raise exception 'Classic placement requires the exact registered Proxmox host ID' using errcode='P0058';
  end if;
end;
$$;

create function public.insert_hermes_instance_bridge_v1(
  p_epoch text, p_row jsonb, p_cpu_overcommit_ratio numeric, p_skip_sleep boolean
)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_epoch text := managed_launch_bridge_private.lock_epoch();
  v_columns text;
  v_inserted jsonb;
  v_surface text := p_row->>'product_surface';
begin
  if p_epoch is distinct from v_epoch then
    return jsonb_build_object('status','bridge_phase_changed');
  end if;
  if jsonb_typeof(p_row) is distinct from 'object' or octet_length(p_row::text)>65536
    or coalesce(v_surface,'') not in ('hermesos','workspace_cloud')
    or jsonb_typeof(p_row->'user_id') is distinct from 'string'
    or length(btrim(p_row->>'user_id')) not between 1 and 256
    or p_row->>'status' is distinct from 'provisioning'
    or p_row->>'lifecycle_state' is distinct from 'provisioning'
    or coalesce(p_row->>'infrastructure_provider','') not in ('proxmox','hetzner')
    or (p_row->>'seat_funding' is not null and (v_surface<>'hermesos' or p_row->>'seat_funding'<>'paid'))
    or (v_epoch<>'legacy' and v_surface='hermesos' and p_row->>'seat_funding' is distinct from 'paid')
    or exists(select 1 from jsonb_object_keys(p_row) k where k not in (
      'user_id','name','subdomain','status','lifecycle_state','provider','api_key_encrypted',
      'api_key_preview','config','host_id','cpu_limit','ram_limit','disk_size_gb','resource_tier',
      'infrastructure_provider','backend','product_surface','honcho_api_key_encrypted','seat_funding','proxmox_node'
    )) then
    raise exception 'invalid Classic create request' using errcode='22023';
  end if;
  if (v_epoch='placement' and p_row->>'infrastructure_provider'='proxmox')
      is distinct from coalesce(btrim(p_row->>'proxmox_node')<>'',false) then
    raise exception 'invalid Classic create target' using errcode='22023';
  end if;
  if v_epoch='funding' and v_surface='hermesos' and p_row->>'infrastructure_provider'='proxmox' then
    perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
    if exists(select 1 from public.holder_admissions where state='admitted'
      and (reserved_cpu>0 or reserved_ram_mb>0)) then
      raise exception 'Classic placement is unavailable while holder capacity is reserved before the placement cut'
        using errcode='P0058';
    end if;
  end if;

  if v_epoch='placement' then
    if p_row->>'infrastructure_provider'='proxmox' then
      perform managed_launch_bridge_private.check_classic_host(p_row->>'proxmox_node',v_surface='workspace_cloud');
    end if;
    v_inserted := public.insert_hermes_instance(p_row,p_cpu_overcommit_ratio,p_skip_sleep);
  else
    p_row := p_row-'proxmox_node';
    if v_epoch='legacy' then p_row := p_row-'seat_funding'; end if;
    select string_agg(quote_ident(k),',' order by k) into v_columns
      from jsonb_object_keys(p_row) k;
    execute format('insert into public.hermes_instances(%s) select %s from jsonb_populate_record(null::public.hermes_instances,$1) returning to_jsonb(hermes_instances.*)',
      v_columns,v_columns) into v_inserted using p_row;
  end if;
  return jsonb_build_object('status','inserted','row',v_inserted);
end;
$$;

create table managed_launch_bridge_private.classic_start (
  instance_id uuid not null references public.hermes_instances(id) on delete cascade,
  operation_id uuid not null,
  user_id text not null,
  host_id text not null,
  vmid integer not null,
  outcome text check (outcome in ('started','not_started')),
  claimed_at timestamptz not null default now(),
  primary key (instance_id,operation_id)
);
create unique index classic_start_pending on managed_launch_bridge_private.classic_start(instance_id)
  where outcome is null;
revoke all on managed_launch_bridge_private.classic_start from public,anon,authenticated,service_role;

create function managed_launch_bridge_private.protect_classic_start()
returns trigger language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select 1 from managed_launch_bridge_private.classic_start
    where instance_id=old.id and outcome is null) then
    if tg_op='DELETE' or (
      (to_jsonb(new)-array['updated_at','name','config','last_accessed_at']) is distinct from
      (to_jsonb(old)-array['updated_at','name','config','last_accessed_at'])
    ) then
      raise exception 'Classic start outcome is still pending' using errcode='P0058';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger hermes_instances_guard_classic_start
  before update or delete on public.hermes_instances for each row
  execute function managed_launch_bridge_private.protect_classic_start();

create function public.claim_hermes_instance_start_bridge_v1(
  p_epoch text,p_instance_id uuid,p_user_id text,p_operation_id uuid,p_host_id text,p_vmid integer,
  p_cpu_overcommit_ratio numeric,p_skip_sleep boolean
)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_epoch text := managed_launch_bridge_private.lock_epoch();
  v_row public.hermes_instances%rowtype;
  v_receipt managed_launch_bridge_private.classic_start%rowtype;
begin
  if p_epoch is distinct from v_epoch then
    return jsonb_build_object('status','bridge_phase_changed');
  end if;
  if v_epoch<>'placement' or p_operation_id is null or coalesce(p_vmid,0)<=0 or nullif(btrim(p_host_id),'') is null then
    return jsonb_build_object('status','unavailable');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  select * into v_row from public.hermes_instances
    where id=p_instance_id and user_id=p_user_id for update;
  if not found or v_row.infrastructure_provider is distinct from 'proxmox'
    or v_row.proxmox_node is distinct from p_host_id or v_row.proxmox_vmid is distinct from p_vmid
    or v_row.seat_funding='holder' or v_row.paused_reason='holder_idle'
    or (v_row.lifecycle_substate is not null and v_row.lifecycle_substate<>'classic_start')
    or v_row.resize_operation_id is not null
    or v_row.deleted_at is not null or v_row.scheduled_deletion_at is not null then
    return jsonb_build_object('status','unavailable');
  end if;
  select * into v_receipt from managed_launch_bridge_private.classic_start
    where instance_id=p_instance_id and operation_id=p_operation_id;
  if found and (v_receipt.outcome='not_started' or v_receipt.user_id is distinct from p_user_id
    or v_receipt.host_id is distinct from p_host_id or v_receipt.vmid is distinct from p_vmid) then
    return jsonb_build_object('status','unavailable');
  end if;
  if exists(select 1 from managed_launch_bridge_private.classic_start
    where instance_id=p_instance_id and outcome is null) then
    return jsonb_build_object('status','pending');
  end if;
  if v_row.lifecycle_state='active' and v_row.status='running' then
    return jsonb_build_object('status','awake');
  end if;
  if v_receipt.operation_id is not null or v_row.lifecycle_substate is not null
    or v_row.lifecycle_state is distinct from 'paused'
    or v_row.status is distinct from 'stopped' then
    return jsonb_build_object('status','unavailable');
  end if;
  perform managed_launch_bridge_private.check_classic_host(p_host_id,coalesce(v_row.product_surface,'')='workspace_cloud');
  perform public.assert_proxmox_placement_capacity(
    p_host_id,p_user_id,coalesce(v_row.seat_funding,'paid'),v_row.cpu_limit,v_row.ram_limit,
    null,null,p_instance_id,p_cpu_overcommit_ratio,p_skip_sleep,
    coalesce(v_row.product_surface,'')='workspace_cloud',true
  );
  update public.hermes_instances set lifecycle_state='provisioning',status='provisioning',lifecycle_substate='classic_start',
    last_lifecycle_transition_at=now() where id=p_instance_id;
  insert into managed_launch_bridge_private.classic_start(instance_id,operation_id,user_id,host_id,vmid)
    values (p_instance_id,p_operation_id,p_user_id,p_host_id,p_vmid);
  return jsonb_build_object('status','claimed');
end;
$$;

create function public.finish_hermes_instance_start_bridge_v1(
  p_instance_id uuid,p_user_id text,p_operation_id uuid,p_outcome text
)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_row public.hermes_instances%rowtype;
  v_receipt managed_launch_bridge_private.classic_start%rowtype;
begin
  if managed_launch_bridge_private.lock_epoch()<>'placement'
    or coalesce(p_outcome,'') not in ('started','not_started','unknown') then
    return jsonb_build_object('status','unavailable');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  select * into v_row from public.hermes_instances
    where id=p_instance_id and user_id=p_user_id for update;
  if not found then return jsonb_build_object('status','unavailable'); end if;
  select * into v_receipt from managed_launch_bridge_private.classic_start
    where instance_id=p_instance_id and operation_id=p_operation_id and user_id=p_user_id;
  if not found or v_row.proxmox_node is distinct from v_receipt.host_id
    or v_row.proxmox_vmid is distinct from v_receipt.vmid then
    return jsonb_build_object('status','unavailable');
  end if;
  if v_receipt.outcome is not null then
    if v_receipt.outcome=p_outcome and p_outcome='not_started' then
      return jsonb_build_object('status','released');
    end if;
    if v_receipt.outcome=p_outcome and p_outcome='started' and v_row.lifecycle_state='active' then
      return jsonb_build_object('status','awake');
    end if;
    return jsonb_build_object('status','unavailable');
  end if;
  if v_row.lifecycle_state is distinct from 'provisioning' or v_row.status is distinct from 'provisioning'
    or v_row.lifecycle_substate is distinct from 'classic_start' then
    return jsonb_build_object('status','unavailable');
  end if;
  if p_outcome='unknown' then return jsonb_build_object('status','pending'); end if;
  update managed_launch_bridge_private.classic_start set outcome=p_outcome
    where instance_id=p_instance_id and operation_id=p_operation_id;
  if p_outcome='not_started' then
    update public.hermes_instances set lifecycle_state='paused',status='stopped',lifecycle_substate=null,
      last_lifecycle_transition_at=now() where id=p_instance_id;
    return jsonb_build_object('status','released');
  end if;
  update public.hermes_instances set lifecycle_state='active',status='running',paused_reason=null,lifecycle_substate=null,
    last_lifecycle_transition_at=now() where id=p_instance_id;
  return jsonb_build_object('status','awake');
end;
$$;

revoke all on function managed_launch_bridge_private.protect_classic_start(),
  managed_launch_bridge_private.check_classic_host(text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.insert_hermes_instance_bridge_v1(text,jsonb,numeric,boolean),
  public.claim_hermes_instance_start_bridge_v1(text,uuid,text,uuid,text,integer,numeric,boolean),
  public.finish_hermes_instance_start_bridge_v1(uuid,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.insert_hermes_instance_bridge_v1(text,jsonb,numeric,boolean),
  public.claim_hermes_instance_start_bridge_v1(text,uuid,text,uuid,text,integer,numeric,boolean),
  public.finish_hermes_instance_start_bridge_v1(uuid,text,uuid,text) to service_role;
