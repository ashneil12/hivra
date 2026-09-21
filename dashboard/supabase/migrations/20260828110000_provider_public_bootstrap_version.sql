-- Add the reviewed guest model-settings bundle without reclassifying installed
-- computers or relaxing original owner, lease, allocation or receipt checks.
-- Retain .28.1 for existing computer lifecycle/recovery. No row is rewritten.
create or replace function public.admit_prepared_provider_computer(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,
  p_attempt_id uuid,p_server text,p_lease_id uuid,p_target_id uuid,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  o public.infrastructure_capacity_orders%rowtype;
  b public.infrastructure_first_boot_operations%rowtype;
  t public.deployment_targets%rowtype;
begin
  perform id from public.infrastructure_connections where id=p_connection_id
    and user_id=p_user_id and revision=p_revision and provider='hetzner-cloud' and status='ready' for update;
  if not found then return false; end if;
  select * into o from public.infrastructure_capacity_orders where id=p_order_id
    and user_id=p_user_id and connection_id=p_connection_id and active_connection_id=p_connection_id
    and connection_revision=p_revision and status='created_off' for update;
  if not found or o.provider_resource_id is distinct from p_server
    or o.provider_server_status is distinct from 'accepted' or o.provider_ssh_key_status is distinct from 'accepted'
    or o.provider_creation_receipt->>'serverId' is distinct from p_server then return false; end if;
  perform attempt_id from public.infrastructure_first_boot_enrollments where attempt_id=p_attempt_id
    and order_id=p_order_id and user_id=p_user_id and connection_id=p_connection_id
    and connection_revision=p_revision and provider_server_id=p_server and phase='enrolled'
    and enrolled_at>=issued_at and enrolled_at<expires_at for update;
  if not found then return false; end if;
  select * into b from public.infrastructure_first_boot_operations where order_id=p_order_id
    and attempt_id=p_attempt_id and user_id=p_user_id and connection_id=p_connection_id
    and connection_revision=p_revision and provider_server_id=p_server for update;
  if not found or p_lease_id is null or b.lease_id is distinct from p_lease_id
    or b.lease_expires_at is null or b.lease_expires_at<=clock_timestamp() or b.abandoned_at is not null
    or b.firewall_receipt is null or b.firewall_verified_at is null
    or b.power_on_post_attempted_at is null or b.power_on_action->>'status' is distinct from 'success'
    or exists(select 1 from public.hivra_agents where provider_capacity_order_id=p_order_id)
    then return false; end if;
  select * into t from public.deployment_targets where id=p_target_id and user_id=p_user_id
    and connection_id=p_connection_id and evidence_connection_revision=p_revision
    and provider_capacity_order_id=p_order_id and external_id=p_server for update;
  if not found or t.provider_retired_at is not null or t.last_preflight_at is null
    or t.last_preflight_at<clock_timestamp()-interval '30 seconds' or t.last_preflight_at>clock_timestamp()+interval '5 seconds'
    or t.capabilities->>'enrollmentAttemptId' is distinct from p_attempt_id::text
    or t.capabilities->'runtimeCompatibility' is distinct from 'null'::jsonb
    or not coalesce(t.capabilities @> '{"kind":"provider-vm","provider":"hetzner-cloud","allocation":"exclusive-computer","provisioner":{"configured":true,"ready":true}}'::jsonb,false)
    or not coalesce(t.capabilities#>>'{provisioner,version}' in ('2026.08.28.1','2026.08.28.2','2026.08.28.3'),false)
    or t.isolation_class is distinct from 'provider-vm'
    or t.supported_isolation_drivers is distinct from array['provider-vm']::text[]
    or p_receipt is distinct from jsonb_build_object('version',1,'state','bundle_installed',
      'provisionerVersion',t.capabilities#>>'{provisioner,version}',
      'bundleSha256',t.capabilities#>>'{provisioner,bundleSha256}',
      'scopeSha256',t.capabilities#>>'{provisioner,scopeSha256}')
    then return false; end if;
  if t.status='ready' and t.capabilities->'launchReady'='true'::jsonb and t.last_error_code is null then return true; end if;
  if t.status<>'unavailable' or t.capabilities->'launchReady' is distinct from 'false'::jsonb
    or t.last_error_code is distinct from 'PROVIDER_ADAPTER_UNAVAILABLE' then return false; end if;
  update public.deployment_targets set status='ready',capabilities=jsonb_set(capabilities,'{launchReady}','true'),
    last_error_code=null,updated_at=clock_timestamp() where id=t.id;
  return true;
end;
$$;
revoke all on function public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb) to service_role;
