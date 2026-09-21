-- Bind the user-selected streaming profile to the exact remote-desktop
-- session. Existing callers remain HQ-first through the column default; new
-- callers use the v2 issue RPC so the choice is validated and serialized in
-- the same transaction as controller ownership.

alter table public.hivra_remote_desktop_sessions
  add column if not exists streaming_mode text not null default 'hq'
  check (streaming_mode in ('hq','performance'));

create or replace function public.issue_hivra_remote_desktop_session_v2(
  p_user_id text,p_session_id uuid,p_computer_kind text,p_computer_id uuid,
  p_transport text,p_input_role text,p_handoff text,p_exchange_code_hash text,
  p_pkce_challenge text,p_issued_at timestamptz,p_expires_at timestamptz,
  p_relay_credential_expires_at timestamptz,p_streaming_mode text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  c public.hivra_remote_desktop_capabilities%rowtype;
  v_owner_active boolean:=false;
  v_input_state text;
  v_audience text;
begin
  if p_user_id is null or char_length(p_user_id) not between 1 and 256
    or p_session_id is null or p_computer_kind is null
    or p_computer_kind not in ('hermes-instance','hivra-agent')
    or p_computer_id is null or p_transport is null or p_transport not in (
      'sunshine-moonlight','selkies-webrtc','selkies-websocket','recovery-console')
    or p_input_role is null or p_input_role not in ('controller','viewer')
    or p_handoff is null or p_handoff not in ('cookie','message')
    or p_streaming_mode is null or p_streaming_mode not in ('hq','performance')
    or p_exchange_code_hash is null or p_exchange_code_hash !~ '^[a-f0-9]{64}$'
    or p_pkce_challenge is null or p_pkce_challenge !~ '^[A-Za-z0-9_-]{43}$'
    or p_issued_at is null or p_expires_at is null
    or p_issued_at > clock_timestamp()
    or p_issued_at < clock_timestamp()-interval '1 minute'
    or p_expires_at <= clock_timestamp()
    or p_expires_at <= p_issued_at or p_expires_at > p_issued_at+interval '5 minutes'
    or p_expires_at > clock_timestamp()+interval '5 minutes'
    or (p_relay_credential_expires_at is not null and (
      p_relay_credential_expires_at<=p_issued_at or p_relay_credential_expires_at>p_expires_at
    )) then
    return jsonb_build_object('status','invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'hivra-remote-desktop-v1:'||p_computer_kind||':'||p_computer_id::text,0));
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=p_computer_kind and computer_id=p_computer_id for update;
  if not found or c.user_id<>p_user_id or c.revoked_at is not null
    or c.expires_at<=clock_timestamp() or p_expires_at>c.expires_at
    or not (p_transport=any(c.installed_transports)) then
    return jsonb_build_object('status','capability_unavailable');
  end if;
  if (p_transport in ('selkies-webrtc','selkies-websocket') and c.compositor<>'x11')
    or (p_transport='sunshine-moonlight' and not c.private_network_reachable) then
    return jsonb_build_object('status','transport_unavailable');
  end if;
  if p_input_role='controller' and not c.supports_input_takeover then
    return jsonb_build_object('status','input_takeover_unavailable');
  end if;
  if p_computer_kind='hermes-instance' then
    select exists(select 1 from public.hermes_instances
      where id=p_computer_id and user_id=p_user_id and status='running') into v_owner_active;
  else
    select exists(select 1 from public.hivra_agents
      where id=p_computer_id and user_id=p_user_id and status='running' and desired_state='running') into v_owner_active;
  end if;
  if not v_owner_active then return jsonb_build_object('status','computer_not_ready'); end if;
  update public.hivra_remote_desktop_sessions set
    revoked_at=clock_timestamp(),revoke_reason='session_expired',
    input_state=case when input_state='active' then 'release-pending'
      when input_role='controller' then 'released' else input_state end,
    control_released_at=case when input_state='active' then control_released_at
      when input_role='controller' then clock_timestamp() else control_released_at end,
    updated_at=clock_timestamp()
  where computer_kind=p_computer_kind and computer_id=p_computer_id
    and expires_at<=clock_timestamp() and revoked_at is null;
  if p_input_role='controller' and exists(
    select 1 from public.hivra_remote_desktop_sessions s
    where s.computer_kind=p_computer_kind and s.computer_id=p_computer_id
      and s.input_role='controller'
      and (
        (s.capability_generation=c.generation and s.revoked_at is null and s.expires_at>clock_timestamp()
          and s.input_state in ('takeover-pending','active'))
        or s.input_state='release-pending'
      )
  ) then return jsonb_build_object('status','controller_conflict'); end if;
  v_input_state:=case when p_input_role='controller' then 'takeover-pending' else 'not-requested' end;
  v_audience:='hivra-computer:'||p_computer_kind||':'||p_computer_id::text||':desktop';
  begin
    insert into public.hivra_remote_desktop_sessions(
      id,user_id,computer_kind,computer_id,capability_generation,transport,input_role,
      input_state,audience,handoff,exchange_code_hash,pkce_challenge,issued_at,expires_at,
      relay_credential_expires_at,streaming_mode
    ) values (
      p_session_id,p_user_id,p_computer_kind,p_computer_id,c.generation,p_transport,
      p_input_role,v_input_state,v_audience,p_handoff,p_exchange_code_hash,p_pkce_challenge,
      p_issued_at,p_expires_at,p_relay_credential_expires_at,p_streaming_mode
    );
  exception when unique_violation then
    return jsonb_build_object('status','operation_conflict');
  end;
  return jsonb_build_object(
    'status','issued','sessionId',p_session_id,'computerKind',p_computer_kind,
    'computerId',p_computer_id,'capabilityGeneration',c.generation,'transport',p_transport,
    'inputRole',p_input_role,'streamingMode',p_streaming_mode,'audience',v_audience,
    'handoff',p_handoff,'brokerOrigin',c.broker_origin,'issuedAt',p_issued_at,
    'expiresAt',p_expires_at,'relayCredentialExpiresAt',p_relay_credential_expires_at
  );
end;
$$;

revoke all on function public.issue_hivra_remote_desktop_session_v2(
  text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text
) from public,anon,authenticated;
grant execute on function public.issue_hivra_remote_desktop_session_v2(
  text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text
) to service_role;
