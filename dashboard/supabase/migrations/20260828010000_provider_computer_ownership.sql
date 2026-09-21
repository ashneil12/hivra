-- Exclusive provider computers use the existing agent/operation lifecycle.
-- This is schema-first support, not public launch activation or guest readiness.
alter table public.deployment_targets
  add column provider_capacity_order_id uuid references public.infrastructure_capacity_orders(id),
  add column provider_retired_at timestamptz,
  drop constraint deployment_targets_supported_isolation_drivers_check,
  add constraint deployment_targets_supported_isolation_drivers_check
    check (supported_isolation_drivers <@ array['proxmox-kvm','provider-vm']::text[]),
  drop constraint deployment_targets_isolation_class_check,
  add constraint deployment_targets_isolation_class_check
    check (isolation_class in ('hardware-vm','provider-vm'));
create unique index deployment_targets_provider_order_unique
  on public.deployment_targets(provider_capacity_order_id)
  where provider_capacity_order_id is not null;

alter table public.hivra_agents
  add column computer_substrate text not null default 'proxmox-kvm'
    check (computer_substrate in ('proxmox-kvm','provider-vm')),
  add column provider_capacity_order_id uuid references public.infrastructure_capacity_orders(id),
  add column provider_enrollment_attempt_id uuid references public.infrastructure_first_boot_enrollments(attempt_id),
  add column provider_server_id text,
  add constraint hivra_agents_provider_identity_check check ((
    (computer_substrate='proxmox-kvm' and provider_capacity_order_id is null
      and provider_enrollment_attempt_id is null and provider_server_id is null)
    or (computer_substrate='provider-vm' and deployment_mode='self-managed' and vmid is null
      and provider_capacity_order_id is not null and provider_enrollment_attempt_id is not null
      and provider_server_id ~ '^[1-9][0-9]{0,15}$'
      and provider_server_id::numeric <= 9007199254740991)
  ) is true);
-- A deleted provider computer cannot be recycled into another agent: deletion
-- removes the entire server. Retain its order identity on the tombstone.
create unique index hivra_agents_provider_order_unique
  on public.hivra_agents(provider_capacity_order_id)
  where provider_capacity_order_id is not null;
create unique index hivra_agents_provider_target_unique
  on public.hivra_agents(deployment_target_id)
  where computer_substrate='provider-vm' and status<>'deleted';

-- Access revocation and terminal row erasure both require this same original
-- five-resource absence receipt. A null VMID is never a provider delete proof.
create or replace function public.hivra_provider_cleanup_verified(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
  select exists(select 1 from public.hivra_agents a
    join public.infrastructure_capacity_orders o on o.id=a.provider_capacity_order_id
    join public.deployment_targets t on t.id=a.deployment_target_id
    where a.id=p_agent_id and a.user_id=p_user_id and a.computer_substrate='provider-vm'
      and a.status<>'deleted' and a.desired_state='deleted' and a.operation_id=p_operation_id
      and a.operation_kind in ('delete','provision')
      and o.user_id=a.user_id and o.connection_id=a.infrastructure_connection_id
      and o.connection_revision=a.infrastructure_connection_revision and o.provider_resource_id=a.provider_server_id
      and o.status='deleted' and o.cleanup_finished_at is not null and o.cleanup_last_error is null
      and o.cleanup_firewall_receipt is not null
      and o.cleanup_absence='{"server":true,"ipv4":true,"ipv6":true,"sshKey":true,"firewall":true}'::jsonb
      and t.provider_capacity_order_id=o.id and t.provider_retired_at is not null);
$$;

-- Keep the existing Proxmox authority checks unchanged. The provider guard
-- below also sees downgrades and deletes, so changing the discriminator cannot
-- turn an existing provider row into managed/Proxmox authority.
drop trigger hivra_agents_deployment_authority_guard on public.hivra_agents;
create trigger hivra_agents_deployment_authority_guard
  before insert or update of user_id,status,deployment_mode,infrastructure_connection_id,
    deployment_target_id,infrastructure_connection_revision,proxmox_host,computer_substrate
  on public.hivra_agents for each row when (new.computer_substrate='proxmox-kvm')
  execute function public.enforce_hivra_agent_deployment_authority();

create or replace function public.guard_hivra_provider_agent()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;
  v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
  v_boot public.infrastructure_first_boot_operations%rowtype;
  v_target public.deployment_targets%rowtype;
begin
  if tg_op<>'INSERT' and old.computer_substrate='provider-vm' then
    if tg_op='DELETE' then
      raise exception 'Retain provider computer ownership evidence' using errcode='55006'; end if;
    if row(new.id,new.user_id,new.computer_substrate,new.deployment_mode,new.proxmox_host,
        new.provider_capacity_order_id,new.provider_enrollment_attempt_id,new.provider_server_id,
        new.infrastructure_binding_token_hash,new.infrastructure_binding_token_enforced)
      is distinct from row(old.id,old.user_id,old.computer_substrate,old.deployment_mode,old.proxmox_host,
        old.provider_capacity_order_id,old.provider_enrollment_attempt_id,old.provider_server_id,
        old.infrastructure_binding_token_hash,old.infrastructure_binding_token_enforced) then
      raise exception 'Provider computer ownership is immutable' using errcode='55006'; end if;
    if new.vmid is not null then
      raise exception 'A provider server is not a Proxmox VMID' using errcode='23514'; end if;
    if old.status='deleted' and new.status<>'deleted' then
      raise exception 'A deleted provider computer cannot be reused' using errcode='55006'; end if;
    if new.status='deleted' and old.status<>'deleted' then
      if not public.hivra_provider_cleanup_verified(old.user_id,old.id,old.operation_id) then
        raise exception 'Provider computer cleanup is not verified' using errcode='55006'; end if;
    elsif row(new.infrastructure_connection_id,new.deployment_target_id,new.infrastructure_connection_revision,
        new.allocation_operation_id) is distinct from row(old.infrastructure_connection_id,
        old.deployment_target_id,old.infrastructure_connection_revision,old.allocation_operation_id) then
      raise exception 'Provider computer binding cannot be released or moved' using errcode='55006';
    end if;
    -- Updates keep their immutable binding. Avoid acquiring parent locks while
    -- holding the agent row; retirement locks parents before this row. Parent
    -- guards separately retain all authority until verified terminal deletion.
    return new;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.computer_substrate<>'provider-vm' then return new; end if;
  if tg_op<>'INSERT' then
    raise exception 'An existing agent cannot change computer substrate' using errcode='55006'; end if;
  if new.status is distinct from 'provisioning' or new.desired_state is distinct from 'running'
    or new.operation_kind is distinct from 'provision' or new.operation_id is null
    or new.operation_started_at is null
    or new.operation_started_at<clock_timestamp()-interval '5 seconds'
    or new.operation_started_at>clock_timestamp()+interval '5 seconds'
    or new.allocation_operation_id is distinct from new.operation_id
    or new.deployment_mode is distinct from 'self-managed'
    or new.proxmox_host is distinct from '__hivra_self_managed_no_ambient_authority__'
    or new.infrastructure_binding_token_enforced is distinct from true then
    raise exception 'Provider reservation requires the existing provision operation' using errcode='23514'; end if;
  -- Match the first-boot/cleanup lock order. The insertion and unique indexes
  -- reserve the whole computer atomically, not a slice of its apparent RAM.
  perform id from public.infrastructure_connections where id=new.infrastructure_connection_id
    and user_id=new.user_id and provider='hetzner-cloud' and status='ready'
    and revision=new.infrastructure_connection_revision for update;
  if not found then raise exception 'Provider connection is unavailable' using errcode='55006'; end if;
  select * into v_order from public.infrastructure_capacity_orders where id=new.provider_capacity_order_id
    and user_id=new.user_id and active_connection_id=new.infrastructure_connection_id
    and connection_id=new.infrastructure_connection_id
    and connection_revision=new.infrastructure_connection_revision for update;
  if not found or v_order.status<>'created_off' or v_order.provider_resource_id is distinct from new.provider_server_id
    or v_order.provider_creation_receipt->>'serverId' is distinct from new.provider_server_id
    or v_order.provider_server_status is distinct from 'accepted'
    or v_order.provider_ssh_key_id is null or v_order.provider_ssh_key_status is distinct from 'accepted'
    or v_order.encrypted_bootstrap_bundle is null or v_order.bootstrap_key_version is distinct from 2 then
    raise exception 'Provider order identity is unavailable' using errcode='55006'; end if;
  select * into v_enrollment from public.infrastructure_first_boot_enrollments
    where order_id=v_order.id and attempt_id=new.provider_enrollment_attempt_id for update;
  if not found or v_enrollment.phase<>'enrolled' or v_enrollment.provider_server_id is distinct from new.provider_server_id
    or v_enrollment.enrolled_at<v_enrollment.issued_at or v_enrollment.enrolled_at>=v_enrollment.expires_at
    or v_enrollment.user_id is distinct from new.user_id or v_enrollment.connection_id is distinct from new.infrastructure_connection_id
    or v_enrollment.connection_revision is distinct from new.infrastructure_connection_revision then
    raise exception 'Provider enrollment is unavailable' using errcode='55006'; end if;
  select * into v_boot from public.infrastructure_first_boot_operations
    where order_id=v_order.id and attempt_id=v_enrollment.attempt_id for update;
  if not found or v_boot.abandoned_at is not null or v_boot.lease_expires_at>clock_timestamp()
    or v_boot.firewall_receipt is null or v_boot.firewall_verified_at is null
    or v_boot.power_on_post_attempted_at is null
    or v_boot.power_on_action->>'status' is distinct from 'success' then
    raise exception 'Provider preparation still owns the computer' using errcode='55006'; end if;
  select * into v_target from public.deployment_targets where id=new.deployment_target_id
    and user_id=new.user_id and connection_id=new.infrastructure_connection_id
    and evidence_connection_revision=new.infrastructure_connection_revision for update;
  if not found or v_target.provider_capacity_order_id is distinct from v_order.id
    or v_target.external_id is distinct from new.provider_server_id
    or v_target.capabilities->>'enrollmentAttemptId' is distinct from v_enrollment.attempt_id::text
    or v_target.status<>'ready' or v_target.provider_retired_at is not null
    or v_target.isolation_class is distinct from 'provider-vm'
    or not coalesce(v_target.capabilities @> '{"kind":"provider-vm","allocation":"exclusive-computer","launchReady":true}'::jsonb,false) then
    raise exception 'Provider target is unavailable' using errcode='55006'; end if;
  return new;
end;
$$;
create trigger hivra_agents_provider_ownership_guard before insert or update or delete on public.hivra_agents
  for each row execute function public.guard_hivra_provider_agent();

create or replace function public.guard_provider_target_identity()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype; v_provider text;
begin
  if tg_op<>'INSERT' and old.provider_capacity_order_id is not null then
    if tg_op='DELETE' then
      if exists(select 1 from public.hivra_agents where deployment_target_id=old.id and status<>'deleted')
        or not exists(select 1 from public.infrastructure_capacity_orders
          where id=old.provider_capacity_order_id and status='deleted') then
        raise exception 'Provider target still owns a computer' using errcode='55006'; end if;
      return old;
    end if;
    if row(new.id,new.user_id,new.connection_id,new.evidence_connection_revision,new.external_id,new.provider_capacity_order_id)
      is distinct from row(old.id,old.user_id,old.connection_id,old.evidence_connection_revision,old.external_id,old.provider_capacity_order_id)
      or (new.capabilities-array['launchReady']) is distinct from (old.capabilities-array['launchReady'])
      or (old.provider_retired_at is not null and new.provider_retired_at is distinct from old.provider_retired_at) then
      raise exception 'Provider target identity is immutable' using errcode='55006'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  select provider into v_provider from public.infrastructure_connections where id=new.connection_id for update;
  if new.provider_capacity_order_id is null then
    if v_provider='hetzner-cloud' or new.capabilities->>'kind'='provider-vm'
      or new.isolation_class='provider-vm' or 'provider-vm'=any(new.supported_isolation_drivers)
      or new.provider_retired_at is not null then
      raise exception 'Provider target lacks its original capacity order' using errcode='23514'; end if;
    return new;
  end if;
  select * into v_order from public.infrastructure_capacity_orders where id=new.provider_capacity_order_id
    and user_id=new.user_id and connection_id=new.connection_id
    and connection_revision=new.evidence_connection_revision for update;
  if not found or v_provider is distinct from 'hetzner-cloud'
    or new.external_id is distinct from v_order.provider_resource_id
    or new.capabilities->>'capacityOrderId' is distinct from v_order.id::text
    or new.capabilities->>'provider' is distinct from 'hetzner-cloud'
    or new.capabilities->>'kind' is distinct from 'provider-vm'
    or new.capabilities->>'allocation' is distinct from 'exclusive-computer'
    or new.isolation_class is distinct from 'provider-vm'
    or new.supported_isolation_drivers is distinct from array['provider-vm']::text[]
    or not exists(select 1 from public.infrastructure_first_boot_enrollments e
      where e.order_id=v_order.id and e.attempt_id::text=new.capabilities->>'enrollmentAttemptId'
        and e.provider_server_id=new.external_id
        and (e.phase='enrolled' or (e.phase='revoked' and new.provider_retired_at is not null
          and v_order.status in ('cleaning','deleted')))
        and new.capabilities->>'hostIdentityDigest'=encode(sha256(decode(split_part(e.host_public_key,' ',2),'base64')),'hex')) then
    raise exception 'Provider target receipt does not match its computer' using errcode='55006'; end if;
  if new.provider_retired_at is not null then
    if new.status is distinct from 'unavailable' or new.capabilities->'launchReady' is distinct from 'false'::jsonb then
      raise exception 'A retired provider target cannot launch agents' using errcode='55006'; end if;
  elsif v_order.status<>'created_off' or v_order.active_connection_id is distinct from new.connection_id then
    raise exception 'Provider target order is no longer active' using errcode='55006';
  end if;
  return new;
end;
$$;
create trigger deployment_targets_provider_identity_guard before insert or update or delete on public.deployment_targets
  for each row execute function public.guard_provider_target_identity();

-- Revocation, disconnect and preparation cannot outlive or replace an agent's
-- durable ownership. This also protects service-role / N-1 direct writes.
create or replace function public.guard_provider_agent_parent()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_owned boolean;
begin
  if tg_table_name='infrastructure_connections' then
    select exists(select 1 from public.hivra_agents where infrastructure_connection_id=old.id
      and computer_substrate='provider-vm' and status<>'deleted') into v_owned;
    if v_owned and (tg_op='DELETE'
      or (new.status is distinct from old.status and new.status not in ('ready','error'))
      or (to_jsonb(new)-array['updated_at','last_checked_at','last_error_code','name','status'])
      is distinct from (to_jsonb(old)-array['updated_at','last_checked_at','last_error_code','name','status'])) then
      raise exception 'Provider agents retain this connection' using errcode='55006'; end if;
  elsif tg_table_name='infrastructure_first_boot_operations' then
    select exists(select 1 from public.hivra_agents where provider_capacity_order_id=new.order_id
      and status<>'deleted') or exists(select 1 from public.deployment_targets
        where provider_capacity_order_id=new.order_id and provider_retired_at is not null) into v_owned;
    if v_owned and ((new.lease_id is distinct from old.lease_id and new.lease_id is not null)
      or new.lease_expires_at is distinct from old.lease_expires_at
      or new.abandoned_at is distinct from old.abandoned_at) then
      raise exception 'Computer ownership or retirement excludes preparation' using errcode='55006'; end if;
  elsif tg_table_name='infrastructure_first_boot_enrollments' then
    if new.phase is distinct from old.phase and exists(select 1 from public.hivra_agents
      where provider_capacity_order_id=new.order_id and status<>'deleted')
      and not (new.phase='revoked' and exists(select 1 from public.infrastructure_capacity_orders o
        join public.deployment_targets t on t.provider_capacity_order_id=o.id
        join public.hivra_agents a on a.deployment_target_id=t.id
        where o.id=new.order_id and o.status='cleaning' and o.cleanup_lease_expires_at>clock_timestamp()
          and t.provider_retired_at is not null and a.desired_state='deleted'
          and a.operation_kind='delete' and a.operation_id is not null)) then
      raise exception 'Agent lifecycle retains enrolled identity' using errcode='55006'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_connections_provider_agent_guard before update or delete on public.infrastructure_connections
  for each row execute function public.guard_provider_agent_parent();
create trigger infrastructure_first_boot_operations_provider_agent_guard before update on public.infrastructure_first_boot_operations
  for each row execute function public.guard_provider_agent_parent();
create trigger infrastructure_first_boot_enrollments_provider_agent_guard before update on public.infrastructure_first_boot_enrollments
  for each row execute function public.guard_provider_agent_parent();

-- Explicit retirement is one-way. An unused target can be retired by its owner;
-- an allocated target requires the existing agent delete operation, after any
-- install worker has relinquished its provision operation. No resources are
-- deleted here, and failed/abandoned cleanup never makes the computer reusable.
create or replace function public.retire_hivra_provider_target(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_target_id uuid,
  p_order_id uuid,p_server_id text,p_agent_id uuid,p_operation_id uuid
)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_target public.deployment_targets%rowtype; v_agent public.hivra_agents%rowtype;
begin
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and revision=p_revision and status='ready' for update;
  if not found then return false; end if;
  perform id from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and active_connection_id=p_connection_id and connection_revision=p_revision
    and provider_resource_id=p_server_id and status in ('created_off','cleaning') for update;
  if not found then return false; end if;
  perform order_id from public.infrastructure_first_boot_enrollments where order_id=p_order_id for update;
  perform order_id from public.infrastructure_first_boot_operations where order_id=p_order_id for update;
  if exists(select 1 from public.infrastructure_first_boot_operations
    where order_id=p_order_id and lease_expires_at>clock_timestamp()) then return false; end if;
  select * into v_target from public.deployment_targets where id=p_target_id and user_id=p_user_id
    and connection_id=p_connection_id and evidence_connection_revision=p_revision
    and provider_capacity_order_id=p_order_id and external_id=p_server_id for update;
  if not found then return false; end if;
  select * into v_agent from public.hivra_agents where provider_capacity_order_id=p_order_id for update;
  if found then
    if v_agent.id is distinct from p_agent_id or v_agent.user_id is distinct from p_user_id
      or v_agent.deployment_target_id is distinct from p_target_id
      or v_agent.desired_state is distinct from 'deleted' or v_agent.operation_kind is distinct from 'delete'
      or v_agent.operation_id is distinct from p_operation_id or p_operation_id is null then return false; end if;
  elsif p_agent_id is not null or p_operation_id is not null then return false;
  end if;
  if v_target.provider_retired_at is not null then return true; end if;
  update public.deployment_targets set provider_retired_at=clock_timestamp(),status='unavailable',
    capabilities=jsonb_set(capabilities,'{launchReady}','false'),last_error_code='PROVIDER_COMPUTER_RETIRING'
    where id=p_target_id;
  return true;
end;
$$;

revoke all on function public.guard_hivra_provider_agent() from public,anon,authenticated;
revoke all on function public.guard_provider_target_identity() from public,anon,authenticated;
revoke all on function public.guard_provider_agent_parent() from public,anon,authenticated;
revoke all on function public.hivra_provider_cleanup_verified(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.hivra_provider_cleanup_verified(text,uuid,uuid) to service_role;
revoke all on function public.retire_hivra_provider_target(text,uuid,bigint,uuid,uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.retire_hivra_provider_target(text,uuid,bigint,uuid,uuid,text,uuid,uuid) to service_role;

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
  -- Only this exact computer is considered. Other computers in the same
  -- project stay untouched. A legacy/unbound target is conservatively blocking.
  if exists(select 1 from public.deployment_targets t where t.connection_id=p_connection_id
    and (t.provider_capacity_order_id is null
      or (t.provider_capacity_order_id=p_order_id and t.provider_retired_at is null)))
    or exists(select 1 from public.hivra_agents a where a.provider_capacity_order_id=p_order_id
      and a.status<>'deleted' and (a.desired_state<>'deleted' or a.operation_kind is distinct from 'delete'
        or a.operation_id is null or not exists(select 1 from public.deployment_targets t
          where t.id=a.deployment_target_id and t.provider_capacity_order_id=p_order_id
            and t.provider_retired_at is not null))) then
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

create or replace function public.guard_hetzner_cleanup_target_publication()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  perform id from public.infrastructure_connections where id=new.connection_id for update;
  if exists(select 1 from public.infrastructure_capacity_orders where active_connection_id=new.connection_id
    and status='cleaning' and (new.provider_capacity_order_id is null or id=new.provider_capacity_order_id))
    and not (tg_op='UPDATE' and old.provider_retired_at is not null
      and new.provider_retired_at is not distinct from old.provider_retired_at
      and new.status='unavailable' and new.capabilities->'launchReady'='false'::jsonb) then
    raise exception 'Capacity cleanup owns this connection' using errcode='55006'; end if;
  return new;
end;
$$;
