-- Persist the exact one-use guardian grant before dispatch so later renewal
-- and teardown never reconstruct authority from a newer observation.

create table if not exists public.hivra_omarchy_native_activation_grants (
  session_id uuid primary key references public.hivra_remote_desktop_sessions(id) on delete restrict,
  activation_id uuid not null unique,
  user_id text not null,
  guardian_grant jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table public.hivra_omarchy_native_activation_grants enable row level security;
revoke all on table public.hivra_omarchy_native_activation_grants from public,anon,authenticated;

create or replace function public.record_hivra_omarchy_native_activation_grant(
  p_user_id text,p_session_id uuid,p_activation_id uuid,p_guardian_grant jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  c public.hivra_remote_desktop_capabilities%rowtype;
  prior public.hivra_omarchy_native_activation_grants%rowtype;
  v_binding jsonb;
begin
  if p_user_id is null or p_user_id='' or p_session_id is null or p_activation_id is null
    or jsonb_typeof(p_guardian_grant) is distinct from 'object'
    or octet_length(p_guardian_grant::text)>32768
    or (select count(*) from jsonb_object_keys(p_guardian_grant))<>18
    or not (p_guardian_grant ?& array['protocol','binding','ownerId','capabilityGeneration',
      'observedRevision','sessionId','leaseId','clientId','clientCertificatePem',
      'clientCertificateSha256','guestBootId','deadlineBoottimeNs','runtimeMaxUsec',
      'sunshineSha256','guardianSha256','ownershipSha256','preparedSha256','unitSha256']) then
    return jsonb_build_object('status','invalid_request');
  end if;
  v_binding:=p_guardian_grant->'binding';
  if jsonb_typeof(v_binding) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(v_binding))<>6
    or not (v_binding ?& array['computerId','operationId','vmid','ownerUid',
      'guestPrivateIpv4','waylandDisplay'])
    or p_guardian_grant->>'protocol'<>'hivra-omarchy-guardian-grant-v1'
    or p_guardian_grant->>'ownerId' is distinct from p_user_id
    or p_guardian_grant->>'sessionId' is distinct from p_session_id::text
    or p_guardian_grant->>'leaseId' is distinct from p_activation_id::text
    or coalesce(p_guardian_grant->>'capabilityGeneration','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_guardian_grant->>'observedRevision','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_guardian_grant->>'clientId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_guardian_grant->>'clientCertificateSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_guardian_grant->>'guestBootId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_guardian_grant->>'sunshineSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_guardian_grant->>'guardianSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_guardian_grant->>'ownershipSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_guardian_grant->>'preparedSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(p_guardian_grant->>'unitSha256','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_guardian_grant->'deadlineBoottimeNs') is distinct from 'number'
    or jsonb_typeof(p_guardian_grant->'runtimeMaxUsec') is distinct from 'number'
    or (p_guardian_grant->>'runtimeMaxUsec')::numeric<=0
    or (p_guardian_grant->>'runtimeMaxUsec')::numeric>240000000
    or v_binding->>'computerId' is null
    or coalesce(v_binding->>'operationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(v_binding->'vmid') is distinct from 'number'
    or jsonb_typeof(v_binding->'ownerUid') is distinct from 'number'
    or v_binding->>'guestPrivateIpv4' is null
    or coalesce(v_binding->>'waylandDisplay','') !~ '^wayland-[0-9]{1,3}$' then
    return jsonb_build_object('status','invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hivra-remote-desktop-v1:'||p_session_id::text,0));
  select * into s from public.hivra_remote_desktop_sessions
    where id=p_session_id and user_id=p_user_id for update;
  if not found or s.native_activation_id is distinct from p_activation_id
    or s.native_activation_claimed_at is null or s.revoked_at is not null
    or s.expires_at<=clock_timestamp() or s.transport<>'sunshine-moonlight'
    or s.input_role<>'controller' or s.native_profile_bound is not true
    or p_guardian_grant->>'capabilityGeneration' is distinct from s.capability_generation::text
    or p_guardian_grant->>'clientId' is distinct from s.native_client_id::text
    or p_guardian_grant->>'clientCertificatePem' is distinct from s.native_client_certificate_pem
    or p_guardian_grant->>'clientCertificateSha256' is distinct from s.native_client_certificate_sha256
    or v_binding->>'computerId' is distinct from s.computer_id::text then
    return jsonb_build_object('status','denied');
  end if;
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=s.computer_kind and computer_id=s.computer_id
      and generation=s.capability_generation and user_id=s.user_id and revoked_at is null;
  if not found or p_guardian_grant->>'observedRevision' is distinct from c.observed_revision then
    return jsonb_build_object('status','capability_unavailable');
  end if;

  select * into prior from public.hivra_omarchy_native_activation_grants
    where session_id=p_session_id;
  if found then
    if prior.activation_id=p_activation_id and prior.user_id=p_user_id
      and prior.guardian_grant=p_guardian_grant then
      return jsonb_build_object('status','recorded','sessionId',p_session_id,
        'activationId',p_activation_id);
    end if;
    return jsonb_build_object('status','operation_conflict');
  end if;
  begin
    insert into public.hivra_omarchy_native_activation_grants(
      session_id,activation_id,user_id,guardian_grant
    ) values(p_session_id,p_activation_id,p_user_id,p_guardian_grant);
  exception when unique_violation then
    return jsonb_build_object('status','operation_conflict');
  end;
  return jsonb_build_object('status','recorded','sessionId',p_session_id,
    'activationId',p_activation_id);
end;
$$;

revoke all on function public.record_hivra_omarchy_native_activation_grant(text,uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.record_hivra_omarchy_native_activation_grant(text,uuid,uuid,jsonb)
  to service_role;
