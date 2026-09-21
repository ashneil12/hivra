-- Guest acknowledgement for remote-desktop input transitions.
--
-- The browser never calls this function. The guest broker holds the exchanged
-- short-lived session bearer and may acknowledge only that exact session's
-- takeover or release transition. Release remains possible after owner
-- revocation so a revoked controller cannot leave the computer permanently
-- fenced in release-pending.

create or replace function public.confirm_hivra_remote_desktop_input_transition_by_token(
  p_session_token_hash text,
  p_receipt jsonb
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  v_action text;
  v_confirmed boolean:=false;
begin
  if p_session_token_hash is null
    or p_session_token_hash !~ '^[a-f0-9]{64}$'
    or p_receipt is null
    or jsonb_typeof(p_receipt)<>'object'
    or jsonb_typeof(p_receipt->'action')<>'string'
    or jsonb_typeof(p_receipt->'sessionId')<>'string'
  then return jsonb_build_object('status','denied'); end if;

  select * into s
  from public.hivra_remote_desktop_sessions
  where session_token_hash=p_session_token_hash
  for update;

  if not found
    or p_receipt->>'sessionId'<>s.id::text
    or p_receipt->>'computerKind'<>s.computer_kind
    or p_receipt->>'computerId'<>s.computer_id::text
    or p_receipt->>'capabilityGeneration'<>s.capability_generation::text
    or p_receipt->>'transport'<>s.transport
  then return jsonb_build_object('status','denied'); end if;

  v_action:=p_receipt->>'action';
  if v_action='agent-input-suspended' then
    -- A revoked or expired bearer can never acquire input authority.
    if s.revoked_at is not null or s.expires_at<=clock_timestamp() then
      return jsonb_build_object('status','denied');
    end if;
    v_confirmed:=public.confirm_hivra_remote_desktop_takeover(s.user_id,s.id,p_receipt);
  elsif v_action='agent-input-resumed' then
    -- The release acknowledgement is intentionally accepted only after the
    -- session entered release-pending, which the existing strict function
    -- verifies. This is the terminal cleanup path for a revoked bearer.
    v_confirmed:=public.confirm_hivra_remote_desktop_release(s.user_id,s.id,p_receipt);
  else
    return jsonb_build_object('status','denied');
  end if;

  if not v_confirmed then return jsonb_build_object('status','denied'); end if;
  return jsonb_build_object(
    'status','confirmed',
    'sessionId',s.id,
    'action',v_action
  );
end;
$$;

revoke all on function public.confirm_hivra_remote_desktop_input_transition_by_token(text,jsonb)
  from public,anon,authenticated;
grant execute on function public.confirm_hivra_remote_desktop_input_transition_by_token(text,jsonb)
  to service_role;

comment on function public.confirm_hivra_remote_desktop_input_transition_by_token(text,jsonb) is
  'Service-only guest acknowledgement bound to the hash of one exchanged desktop session bearer.';

create or replace function public.revoke_hivra_remote_desktop_session_by_token(
  p_session_token_hash text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  v_state text;
begin
  if p_session_token_hash is null
    or p_session_token_hash !~ '^[a-f0-9]{64}$'
    or p_reason not in ('connection_closed','computer_stopping','security_event')
  then return jsonb_build_object('status','denied'); end if;

  select * into s
  from public.hivra_remote_desktop_sessions
  where session_token_hash=p_session_token_hash
  for update;
  if not found then return jsonb_build_object('status','denied'); end if;

  if s.revoked_at is not null then
    return jsonb_build_object(
      'status','revoked',
      'sessionId',s.id,
      'inputState',s.input_state
    );
  end if;

  v_state:=case
    when s.input_state='active' then 'release-pending'
    when s.input_role='controller' then 'released'
    else s.input_state
  end;
  update public.hivra_remote_desktop_sessions
  set revoked_at=clock_timestamp(),
      revoke_reason=p_reason,
      input_state=v_state,
      control_released_at=case
        when v_state='released' then clock_timestamp()
        else control_released_at
      end,
      updated_at=clock_timestamp()
  where id=s.id;

  return jsonb_build_object(
    'status','revoked',
    'sessionId',s.id,
    'inputState',v_state
  );
end;
$$;

revoke all on function public.revoke_hivra_remote_desktop_session_by_token(text,text)
  from public,anon,authenticated;
grant execute on function public.revoke_hivra_remote_desktop_session_by_token(text,text)
  to service_role;

comment on function public.revoke_hivra_remote_desktop_session_by_token(text,text) is
  'Service-only guest termination for the exact exchanged desktop session bearer.';
