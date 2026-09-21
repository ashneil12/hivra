-- Read-only provider absence verification, not resource adoption or cleanup.
-- Keep the ambiguous purchase immutable after resolution; never backfill a
-- creation receipt or mark it as automatically deleted.
create table public.infrastructure_external_cleanup_resolutions (
  id uuid primary key,
  order_id uuid not null unique references public.infrastructure_capacity_orders(id) on delete restrict,
  user_id text not null,
  connection_id uuid not null,
  connection_revision bigint not null,
  idempotency_key uuid not null,
  original_state_sha256 text not null check (original_state_sha256 ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason = 'owner_confirmed_external_cleanup'),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, order_id, user_id, connection_id, connection_revision)
);
alter table public.infrastructure_external_cleanup_resolutions enable row level security;
revoke all on public.infrastructure_external_cleanup_resolutions from public, anon, authenticated, service_role;
grant select on public.infrastructure_external_cleanup_resolutions to service_role;

alter table public.infrastructure_capacity_orders
  add column external_cleanup_resolution_id uuid,
  add constraint infrastructure_capacity_external_resolution_fk
    foreign key (external_cleanup_resolution_id,id,user_id,connection_id,connection_revision)
    references public.infrastructure_external_cleanup_resolutions(id,order_id,user_id,connection_id,connection_revision),
  add constraint infrastructure_capacity_external_resolution_state check (
    external_cleanup_resolution_id is null or
    (status='ambiguous' and provider_creation_receipt is null
      and encrypted_bootstrap_bundle is null and bootstrap_key_version is null
      and provider_resource_id is not null and provider_ssh_key_id is not null
      and cleanup_idempotency_key is null)
  );

alter table public.infrastructure_capacity_orders
  drop constraint infrastructure_capacity_orders_secret_state_check,
  add constraint infrastructure_capacity_orders_secret_state_check check (
    (status = 'quoted' and active_connection_id is not null and idempotency_key is null
      and encrypted_bootstrap_bundle is null and bootstrap_key_version is null
      and bootstrap_public_key is null and bootstrap_public_key_fingerprint is null)
    or (status in ('creating', 'created_off', 'ambiguous', 'cleaning')
      and active_connection_id is not null and idempotency_key is not null
      and encrypted_bootstrap_bundle is not null and bootstrap_key_version = 2
      and bootstrap_public_key is not null and bootstrap_public_key_fingerprint is not null)
    or (status = 'provider_rejected' and active_connection_id is not null and idempotency_key is not null
      and server_post_attempted_at is null and encrypted_bootstrap_bundle is null and bootstrap_key_version is null)
    or (status = 'deleted' and idempotency_key is not null
      and encrypted_bootstrap_bundle is null and bootstrap_key_version is null)
    or (status not in ('quoted', 'cleaning') and active_connection_id is null and detached_at is not null
      and idempotency_key is not null and encrypted_bootstrap_bundle is null and bootstrap_key_version is null)
    or (external_cleanup_resolution_id is not null and status='ambiguous'
      and idempotency_key is not null and encrypted_bootstrap_bundle is null and bootstrap_key_version is null)
  );

drop index public.infrastructure_capacity_orders_one_capacity_idx;
create unique index infrastructure_capacity_orders_one_capacity_idx
  on public.infrastructure_capacity_orders(user_id)
  where external_cleanup_resolution_id is null and status <> 'deleted'
    and (status in ('creating','ambiguous','created_off','cleaning') or provider_ssh_key_id is not null);

create function public.hetzner_external_cleanup_eligible(o public.infrastructure_capacity_orders)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select (o.status='ambiguous' and o.active_connection_id=o.connection_id
    and o.external_cleanup_resolution_id is null and o.provider_creation_receipt is null
    and o.provider_resource_id is not null and o.provider_ssh_key_id is not null
    and o.provider_ssh_key_status='accepted' and o.provider_server_status='accepted'
    and o.server_post_attempted_at < clock_timestamp()-interval '120 seconds'
    and o.ssh_key_post_attempted_at < clock_timestamp()-interval '120 seconds'
    and o.cleanup_idempotency_key is null
    and not exists(select 1 from public.infrastructure_first_boot_operations where order_id=o.id)
    and not exists(select 1 from public.infrastructure_first_boot_enrollments
      where order_id=o.id and (enrolled_at is not null or host_public_key is not null))
    and not exists(select 1 from public.deployment_targets where provider_capacity_order_id=o.id
      or (connection_id=o.connection_id and external_id=o.provider_resource_id))
    and not exists(select 1 from public.hivra_agents where provider_capacity_order_id=o.id
      or (infrastructure_connection_id=o.connection_id and provider_server_id=o.provider_resource_id))) is true;
$$;

create function public.guard_hetzner_external_cleanup_resolution()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  raise exception 'External cleanup resolution is append-only' using errcode='55006';
end;
$$;
create trigger infrastructure_external_cleanup_immutable
  before update or delete on public.infrastructure_external_cleanup_resolutions
  for each row execute function public.guard_hetzner_external_cleanup_resolution();

create function public.guard_hetzner_resolved_order()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare allowed text[] := array['updated_at'];
begin
  if old.external_cleanup_resolution_id is not null then
    if tg_op='DELETE' then raise exception 'Resolved purchase evidence cannot be deleted' using errcode='55006'; end if;
    -- Disconnect may revoke the connection, but cannot change purchase history.
    if new.active_connection_id is null and new.detached_at is not null then
      allowed:=allowed||array['active_connection_id','detached_at'];
    end if;
    if (to_jsonb(old)-allowed) is distinct from (to_jsonb(new)-allowed) then
      raise exception 'Resolved purchase cannot be changed or reactivated' using errcode='55006';
    end if;
  elsif tg_op='UPDATE' and new.external_cleanup_resolution_id is not null then
    if not public.hetzner_external_cleanup_eligible(old) or not exists(
      select 1 from public.infrastructure_external_cleanup_resolutions r
      where r.id=new.external_cleanup_resolution_id and r.order_id=old.id
        and r.user_id=old.user_id and r.connection_id=old.connection_id
        and r.connection_revision=old.connection_revision
        and r.original_state_sha256=encode(sha256(convert_to(to_jsonb(old)::text,'UTF8')),'hex')
    ) or (to_jsonb(old)-array['external_cleanup_resolution_id','encrypted_bootstrap_bundle','bootstrap_key_version','updated_at'])
      is distinct from (to_jsonb(new)-array['external_cleanup_resolution_id','encrypted_bootstrap_bundle','bootstrap_key_version','updated_at']) then
      raise exception 'Resolution requires exact original state and ledger' using errcode='55006';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_capacity_resolved_guard
  before update or delete on public.infrastructure_capacity_orders
  for each row execute function public.guard_hetzner_resolved_order();

create or replace function public.guard_hetzner_deleted_inventory()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.infrastructure_capacity_orders
    where user_id=new.user_id and connection_id=new.connection_id
      and provider_resource_id=new.provider_resource_id
      and (status='deleted' or external_cleanup_resolution_id is not null)) then return null; end if;
  return new;
end;
$$;

-- No caller-supplied resource IDs or state digest are used for initial scope.
create function public.hetzner_external_cleanup_scope(p_user_id text,p_connection_id uuid,p_order_id uuid)
returns jsonb language sql security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object('orderId',o.id,'connectionId',o.connection_id,
    'revision',o.connection_revision,'serverId',o.provider_resource_id,'sshKeyId',o.provider_ssh_key_id,
    'serverName',o.server_name,'stateSha256',encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex'),
    'resolutionId',o.external_cleanup_resolution_id,'eligible',public.hetzner_external_cleanup_eligible(o))
  from public.infrastructure_capacity_orders o join public.infrastructure_connections c
    on c.id=o.active_connection_id and c.user_id=o.user_id and c.revision=o.connection_revision
  where o.id=p_order_id and o.user_id=p_user_id and o.connection_id=p_connection_id
    and c.provider='hetzner-cloud' and c.status='ready';
$$;

create function public.resolve_hetzner_external_cleanup(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,
  p_idempotency_key uuid,p_server_name text,p_state_sha256 text,p_evidence jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.infrastructure_capacity_orders%rowtype;
  r public.infrastructure_external_cleanup_resolutions%rowtype;
  observed timestamptz;
begin
  if p_idempotency_key is null then raise exception 'Missing resolution identity' using errcode='22023'; end if;
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and status='ready' and revision=p_revision for update;
  if not found then return jsonb_build_object('outcome','connection_changed'); end if;
  select * into o from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and connection_id=p_connection_id and active_connection_id=p_connection_id
    and connection_revision=p_revision for update;
  if not found then return jsonb_build_object('outcome','not_found'); end if;
  if o.server_name is distinct from p_server_name then return jsonb_build_object('outcome','confirmation_changed'); end if;
  if o.external_cleanup_resolution_id is not null then
    select * into r from public.infrastructure_external_cleanup_resolutions where id=o.external_cleanup_resolution_id;
    return jsonb_build_object('outcome',case when r.idempotency_key=p_idempotency_key then 'resolved' else 'confirmation_changed' end,
      'resolutionId',r.id,'resolvedAt',r.created_at);
  end if;
  if not public.hetzner_external_cleanup_eligible(o) then return jsonb_build_object('outcome','not_eligible'); end if;
  if p_state_sha256 is distinct from encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex') then
    return jsonb_build_object('outcome','state_changed');
  end if;
  if (jsonb_typeof(p_evidence)='object'
    and p_evidence ?& array['version','serverId','sshKeyId','observedAt','serverAbsent','sshKeyAbsent','projectServers','projectPrimaryIps']
    and p_evidence-array['version','serverId','sshKeyId','observedAt','serverAbsent','sshKeyAbsent','projectServers','projectPrimaryIps']='{}'::jsonb
    and p_evidence->'version'='1'::jsonb
    and p_evidence->'serverId'=to_jsonb(o.provider_resource_id)
    and p_evidence->'sshKeyId'=to_jsonb(o.provider_ssh_key_id)
    and p_evidence->'serverAbsent'='true'::jsonb and p_evidence->'sshKeyAbsent'='true'::jsonb
    and p_evidence->'projectServers'='0'::jsonb and p_evidence->'projectPrimaryIps'='0'::jsonb
    and jsonb_typeof(p_evidence->'observedAt')='string') is not true then
    raise exception 'Invalid external cleanup evidence' using errcode='22023';
  end if;
  observed:=(p_evidence->>'observedAt')::timestamptz;
  if observed < clock_timestamp()-interval '30 seconds' or observed > clock_timestamp()+interval '5 seconds' then
    return jsonb_build_object('outcome','evidence_expired');
  end if;
  insert into public.infrastructure_external_cleanup_resolutions(
    id,order_id,user_id,connection_id,connection_revision,idempotency_key,original_state_sha256,
    evidence,evidence_sha256,reason)
    values(gen_random_uuid(),o.id,o.user_id,o.connection_id,o.connection_revision,p_idempotency_key,p_state_sha256,
      p_evidence,encode(sha256(convert_to(p_evidence::text,'UTF8')),'hex'),'owner_confirmed_external_cleanup') returning * into r;
  update public.infrastructure_capacity_orders set external_cleanup_resolution_id=r.id,
    encrypted_bootstrap_bundle=null,bootstrap_key_version=null where id=o.id;
  -- The existing order trigger revokes any staged enrollment secret.
  delete from public.infrastructure_capacity_inventory where user_id=o.user_id
    and connection_id=o.connection_id and provider_resource_id=o.provider_resource_id;
  return jsonb_build_object('outcome','resolved','resolutionId',r.id,'resolvedAt',r.created_at);
end;
$$;

revoke all on function public.hetzner_external_cleanup_eligible(public.infrastructure_capacity_orders) from public,anon,authenticated;
revoke all on function public.guard_hetzner_external_cleanup_resolution() from public,anon,authenticated;
revoke all on function public.guard_hetzner_resolved_order() from public,anon,authenticated;
revoke all on function public.hetzner_external_cleanup_scope(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.resolve_hetzner_external_cleanup(text,uuid,bigint,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.hetzner_external_cleanup_eligible(public.infrastructure_capacity_orders) to service_role;
grant execute on function public.hetzner_external_cleanup_scope(text,uuid,uuid) to service_role;
grant execute on function public.resolve_hetzner_external_cleanup(text,uuid,bigint,uuid,uuid,text,text,jsonb) to service_role;

-- Resolved ambiguity no longer requires force-forget. Existing locks, all
-- unresolved claims, and credential revocation rules remain unchanged.
create or replace function public.delete_infrastructure_connection(
  p_user_id text,
  p_connection_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
  for update;

  if not found then return 'not_found'; end if;
  if v_connection.preflight_run_id is not null then return 'blocked'; end if;

  if v_connection.provider = 'hetzner-cloud' then
    -- Serialize against every attached order before deciding whether the
    -- credential can be revoked. `creating` and every post-attempt ambiguous
    -- outcome stay blocked here permanently; timestamp expiry is authority for
    -- bounded reconciliation, never authority for generic credential deletion.
    perform capacity_order.id
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
    order by capacity_order.id
    for update;

    if exists (
      select 1
      from public.infrastructure_capacity_orders as capacity_order
      where capacity_order.user_id = p_user_id
        and capacity_order.active_connection_id = p_connection_id
        and (
          capacity_order.status = 'creating'
          or capacity_order.provider_ssh_key_status = 'pending'
          or capacity_order.provider_server_status = 'pending'
          or (
            capacity_order.status = 'ambiguous'
            and (
              capacity_order.ssh_key_post_attempted_at
                >= now() - interval '60 seconds'
              or capacity_order.server_post_attempted_at
                >= now() - interval '60 seconds'
            )
          )
        )
    ) then
      return 'capacity_busy';
    end if;

    if exists (
      select 1
      from public.infrastructure_capacity_orders as capacity_order
      where capacity_order.user_id = p_user_id
        and capacity_order.active_connection_id = p_connection_id
        and capacity_order.external_cleanup_resolution_id is null
        and capacity_order.status = 'ambiguous'
        and (
          capacity_order.ssh_key_post_attempted_at is not null
          or capacity_order.server_post_attempted_at is not null
        )
    ) then
      return 'capacity_force_forget_required';
    end if;

    delete from public.infrastructure_capacity_orders
    where user_id = p_user_id
      and connection_id = p_connection_id
      and not exists (select 1 from public.infrastructure_first_boot_enrollments enrollment
        where enrollment.order_id = infrastructure_capacity_orders.id)
      and (
        status = 'quoted'
        or (
          status = 'provider_rejected'
          and provider_resource_id is null
          and provider_ssh_key_id is null
        )
      );

    update public.infrastructure_capacity_orders
    set active_connection_id = null,
        detached_at = now(),
        encrypted_bootstrap_bundle = null,
        bootstrap_key_version = null
    where user_id = p_user_id
      and connection_id = p_connection_id
      and active_connection_id = p_connection_id;
  end if;

  delete from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id;
  return 'deleted';
end;
$$;

create or replace function public.force_forget_hetzner_cloud_connection(
  p_user_id text,
  p_connection_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
  for update;

  if not found then return 'not_found'; end if;
  if v_connection.provider <> 'hetzner-cloud' then return 'invalid_provider'; end if;
  if v_connection.preflight_run_id is not null then return 'blocked'; end if;

  perform capacity_order.id
  from public.infrastructure_capacity_orders as capacity_order
  where capacity_order.user_id = p_user_id
    and capacity_order.active_connection_id = p_connection_id
  order by capacity_order.id
  for update;

  if exists (
    select 1
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
      and (
        capacity_order.status = 'creating'
        or capacity_order.provider_ssh_key_status = 'pending'
        or capacity_order.provider_server_status = 'pending'
        or (
          capacity_order.status = 'ambiguous'
          and greatest(
            coalesce(capacity_order.ssh_key_post_attempted_at, '-infinity'::timestamptz),
            coalesce(capacity_order.server_post_attempted_at, '-infinity'::timestamptz)
          ) >= now() - interval '60 seconds'
        )
      )
  ) then
    return 'capacity_busy';
  end if;

  if not exists (
    select 1
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
      and capacity_order.external_cleanup_resolution_id is null
        and capacity_order.status = 'ambiguous'
      and (
        capacity_order.ssh_key_post_attempted_at is not null
        or capacity_order.server_post_attempted_at is not null
      )
      and capacity_order.provider_ssh_key_status is distinct from 'pending'
      and capacity_order.provider_server_status is distinct from 'pending'
  ) then
    return 'not_ambiguous';
  end if;

  if exists (
    select 1
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
      and capacity_order.status not in ('quoted', 'ambiguous')
      and not (
        capacity_order.status = 'provider_rejected'
        and capacity_order.provider_resource_id is null
        and capacity_order.provider_ssh_key_id is null
      )
  ) then
    return 'not_ambiguous';
  end if;

  delete from public.infrastructure_capacity_orders
  where user_id = p_user_id
    and connection_id = p_connection_id
    and not exists (select 1 from public.infrastructure_first_boot_enrollments enrollment
      where enrollment.order_id = infrastructure_capacity_orders.id)
    and (
      status = 'quoted'
      or (
        status = 'provider_rejected'
        and provider_resource_id is null
        and provider_ssh_key_id is null
      )
    );

  update public.infrastructure_capacity_orders
  set active_connection_id = null,
      detached_at = now(),
      encrypted_bootstrap_bundle = null,
      bootstrap_key_version = null
  where user_id = p_user_id
    and connection_id = p_connection_id
    and active_connection_id = p_connection_id
    and status in ('ambiguous','provider_rejected');

  delete from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id;
  return 'forgotten';
end;
$$;
