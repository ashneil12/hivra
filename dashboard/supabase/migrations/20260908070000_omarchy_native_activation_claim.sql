-- Reserve one exact, already-exchanged native controller before guest dispatch.

alter table public.hivra_remote_desktop_sessions
  add column if not exists native_activation_id uuid,
  add column if not exists native_activation_claimed_at timestamptz;

alter table public.hivra_remote_desktop_sessions
  add constraint hivra_remote_desktop_native_activation_shape check (
    (native_activation_id is null and native_activation_claimed_at is null)
    or (native_activation_id is not null and native_activation_claimed_at is not null
      and native_profile_bound=true and transport='sunshine-moonlight'
      and input_role='controller' and exchanged_at is not null)
  );

create unique index hivra_remote_desktop_native_activation_id_unique
  on public.hivra_remote_desktop_sessions(native_activation_id)
  where native_activation_id is not null;

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
    'streamingMode',s.streaming_mode,'expiresAt',s.expires_at
  );
end;
$$;

revoke all on function public.claim_hivra_omarchy_native_activation(text,uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.claim_hivra_omarchy_native_activation(text,uuid,text,uuid)
  to service_role;
