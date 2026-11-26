-- A QA seat is an ordinary managed holder computer with a separate, immutable
-- test deadline. It is never a wallet qualification or a durable queue entry.
alter table public.hivra_agents add column canary_qa_holder_expires_at timestamptz;

create unique index hivra_agents_one_canary_qa_holder
  on public.hivra_agents ((true))
  where canary_qa_holder_expires_at is not null and status <> 'deleted';

create or replace function public.holder_admission_current_tier(p_user_id text)
returns text
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select case
      when bool_or(q.tier = 'power') then 'power'
      when count(*) > 0 then 'pro'
      when nullif(current_setting('hivra.canary_qa_holder_validation_owner',true),'') = p_user_id then 'pro'
      else null
    end
  from public.token_tier_qualifications q
  where q.user_id = p_user_id
    and q.tier in ('pro','power')
    and q.last_suspend_at is null
    and (
      q.currently_eligible
      or (q.last_breach_at is not null and q.last_breach_at >= now() - interval '24 hours')
    )
    and public.token_tier_row_counts_for_user(q.user_id, coalesce(q.token_key, 'hermesos'), now());
$$;

-- Count an allocated QA seat against the same holder ceiling without putting
-- the standing account into the real holder queue.
create or replace function public.holder_admission_cohort_usage()
returns table(user_id text, cpu numeric, ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with users as (
    select a.user_id, case when a.state='admitted' then a.reserved_cpu else 0 end reserved_cpu,
           case when a.state='admitted' then a.reserved_ram_mb else 0 end reserved_ram_mb
    from public.holder_admissions a
    union all
    select g.user_id, 0, 0
    from public.hivra_agents g
    where g.canary_qa_holder_expires_at is not null and g.status <> 'deleted'
      and not exists (select 1 from public.holder_admissions a where a.user_id=g.user_id)
  )
  select c.user_id,
         greatest(coalesce(u.cpu, 0), c.reserved_cpu)::numeric,
         greatest(coalesce(u.ram_mb, 0), c.reserved_ram_mb)::numeric
  from users c
  left join public.holder_admission_existing_usage(c.user_id) u on true;
$$;

create function public.canary_qa_holder_validation_backing(p_owner text, p_host text)
returns void
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('holder-seat-funding-v1:' || p_owner,0));
  insert into public.holder_admissions(
    user_id,state,tier,admitted_at,assigned_host_id,reserved_cpu,reserved_ram_mb
  ) values (p_owner,'admitted','pro',now(),p_host,2,4096)
  on conflict (user_id) do nothing;
  if not found then
    raise exception 'Canary holder QA cannot replace a normal admission' using errcode='P0057';
  end if;
  perform set_config('hivra.canary_qa_holder_validation_owner',p_owner,true);
end;
$$;

create function public.canary_qa_holder_validation_clear(p_owner text)
returns void
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
begin
  if current_setting('hivra.canary_qa_holder_validation_owner',true) = p_owner then
    delete from public.holder_admissions where user_id=p_owner;
    perform set_config('hivra.canary_qa_holder_validation_owner','',true);
  end if;
end;
$$;

create function public.enforce_canary_qa_holder_seat()
returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_new_claim boolean;
begin
  if tg_op='UPDATE' and new.canary_qa_holder_expires_at is distinct from old.canary_qa_holder_expires_at then
    raise exception 'Canary holder QA provenance is immutable' using errcode='P0057';
  end if;
  if new.canary_qa_holder_expires_at is null then
    if new.seat_funding='holder'
      and current_setting('hivra.canary_qa_holder_validation_owner',true) = new.user_id then
      raise exception 'Canary holder QA backing is seat-specific' using errcode='P0057';
    end if;
    return new;
  end if;

  if tg_op='INSERT' then
    if nullif(current_setting('hivra.canary_qa_holder_insert_id',true),'') is distinct from new.id::text then
      raise exception 'Canary holder QA requires its dedicated admission' using errcode='P0057';
    end if;
    return new;
  end if;

  if row(new.id,new.user_id,new.seat_funding,new.deployment_mode,new.proxmox_host,
         new.cpu,new.ram,new.cpu_max,new.ram_max)
     is distinct from
     row(old.id,old.user_id,old.seat_funding,old.deployment_mode,old.proxmox_host,
         old.cpu,old.ram,old.cpu_max,old.ram_max)
     or new.operation_kind='resize' then
    raise exception 'Canary holder QA seat and allocation are fixed' using errcode='P0057';
  end if;

  v_new_claim := new.operation_kind in ('start','restart')
    and row(new.operation_id,new.operation_kind) is distinct from row(old.operation_id,old.operation_kind);
  if v_new_claim or (old.status not in ('running','provisioning') and new.status in ('running','provisioning')
     and coalesce(old.operation_kind,'') not in ('start','restart')) then
    if old.status='deleted' or new.canary_qa_holder_expires_at <= clock_timestamp() then
      raise exception 'Canary holder QA admission expired' using errcode='P0057';
    end if;
    if public.holder_admission_current_tier(new.user_id) is null then
      perform public.canary_qa_holder_validation_backing(new.user_id,new.proxmox_host);
    end if;
  elsif old.status not in ('running','provisioning','stopped') and new.status='stopped' then
    -- The reviewed funding trigger validates this status as allocated even
    -- when it is a corrective stop. Never prevent shutdown for expired QA.
    if public.holder_admission_current_tier(new.user_id) is null then
      perform public.canary_qa_holder_validation_backing(new.user_id,new.proxmox_host);
    end if;
  end if;
  return new;
end;
$$;

create function public.clear_canary_qa_holder_seat_validation()
returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
begin
  if new.canary_qa_holder_expires_at is not null then
    perform public.canary_qa_holder_validation_clear(new.user_id);
  end if;
  return null;
end;
$$;

create trigger hivra_agents_canary_qa_holder
before insert or update on public.hivra_agents
for each row execute function public.enforce_canary_qa_holder_seat();

create trigger hivra_agents_clear_canary_qa_holder_validation
after update on public.hivra_agents
for each row when (new.canary_qa_holder_expires_at is not null)
execute function public.clear_canary_qa_holder_seat_validation();

-- Only the authenticated server's exact Canary/name/owner/expiry gate calls
-- this RPC. The slot, placement and funding writers remain unchanged; the
-- temporary backing exists only inside their transaction and is never exposed
-- as an admission, waitlist entry or qualification.
create function public.insert_canary_qa_holder_agent(
  p_row jsonb, p_expires_at timestamptz, p_target_host_ids text[],
  p_cpu_overcommit_ratio numeric, p_skip_sleep boolean
)
returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,pg_temp
as $$
declare
  v_owner text := p_row->>'user_id';
  v_host text;
  v_id uuid := gen_random_uuid();
  v_capacity record;
  v_used record;
  v_result jsonb;
begin
  if jsonb_typeof(p_row) is distinct from 'object'
    or v_owner is null or v_owner !~ '^user_[A-Za-z0-9]+$'
    or p_expires_at is null or p_expires_at <= clock_timestamp()
    or p_expires_at > clock_timestamp() + interval '24 hours'
    or p_row->>'name' is distinct from 'Canary holder QA'
    or p_row->>'type' is distinct from 'hermes'
    or p_row->>'deployment_mode' is distinct from 'hivra-managed'
    or p_row->>'computer_substrate' is distinct from 'proxmox-kvm'
    or p_row->>'seat_funding' is distinct from 'holder'
    or p_row->>'status' is distinct from 'provisioning'
    or p_row->>'operation_kind' is distinct from 'provision'
    or (p_row->>'cpu')::numeric is distinct from 2::numeric
    or (p_row->>'ram')::integer is distinct from 4
    or (p_row->>'cpu_max')::numeric is distinct from 2::numeric
    or (p_row->>'ram_max')::integer is distinct from 4
    or p_row->>'llm_config' is not null or p_row->>'llm_api_key_encrypted' is not null
    or coalesce((p_row->>'managed_venice')::boolean,false)
    or p_row->>'pool_id' is not null or p_row->>'vmid' is not null
    or p_row->>'infrastructure_connection_id' is not null or p_row->>'deployment_target_id' is not null
  then
    return jsonb_build_object('status','invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  perform public.lock_hivra_owner_agent_slots(v_owner);
  if public.holder_admission_current_tier(v_owner) is not null
    or exists(select 1 from public.holder_admissions where user_id=v_owner)
    or exists(select 1 from public.hivra_agents
              where canary_qa_holder_expires_at is not null and status <> 'deleted')
    or exists(
      select 1 from public.token_tier_qualifications q
      where q.currently_eligible and q.last_suspend_at is null and q.tier in ('pro','power')
        and public.token_tier_row_counts_for_user(q.user_id,coalesce(q.token_key,'hermesos'),now())
        and not exists(select 1 from public.holder_admissions a
                       where a.user_id=q.user_id and a.state='admitted')
    )
  then
    raise exception 'Canary holder QA slot unavailable' using errcode='P0057';
  end if;

  select sum(h.cpu) cpu,sum(h.ram_mb) ram_mb into v_capacity
    from public.holder_admission_host_capacity(p_target_host_ids,p_cpu_overcommit_ratio) h;
  select coalesce(sum(u.cpu),0) cpu,coalesce(sum(u.ram_mb),0) ram_mb into v_used
    from public.holder_admission_cohort_usage() u;
  select case when count(*)=1 then min(h.host_id) end into v_host
    from public.holder_admission_host_capacity(p_target_host_ids,p_cpu_overcommit_ratio) h
    where public.normalize_proxmox_capacity_scope_id(h.host_id)
        = public.normalize_proxmox_capacity_scope_id(p_row->>'proxmox_host');
  if v_used.cpu + 2 > coalesce(v_capacity.cpu,0)*0.2
    or v_used.ram_mb + 4096 > coalesce(v_capacity.ram_mb,0)*0.2
    or v_host is null
    or public.holder_admission_fit_host(array[v_host],p_cpu_overcommit_ratio,p_skip_sleep,
        '{"defaultDiskGb":40}'::jsonb,v_owner,2,4096) is distinct from v_host
  then
    raise exception 'Canary holder QA seat does not fit holder capacity' using errcode='P0057';
  end if;
  if p_expires_at <= clock_timestamp() then
    raise exception 'Canary holder QA admission expired' using errcode='P0057';
  end if;

  perform public.canary_qa_holder_validation_backing(v_owner,v_host);
  perform set_config('hivra.canary_qa_holder_insert_id',v_id::text,true);
  v_result := public.insert_hivra_managed_agent(
    p_row || jsonb_build_object('id',v_id,'canary_qa_holder_expires_at',p_expires_at),
    1,p_cpu_overcommit_ratio,p_skip_sleep
  );
  perform set_config('hivra.canary_qa_holder_insert_id','',true);
  perform public.canary_qa_holder_validation_clear(v_owner);
  return v_result;
end;
$$;

revoke all on function public.canary_qa_holder_validation_backing(text,text),
  public.canary_qa_holder_validation_clear(text), public.enforce_canary_qa_holder_seat(),
  public.clear_canary_qa_holder_seat_validation(),
  public.insert_canary_qa_holder_agent(jsonb,timestamptz,text[],numeric,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.insert_canary_qa_holder_agent(jsonb,timestamptz,text[],numeric,boolean) to service_role;
