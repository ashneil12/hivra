-- Idempotent owner-bound rolling renewal for one exact native Omarchy
-- activation. Database authority is recorded before guest dispatch; the guest
-- retains its own monotonic deadline and systemd process backstop.

create table if not exists public.hivra_omarchy_native_renewals (
  renewal_id uuid primary key,
  session_id uuid not null references public.hivra_remote_desktop_sessions(id) on delete restrict,
  activation_id uuid not null,
  user_id text not null,
  renewal_count integer not null check (renewal_count between 1 and 240),
  previous_expires_at timestamptz not null,
  expires_at timestamptz not null,
  continuous_expires_at timestamptz not null,
  guardian_renewal jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(session_id,renewal_count),
  check (expires_at>previous_expires_at and expires_at<=continuous_expires_at)
);

alter table public.hivra_omarchy_native_renewals enable row level security;
revoke all on table public.hivra_omarchy_native_renewals from public,anon,authenticated;

create or replace function public.refresh_hivra_omarchy_native_capability(
  p_user_id text,p_computer_id uuid,p_generation uuid,p_observed_revision text,
  p_observed_at timestamptz,p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.hivra_remote_desktop_capabilities%rowtype; v_owner_active boolean:=false;
begin
  if p_user_id is null or p_user_id='' or p_computer_id is null or p_generation is null
    or p_observed_revision is null or p_observed_revision !~ '^[a-f0-9]{64}$'
    or p_observed_at is null or p_observed_at<clock_timestamp()-interval '2 minutes'
    or p_observed_at>clock_timestamp()+interval '5 seconds' or p_expires_at is null
    or p_expires_at<=clock_timestamp()+interval '30 seconds'
    or p_expires_at>clock_timestamp()+interval '10 minutes' then
    return jsonb_build_object('status','invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'hivra-remote-desktop-v1:hivra-agent:'||p_computer_id::text,0));
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind='hivra-agent' and computer_id=p_computer_id and user_id=p_user_id
      and generation=p_generation and observed_revision=p_observed_revision and revoked_at is null
      and compositor='wayland' and 'sunshine-moonlight'=any(installed_transports)
      and private_network_reachable=true and supports_input_takeover=true for update;
  if not found then return jsonb_build_object('status','capability_unavailable'); end if;
  select exists(select 1 from public.hivra_agents where id=p_computer_id and user_id=p_user_id
    and type='linux-desktop' and computer_profile='omarchy' and status='running'
    and desired_state='running' and operation_id is null and operation_kind is null) into v_owner_active;
  if not v_owner_active then return jsonb_build_object('status','computer_not_ready'); end if;
  update public.hivra_remote_desktop_capabilities set observed_at=p_observed_at,
    expires_at=p_expires_at,updated_at=clock_timestamp()
    where computer_kind='hivra-agent' and computer_id=p_computer_id and user_id=p_user_id
      and generation=p_generation and revoked_at is null;
  return jsonb_build_object('status','ready','computerId',p_computer_id,'generation',p_generation,
    'expiresAt',p_expires_at);
end;
$$;

create or replace function public.claim_hivra_omarchy_native_activation(
  p_user_id text,p_session_id uuid,p_session_token_hash text,p_activation_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  c public.hivra_remote_desktop_capabilities%rowtype;
  v_owner_active boolean:=false;
begin
  if p_user_id is null or p_user_id='' or p_session_id is null or p_activation_id is null
    or p_session_token_hash is null or p_session_token_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status','invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hivra-remote-desktop-v1:'||p_session_id::text,0));
  select * into s from public.hivra_remote_desktop_sessions
    where id=p_session_id and user_id=p_user_id and session_token_hash=p_session_token_hash
    for update;
  if not found or s.transport<>'sunshine-moonlight' or s.input_role<>'controller'
    or s.input_state<>'takeover-pending' or s.exchanged_at is null
    or s.revoked_at is not null or s.issued_at>clock_timestamp()
    or s.expires_at<=clock_timestamp()+interval '65 seconds'
    or s.native_profile_bound is not true or s.native_client_id is null
    or s.native_client_certificate_pem is null or s.native_client_certificate_sha256 is null then
    return jsonb_build_object('status','denied');
  end if;
  if s.native_activation_id is not null then
    return jsonb_build_object('status','already_used');
  end if;
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=s.computer_kind and computer_id=s.computer_id
      and generation=s.capability_generation and user_id=s.user_id
      and revoked_at is null and expires_at>=s.expires_at
      and 'sunshine-moonlight'=any(installed_transports)
      and private_network_reachable=true and supports_input_takeover=true;
  if not found then return jsonb_build_object('status','capability_unavailable'); end if;
  if s.computer_kind<>'hivra-agent' then return jsonb_build_object('status','denied'); end if;
  select exists(select 1 from public.hivra_agents where id=s.computer_id and user_id=s.user_id
    and type='linux-desktop' and computer_profile='omarchy'
    and status='running' and desired_state='running'
    and operation_id is null and operation_kind is null) into v_owner_active;
  if not v_owner_active then return jsonb_build_object('status','computer_not_ready'); end if;
  begin
    update public.hivra_remote_desktop_sessions set
      native_activation_id=p_activation_id,native_activation_claimed_at=clock_timestamp(),
      updated_at=clock_timestamp() where id=s.id and native_activation_id is null;
  exception when unique_violation then
    return jsonb_build_object('status','operation_conflict');
  end;
  if not found then return jsonb_build_object('status','operation_conflict'); end if;
  return jsonb_build_object(
    'status','claimed','activationId',p_activation_id,'sessionId',s.id,
    'ownerId',s.user_id,'computerId',s.computer_id,
    'capabilityGeneration',s.capability_generation,'observedRevision',c.observed_revision,
    'clientId',s.native_client_id,'clientCertificatePem',s.native_client_certificate_pem,
    'clientCertificateSha256',s.native_client_certificate_sha256,
    'streamingMode',s.streaming_mode,'expiresAt',s.expires_at,
    'continuousExpiresAt',s.created_at+interval '12 hours'
  );
end;
$$;

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
    or (select count(*) from jsonb_object_keys(p_guardian_grant))<>20
    or not (p_guardian_grant ?& array['protocol','binding','ownerId','capabilityGeneration',
      'observedRevision','sessionId','leaseId','clientId','clientCertificatePem',
      'clientCertificateSha256','guestBootId','expiresAtUnixMs','deadlineBoottimeNs',
      'continuousDeadlineBoottimeNs','runtimeMaxUsec','sunshineSha256','guardianSha256',
      'ownershipSha256','preparedSha256','unitSha256']) then
    return jsonb_build_object('status','invalid_request');
  end if;
  v_binding:=p_guardian_grant->'binding';
  if jsonb_typeof(v_binding) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(v_binding))<>6
    or not (v_binding ?& array['computerId','operationId','vmid','ownerUid','guestPrivateIpv4','waylandDisplay'])
    or p_guardian_grant->>'protocol'<>'hivra-omarchy-guardian-grant-v2'
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
    or jsonb_typeof(p_guardian_grant->'expiresAtUnixMs') is distinct from 'number'
    or jsonb_typeof(p_guardian_grant->'deadlineBoottimeNs') is distinct from 'number'
    or jsonb_typeof(p_guardian_grant->'continuousDeadlineBoottimeNs') is distinct from 'number'
    or (p_guardian_grant->>'expiresAtUnixMs')::numeric<=0
    or trunc((p_guardian_grant->>'expiresAtUnixMs')::numeric)<>(p_guardian_grant->>'expiresAtUnixMs')::numeric
    or (p_guardian_grant->>'deadlineBoottimeNs')::numeric<=0
    or trunc((p_guardian_grant->>'deadlineBoottimeNs')::numeric)<>(p_guardian_grant->>'deadlineBoottimeNs')::numeric
    or (p_guardian_grant->>'continuousDeadlineBoottimeNs')::numeric<=0
    or trunc((p_guardian_grant->>'continuousDeadlineBoottimeNs')::numeric)<>(p_guardian_grant->>'continuousDeadlineBoottimeNs')::numeric
    or (p_guardian_grant->>'deadlineBoottimeNs')::numeric>=(p_guardian_grant->>'continuousDeadlineBoottimeNs')::numeric
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
    or (p_guardian_grant->>'expiresAtUnixMs')::numeric
      <>floor(extract(epoch from s.expires_at)*1000)
    or v_binding->>'computerId' is distinct from s.computer_id::text then
    return jsonb_build_object('status','denied');
  end if;
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=s.computer_kind and computer_id=s.computer_id
      and generation=s.capability_generation and user_id=s.user_id and revoked_at is null;
  if not found or p_guardian_grant->>'observedRevision' is distinct from c.observed_revision then
    return jsonb_build_object('status','capability_unavailable');
  end if;
  select * into prior from public.hivra_omarchy_native_activation_grants where session_id=p_session_id;
  if found then
    if prior.activation_id=p_activation_id and prior.user_id=p_user_id and prior.guardian_grant=p_guardian_grant then
      return jsonb_build_object('status','recorded','sessionId',p_session_id,'activationId',p_activation_id);
    end if;
    return jsonb_build_object('status','operation_conflict');
  end if;
  begin
    insert into public.hivra_omarchy_native_activation_grants(session_id,activation_id,user_id,guardian_grant)
      values(p_session_id,p_activation_id,p_user_id,p_guardian_grant);
  exception when unique_violation then return jsonb_build_object('status','operation_conflict'); end;
  return jsonb_build_object('status','recorded','sessionId',p_session_id,'activationId',p_activation_id);
end;
$$;

create or replace function public.claim_hivra_omarchy_native_renewal(
  p_user_id text,p_session_id uuid,p_activation_id uuid,p_renewal_id uuid,p_ttl_seconds integer
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  c public.hivra_remote_desktop_capabilities%rowtype;
  prior public.hivra_omarchy_native_renewals%rowtype;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_continuous_expires_at timestamptz;
  v_owner_active boolean:=false;
begin
  if p_user_id is null or p_user_id='' or p_session_id is null or p_activation_id is null
    or p_renewal_id is null or p_ttl_seconds is null or p_ttl_seconds not between 30 and 300 then
    return jsonb_build_object('status','invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hivra-remote-desktop-v1:'||p_session_id::text,0));
  select * into prior from public.hivra_omarchy_native_renewals where renewal_id=p_renewal_id;
  if found then
    if prior.user_id=p_user_id and prior.session_id=p_session_id and prior.activation_id=p_activation_id then
      return jsonb_build_object('status','claimed','sessionId',prior.session_id,
        'activationId',prior.activation_id,'renewalId',prior.renewal_id,
        'renewalCount',prior.renewal_count,'previousExpiresAt',prior.previous_expires_at,
        'expiresAt',prior.expires_at,'continuousExpiresAt',prior.continuous_expires_at,
        'guardianRenewal',prior.guardian_renewal);
    end if;
    return jsonb_build_object('status','operation_conflict');
  end if;
  select * into s from public.hivra_remote_desktop_sessions
    where id=p_session_id and user_id=p_user_id and native_activation_id=p_activation_id for update;
  v_now:=clock_timestamp();
  if not found or s.transport<>'sunshine-moonlight' or s.input_role<>'controller'
    or s.input_state<>'takeover-pending' or s.exchanged_at is null or s.revoked_at is not null
    or s.expires_at<=v_now+interval '30 seconds' or s.native_profile_bound is not true
    or s.renewal_count>=240 then return jsonb_build_object('status','denied'); end if;
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=s.computer_kind and computer_id=s.computer_id and user_id=s.user_id
      and generation=s.capability_generation and revoked_at is null
      and expires_at>v_now+interval '30 seconds'
      and 'sunshine-moonlight'=any(installed_transports)
      and private_network_reachable=true and supports_input_takeover=true for update;
  if not found then return jsonb_build_object('status','capability_unavailable'); end if;
  select exists(select 1 from public.hivra_agents where id=s.computer_id and user_id=s.user_id
    and type='linux-desktop' and computer_profile='omarchy' and status='running'
    and desired_state='running' and operation_id is null and operation_kind is null) into v_owner_active;
  if not v_owner_active then return jsonb_build_object('status','computer_not_ready'); end if;
  v_continuous_expires_at:=s.created_at+interval '12 hours';
  v_expires_at:=least(v_now+make_interval(secs=>p_ttl_seconds),c.expires_at,v_continuous_expires_at);
  if v_expires_at<=s.expires_at+interval '1 second' then
    return jsonb_build_object('status','renewal_not_due');
  end if;
  update public.hivra_remote_desktop_sessions set issued_at=v_now,expires_at=v_expires_at,
    renewal_count=renewal_count+1,last_renewed_at=v_now,updated_at=v_now where id=s.id;
  begin
    insert into public.hivra_omarchy_native_renewals(
      renewal_id,session_id,activation_id,user_id,renewal_count,previous_expires_at,
      expires_at,continuous_expires_at
    ) values(p_renewal_id,s.id,p_activation_id,p_user_id,s.renewal_count+1,s.expires_at,
      v_expires_at,v_continuous_expires_at);
  exception when unique_violation then return jsonb_build_object('status','operation_conflict'); end;
  return jsonb_build_object('status','claimed','sessionId',s.id,'activationId',p_activation_id,
    'renewalId',p_renewal_id,'renewalCount',s.renewal_count+1,
    'previousExpiresAt',s.expires_at,'expiresAt',v_expires_at,
    'continuousExpiresAt',v_continuous_expires_at,'guardianRenewal',null);
end;
$$;

create or replace function public.record_hivra_omarchy_native_renewal(
  p_user_id text,p_session_id uuid,p_activation_id uuid,p_renewal_id uuid,p_guardian_renewal jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.hivra_omarchy_native_renewals%rowtype; g public.hivra_omarchy_native_activation_grants%rowtype;
begin
  if p_user_id is null or p_user_id='' or p_session_id is null or p_activation_id is null or p_renewal_id is null
    or jsonb_typeof(p_guardian_renewal) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_guardian_renewal))<>9
    or not (p_guardian_renewal ?& array['protocol','sessionId','leaseId','capabilityGeneration',
      'guestBootId','renewalId','renewalCount','deadlineBoottimeNs','continuousDeadlineBoottimeNs'])
    or p_guardian_renewal->>'protocol'<>'hivra-omarchy-guardian-renewal-v1'
    or p_guardian_renewal->>'sessionId' is distinct from p_session_id::text
    or p_guardian_renewal->>'leaseId' is distinct from p_activation_id::text
    or p_guardian_renewal->>'renewalId' is distinct from p_renewal_id::text
    or jsonb_typeof(p_guardian_renewal->'renewalCount') is distinct from 'number'
    or jsonb_typeof(p_guardian_renewal->'deadlineBoottimeNs') is distinct from 'number'
    or jsonb_typeof(p_guardian_renewal->'continuousDeadlineBoottimeNs') is distinct from 'number'
    or (p_guardian_renewal->>'renewalCount')::numeric not between 1 and 240
    or trunc((p_guardian_renewal->>'renewalCount')::numeric)<>(p_guardian_renewal->>'renewalCount')::numeric
    or (p_guardian_renewal->>'deadlineBoottimeNs')::numeric<=0
    or trunc((p_guardian_renewal->>'deadlineBoottimeNs')::numeric)<>(p_guardian_renewal->>'deadlineBoottimeNs')::numeric
    or (p_guardian_renewal->>'continuousDeadlineBoottimeNs')::numeric<=0
    or trunc((p_guardian_renewal->>'continuousDeadlineBoottimeNs')::numeric)<>(p_guardian_renewal->>'continuousDeadlineBoottimeNs')::numeric
    or (p_guardian_renewal->>'deadlineBoottimeNs')::numeric
      >(p_guardian_renewal->>'continuousDeadlineBoottimeNs')::numeric
    then return jsonb_build_object('status','invalid_request'); end if;
  perform pg_advisory_xact_lock(hashtextextended('hivra-remote-desktop-v1:'||p_session_id::text,0));
  select * into r from public.hivra_omarchy_native_renewals where renewal_id=p_renewal_id for update;
  if not found then return jsonb_build_object('status','denied'); end if;
  select * into g from public.hivra_omarchy_native_activation_grants where session_id=p_session_id;
  if not found or r.user_id<>p_user_id or r.session_id<>p_session_id or r.activation_id<>p_activation_id
    or g.user_id<>p_user_id or g.activation_id<>p_activation_id
    or p_guardian_renewal->>'capabilityGeneration' is distinct from g.guardian_grant->>'capabilityGeneration'
    or p_guardian_renewal->>'guestBootId' is distinct from g.guardian_grant->>'guestBootId'
    or (p_guardian_renewal->>'renewalCount')::integer<>r.renewal_count
    or p_guardian_renewal->>'continuousDeadlineBoottimeNs' is distinct from g.guardian_grant->>'continuousDeadlineBoottimeNs'
    then return jsonb_build_object('status','denied'); end if;
  if r.guardian_renewal is not null then
    if r.guardian_renewal=p_guardian_renewal then
      return jsonb_build_object('status','recorded','sessionId',p_session_id,'renewalId',p_renewal_id);
    end if;
    return jsonb_build_object('status','operation_conflict');
  end if;
  update public.hivra_omarchy_native_renewals set guardian_renewal=p_guardian_renewal
    where renewal_id=p_renewal_id and guardian_renewal is null;
  if not found then return jsonb_build_object('status','operation_conflict'); end if;
  return jsonb_build_object('status','recorded','sessionId',p_session_id,'renewalId',p_renewal_id);
end;
$$;

revoke all on function public.claim_hivra_omarchy_native_renewal(text,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_hivra_omarchy_native_renewal(text,uuid,uuid,uuid,integer) to service_role;
revoke all on function public.refresh_hivra_omarchy_native_capability(text,uuid,uuid,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.refresh_hivra_omarchy_native_capability(text,uuid,uuid,text,timestamptz,timestamptz) to service_role;
revoke all on function public.record_hivra_omarchy_native_renewal(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_hivra_omarchy_native_renewal(text,uuid,uuid,uuid,jsonb) to service_role;
