-- Rolling server-side lease renewal for an already exchanged Selkies session.
--
-- The browser still receives no bearer. The guest broker may extend only its
-- exact active controller session, for at most five minutes at a time and at
-- most twelve hours from the immutable row creation time. Capability,
-- ownership, runtime generation, transport, and computer readiness are
-- rechecked on every renewal.

alter table public.hivra_remote_desktop_sessions
  add column if not exists renewal_count integer not null default 0,
  add column if not exists last_renewed_at timestamptz;

alter table public.hivra_remote_desktop_sessions
  drop constraint if exists hivra_remote_desktop_continuous_window;
alter table public.hivra_remote_desktop_sessions
  add constraint hivra_remote_desktop_continuous_window check (
    expires_at <= created_at + interval '12 hours'
  );

alter table public.hivra_remote_desktop_sessions
  drop constraint if exists hivra_remote_desktop_renewal_count;
alter table public.hivra_remote_desktop_sessions
  add constraint hivra_remote_desktop_renewal_count check (
    renewal_count between 0 and 240
  );

create or replace function public.renew_hivra_remote_desktop_session_by_token(
  p_session_token_hash text,
  p_ttl_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  c public.hivra_remote_desktop_capabilities%rowtype;
  v_computer_kind text;
  v_computer_id uuid;
  v_owner_active boolean:=false;
  v_now timestamptz;
  v_expires_at timestamptz;
begin
  if p_session_token_hash is null
    or p_session_token_hash !~ '^[a-f0-9]{64}$'
    or p_ttl_seconds is null
    or p_ttl_seconds not between 30 and 300
  then return jsonb_build_object('status','denied'); end if;

  select computer_kind,computer_id into v_computer_kind,v_computer_id
  from public.hivra_remote_desktop_sessions
  where session_token_hash=p_session_token_hash;
  if not found then return jsonb_build_object('status','denied'); end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'hivra-remote-desktop-v1:'||v_computer_kind||':'||v_computer_id::text,0));

  select * into s
  from public.hivra_remote_desktop_sessions
  where session_token_hash=p_session_token_hash
  for update;
  v_now:=clock_timestamp();
  if not found
    or s.exchanged_at is null
    or s.revoked_at is not null
    or s.expires_at<=v_now
    or s.input_role<>'controller'
    or s.input_state<>'active'
    or s.transport<>'selkies-websocket'
    or s.relay_credential_expires_at is not null
    or s.renewal_count>=240
  then return jsonb_build_object('status','denied'); end if;

  select * into c
  from public.hivra_remote_desktop_capabilities
  where computer_kind=s.computer_kind
    and computer_id=s.computer_id
    and user_id=s.user_id
    and generation=s.capability_generation
    and revoked_at is null
  for update;
  if not found
    or c.expires_at<=v_now+interval '30 seconds'
    or not (s.transport=any(c.installed_transports))
    or c.compositor<>'x11'
    or not c.supports_input_takeover
  then return jsonb_build_object('status','capability_unavailable'); end if;

  if s.computer_kind='hermes-instance' then
    select exists(select 1 from public.hermes_instances
      where id=s.computer_id and user_id=s.user_id and status='running')
      into v_owner_active;
  else
    select exists(select 1 from public.hivra_agents
      where id=s.computer_id and user_id=s.user_id
        and status='running' and desired_state='running')
      into v_owner_active;
  end if;
  if not v_owner_active then
    return jsonb_build_object('status','computer_not_ready');
  end if;

  if exists(
    select 1 from public.hivra_remote_desktop_sessions other
    where other.computer_kind=s.computer_kind
      and other.computer_id=s.computer_id
      and other.id<>s.id
      and other.input_role='controller'
      and (
        (other.revoked_at is null and other.expires_at>v_now
          and other.input_state in ('takeover-pending','active'))
        or other.input_state='release-pending'
      )
  ) then return jsonb_build_object('status','controller_conflict'); end if;

  v_expires_at:=least(
    v_now+make_interval(secs=>p_ttl_seconds),
    c.expires_at,
    s.created_at+interval '12 hours'
  );
  if v_expires_at<=v_now+interval '30 seconds' then
    return jsonb_build_object('status','renewal_window_complete');
  end if;

  update public.hivra_remote_desktop_sessions
  set issued_at=v_now,
      expires_at=v_expires_at,
      renewal_count=renewal_count+1,
      last_renewed_at=v_now,
      updated_at=v_now
  where id=s.id;

  return jsonb_build_object(
    'status','renewed',
    'sessionId',s.id,
    'computerKind',s.computer_kind,
    'computerId',s.computer_id,
    'capabilityGeneration',s.capability_generation,
    'transport',s.transport,
    'inputRole',s.input_role,
    'inputReady',true,
    'expiresAt',v_expires_at,
    'continuousExpiresAt',s.created_at+interval '12 hours',
    'renewalCount',s.renewal_count+1
  );
end;
$$;

revoke all on function public.renew_hivra_remote_desktop_session_by_token(text,integer)
  from public,anon,authenticated;
grant execute on function public.renew_hivra_remote_desktop_session_by_token(text,integer)
  to service_role;

comment on function public.renew_hivra_remote_desktop_session_by_token(text,integer) is
  'Service-only rolling lease renewal for one active exchanged Selkies controller bearer; browser credentials and cookies are not accepted.';
comment on column public.hivra_remote_desktop_sessions.last_renewed_at is
  'Most recent successful rolling-lease renewal; created_at remains the immutable continuous-session start.';
