-- Extend the existing cleanup lifecycle to own the first-boot firewall too.
-- No public preparation/agent placement is enabled by this migration.
alter table public.infrastructure_capacity_orders add column cleanup_firewall_receipt jsonb;

create or replace function public.is_valid_hetzner_cleanup_firewall_receipt(p_receipt jsonb,p_order uuid,p_quote text,p_server text)
returns boolean language plpgsql immutable set search_path=public,pg_temp as $$
begin
  return public.is_valid_first_boot_firewall_receipt(p_receipt,p_order,
    (p_receipt#>>'{scope,attemptId}')::uuid,p_quote,p_server);
exception when others then return false;
end;
$$;
alter table public.infrastructure_capacity_orders add constraint infrastructure_capacity_orders_cleanup_firewall_check check (
  cleanup_firewall_receipt is null or public.is_valid_hetzner_cleanup_firewall_receipt(
    cleanup_firewall_receipt,id,quote_fingerprint_sha256,provider_resource_id) is true
);

create or replace function public.is_valid_hetzner_cleanup_absence(p_absence jsonb,p_has_firewall boolean)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_absence)='object' and p_has_firewall is not null
    and p_absence ?& array['server','ipv4','ipv6','sshKey']
    and (p_absence ? 'firewall')=p_has_firewall
    and p_absence-array['server','ipv4','ipv6','sshKey','firewall']='{}'::jsonb
    and not exists(select 1 from jsonb_each(p_absence) e where jsonb_typeof(e.value)<>'boolean')) is true;
$$;

alter table public.infrastructure_capacity_orders
  drop constraint infrastructure_capacity_orders_cleanup_state_check,
  add constraint infrastructure_capacity_orders_cleanup_state_check check (
    (status not in ('cleaning','deleted','cleanup_abandoned') and cleanup_idempotency_key is null
      and cleanup_resource_fingerprint is null and cleanup_lease_id is null
      and cleanup_lease_expires_at is null and cleanup_absence is null and cleanup_firewall_receipt is null
      and cleanup_last_error is null and cleanup_started_at is null and cleanup_observed_at is null
      and cleanup_finished_at is null and cleanup_abandoned_at is null)
    or ((status in ('cleaning','deleted','cleanup_abandoned') and cleanup_idempotency_key is not null
      and cleanup_resource_fingerprint ~ '^[0-9a-f]{64}$' and cleanup_started_at is not null
      and provider_creation_receipt is not null and provider_ssh_key_id is not null and provider_ssh_key_status='accepted'
      and public.is_valid_hetzner_cleanup_absence(cleanup_absence,cleanup_firewall_receipt is not null)
      and (cleanup_lease_id is null)=(cleanup_lease_expires_at is null)
      and (cleanup_last_error is null or cleanup_last_error in ('resource_changed','resource_busy','provider_unavailable','connection_changed'))
      and ((status='cleaning' and cleanup_finished_at is null and cleanup_abandoned_at is null)
        or (status='deleted' and cleanup_finished_at is not null and cleanup_observed_at is not null
          and cleanup_lease_id is null and cleanup_last_error is null and cleanup_abandoned_at is null
          and cleanup_absence @> '{"server":true,"ipv4":true,"ipv6":true,"sshKey":true}'::jsonb
          and (cleanup_firewall_receipt is null or cleanup_absence->'firewall'='true'::jsonb))
        or (status='cleanup_abandoned' and cleanup_finished_at is null and cleanup_abandoned_at is not null
          and active_connection_id is null and detached_at is not null and cleanup_lease_id is null
          and encrypted_bootstrap_bundle is null and bootstrap_key_version is null))) is true)
  );

-- Existing order/receipt guards still freeze the copied manifest once cleanup
-- starts. The only path past the preparation guard is the same lease-protected
-- cleanup transition, carrying the exact original firewall receipt.
create or replace function public.guard_first_boot_operation_order()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_operation public.infrastructure_first_boot_operations%rowtype;
begin
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=old.id;
  if not found then
    if tg_op='DELETE' then return old; end if;
    if new.cleanup_firewall_receipt is not null then
      raise exception 'No owned first-boot firewall' using errcode='55006'; end if;
    return new;
  end if;
  if tg_op='DELETE' then raise exception 'Retain first-boot resource evidence' using errcode='55006'; end if;
  if new.status in ('cleaning','deleted','cleanup_abandoned') then
    if v_operation.lease_expires_at>clock_timestamp() then
      raise exception 'First-boot setup is still leased' using errcode='55006'; end if;
    if v_operation.firewall_post_attempted_at is not null and (v_operation.firewall_receipt is null
      or new.cleanup_firewall_receipt is distinct from v_operation.firewall_receipt) then
      raise exception 'First-boot firewall requires complete resource cleanup' using errcode='55006'; end if;
    if v_operation.firewall_post_attempted_at is null and new.cleanup_firewall_receipt is not null then
      raise exception 'No owned first-boot firewall' using errcode='55006'; end if;
    if old.status='created_off' and (new.status<>'cleaning' or new.cleanup_lease_id is null
      or new.cleanup_lease_expires_at<=clock_timestamp()) then
      raise exception 'First-boot cleanup requires an owned lease' using errcode='55006'; end if;
    return new;
  end if;
  if v_operation.abandoned_at is null
    and (v_operation.lease_expires_at>clock_timestamp() or v_operation.firewall_post_attempted_at is not null)
    and (to_jsonb(old)-array['updated_at','provider_observed_at','observed_server_status','last_error_code'])
      is distinct from (to_jsonb(new)-array['updated_at','provider_observed_at','observed_server_status','last_error_code']) then
    raise exception 'First-boot setup owns the capacity order' using errcode='55006'; end if;
  return new;
end;
$$;

create or replace function public.first_boot_retains_connection(p_connection uuid)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select exists(select 1 from public.infrastructure_first_boot_operations f
    join public.infrastructure_capacity_orders o on o.id=f.order_id
    where f.connection_id=p_connection and f.abandoned_at is null
      and o.status not in ('deleted','cleanup_abandoned')
      and (f.lease_expires_at>clock_timestamp() or f.firewall_post_attempted_at is not null));
$$;
create or replace function public.guard_first_boot_operation_connection()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if public.first_boot_retains_connection(old.id) and (tg_op='DELETE'
    or (to_jsonb(old)-array['updated_at','last_checked_at','last_error_code','status'])
      is distinct from (to_jsonb(new)-array['updated_at','last_checked_at','last_error_code','status'])) then
    raise exception 'Finish or explicitly abandon first-boot setup before disconnecting' using errcode='55006'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create or replace function public.guard_first_boot_operation_secret()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  perform id from public.infrastructure_connections where id=old.connection_id for update;
  if public.first_boot_retains_connection(old.connection_id) then
    raise exception 'First-boot setup retains provider access' using errcode='55006'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.claim_hetzner_cleanup_with_firewall(
  p_user_id text,p_connection_id uuid,p_expected_revision bigint,p_order_id uuid,
  p_idempotency_key uuid,p_lease_id uuid,p_fingerprint text,p_server_name text,p_expected_firewall_receipt jsonb
)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;
  v_boot public.infrastructure_first_boot_operations%rowtype;
  v_firewall jsonb;
begin
  if p_idempotency_key is null or p_lease_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid cleanup claim' using errcode='22023'; end if;
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and status='ready' and revision=p_expected_revision for update;
  if not found then return jsonb_build_object('outcome','connection_changed'); end if;
  select * into v_order from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and connection_id=p_connection_id and active_connection_id=p_connection_id and connection_revision=p_expected_revision for update;
  if not found then return jsonb_build_object('outcome','not_found'); end if;
  if v_order.server_name is distinct from p_server_name or v_order.provider_creation_receipt is null
    or v_order.provider_ssh_key_id is null or v_order.status not in ('created_off','cleaning','deleted') then
    return jsonb_build_object('outcome','not_eligible'); end if;
  if v_order.cleanup_idempotency_key is not null and (v_order.cleanup_idempotency_key is distinct from p_idempotency_key
    or v_order.cleanup_resource_fingerprint is distinct from p_fingerprint) then
    return jsonb_build_object('outcome','confirmation_changed'); end if;
  if v_order.status='deleted' then return jsonb_build_object('outcome','complete','order',to_jsonb(v_order)); end if;
  if v_order.cleanup_lease_expires_at>clock_timestamp() then
    return jsonb_build_object('outcome','busy','order',to_jsonb(v_order)); end if;
  perform order_id from public.infrastructure_first_boot_enrollments where order_id=p_order_id for update;
  select * into v_boot from public.infrastructure_first_boot_operations where order_id=p_order_id for update;
  if found then
    if v_boot.lease_expires_at>clock_timestamp() then
      return jsonb_build_object('outcome','busy','order',to_jsonb(v_order)); end if;
    if v_boot.firewall_post_attempted_at is not null then
      if v_boot.firewall_receipt is null then return jsonb_build_object('outcome','not_eligible'); end if;
      v_firewall:=v_boot.firewall_receipt;
    end if;
  end if;
  -- The preview may precede a setup worker's receipt checkpoint. Never freeze
  -- an old four-resource fingerprint around a newly created fifth resource.
  if v_firewall is distinct from p_expected_firewall_receipt then
    return jsonb_build_object('outcome','confirmation_changed'); end if;
  -- This is capacity cleanup, not agent deletion. Prepared launch targets need
  -- their target-aware lifecycle first. No other computer in a project may be
  -- disabled/deleted as a side effect of removing unused capacity.
  if exists(select 1 from public.deployment_targets where connection_id=p_connection_id) then
    return jsonb_build_object('outcome','target_in_use'); end if;
  update public.infrastructure_capacity_orders set status='cleaning',cleanup_idempotency_key=p_idempotency_key,
    cleanup_resource_fingerprint=p_fingerprint,cleanup_firewall_receipt=v_firewall,
    cleanup_lease_id=p_lease_id,cleanup_lease_expires_at=clock_timestamp()+interval '120 seconds',
    cleanup_started_at=coalesce(cleanup_started_at,clock_timestamp()),
    cleanup_absence=coalesce(cleanup_absence,'{"server":false,"ipv4":false,"ipv6":false,"sshKey":false}'::jsonb
      || case when v_firewall is null then '{}'::jsonb else '{"firewall":false}'::jsonb end)
    where id=p_order_id returning * into v_order;
  return jsonb_build_object('outcome','claimed','order',to_jsonb(v_order));
end;
$$;

-- Preserve the deployed four-resource caller during the schema-first rollout.
-- It has never obtained confirmation for a firewall and must fail closed if
-- setup acquired one while the browser was reviewing the old resource set.
create or replace function public.claim_hetzner_cleanup(
  p_user_id text,p_connection_id uuid,p_expected_revision bigint,p_order_id uuid,
  p_idempotency_key uuid,p_lease_id uuid,p_fingerprint text,p_server_name text
)
returns jsonb language sql security invoker set search_path=public,pg_temp as $$
  select public.claim_hetzner_cleanup_with_firewall(p_user_id,p_connection_id,p_expected_revision,
    p_order_id,p_idempotency_key,p_lease_id,p_fingerprint,p_server_name,null);
$$;

create or replace function public.record_hetzner_cleanup_observation(
  p_user_id text,p_connection_id uuid,p_expected_revision bigint,p_order_id uuid,p_lease_id uuid,p_absence jsonb,p_error text
)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;v_complete boolean;
begin
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and revision=p_expected_revision for update;
  if not found then return null; end if;
  select * into v_order from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and active_connection_id=p_connection_id and connection_revision=p_expected_revision and status='cleaning'
    and cleanup_lease_id=p_lease_id and cleanup_lease_expires_at>clock_timestamp() for update;
  if not found then return null; end if;
  if not public.is_valid_hetzner_cleanup_absence(p_absence,v_order.cleanup_firewall_receipt is not null) then
    raise exception 'Incomplete cleanup resource set' using errcode='22023'; end if;
  v_complete:=p_error is null and not exists(select 1 from jsonb_each(p_absence) e where e.value<>'true'::jsonb);
  update public.infrastructure_capacity_orders set cleanup_absence=p_absence,cleanup_last_error=p_error,
    cleanup_observed_at=clock_timestamp(),cleanup_lease_id=null,cleanup_lease_expires_at=null,
    status=case when v_complete then 'deleted' else 'cleaning' end,
    encrypted_bootstrap_bundle=case when v_complete then null else encrypted_bootstrap_bundle end,
    bootstrap_key_version=case when v_complete then null else bootstrap_key_version end,
    cleanup_finished_at=case when v_complete then clock_timestamp() else null end
    where id=p_order_id returning * into v_order;
  if v_complete then delete from public.infrastructure_capacity_inventory where user_id=p_user_id
    and connection_id=p_connection_id and provider_resource_id=v_order.provider_resource_id; end if;
  return to_jsonb(v_order);
end;
$$;

-- Serialize target publication with the same connection lock used by cleanup.
-- Existing target refreshes cannot create launch authority while deletion owns
-- any capacity in that connection. Future direct-node publication must also
-- prove its exact order is still live under this lock.
create or replace function public.guard_hetzner_cleanup_target_publication()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  perform id from public.infrastructure_connections where id=new.connection_id for update;
  if exists(select 1 from public.infrastructure_capacity_orders where active_connection_id=new.connection_id and status='cleaning') then
    raise exception 'Capacity cleanup owns this connection' using errcode='55006'; end if;
  return new;
end;
$$;
create trigger deployment_targets_hetzner_cleanup_guard before insert or update on public.deployment_targets
  for each row execute function public.guard_hetzner_cleanup_target_publication();

revoke all on function public.is_valid_hetzner_cleanup_absence(jsonb,boolean) from public,anon,authenticated;
revoke all on function public.is_valid_hetzner_cleanup_firewall_receipt(jsonb,uuid,text,text) from public,anon,authenticated;
revoke all on function public.first_boot_retains_connection(uuid) from public,anon,authenticated;
revoke all on function public.guard_hetzner_cleanup_target_publication() from public,anon,authenticated;
revoke all on function public.claim_hetzner_cleanup_with_firewall(text,uuid,bigint,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.is_valid_hetzner_cleanup_absence(jsonb,boolean) to service_role;
grant execute on function public.is_valid_hetzner_cleanup_firewall_receipt(jsonb,uuid,text,text) to service_role;
grant execute on function public.first_boot_retains_connection(uuid) to service_role;
grant execute on function public.claim_hetzner_cleanup_with_firewall(text,uuid,bigint,uuid,uuid,uuid,text,text,jsonb) to service_role;
