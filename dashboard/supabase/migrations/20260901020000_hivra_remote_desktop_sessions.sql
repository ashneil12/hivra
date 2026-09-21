-- Hivra remote-desktop capability and session authority.
--
-- This is deliberately transport-agnostic. A guest/broker first publishes a
-- short-lived capability receipt bound to an owned, running computer and its
-- exact runtime revision. Only then may the owner mint a one-time PKCE code.
-- Exchange stores only hashes and yields a five-minute bearer. Controller
-- issuance is serialized per computer, and input is denied until the guest
-- confirms that agent input has been suspended for the human takeover.

create table if not exists public.hivra_remote_desktop_capabilities (
  computer_kind text not null check (computer_kind in ('hermes-instance','hivra-agent')),
  computer_id uuid not null,
  user_id text not null check (char_length(user_id) between 1 and 256),
  generation uuid not null,
  observed_revision text not null check (observed_revision ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  compositor text not null check (compositor in ('x11','wayland','windows')),
  installed_transports text[] not null check (
    cardinality(installed_transports) > 0
    and installed_transports <@ array[
      'sunshine-moonlight','selkies-webrtc','selkies-websocket','recovery-console'
    ]::text[]
  ),
  private_network_reachable boolean not null,
  supports_input_takeover boolean not null default false,
  broker_origin text not null check (
    broker_origin ~ '^https://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'
  ),
  attestation jsonb not null,
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (computer_kind,computer_id),
  constraint hivra_remote_desktop_capability_window check (
    expires_at > observed_at and expires_at <= observed_at + interval '10 minutes'
  )
);

create table if not exists public.hivra_remote_desktop_sessions (
  id uuid primary key,
  user_id text not null check (char_length(user_id) between 1 and 256),
  computer_kind text not null check (computer_kind in ('hermes-instance','hivra-agent')),
  computer_id uuid not null,
  capability_generation uuid not null,
  transport text not null check (transport in (
    'sunshine-moonlight','selkies-webrtc','selkies-websocket','recovery-console'
  )),
  input_role text not null check (input_role in ('controller','viewer')),
  input_state text not null check (input_state in (
    'not-requested','takeover-pending','active','release-pending','released'
  )),
  audience text not null,
  handoff text not null check (handoff in ('cookie','message')),
  exchange_code_hash text not null unique check (exchange_code_hash ~ '^[a-f0-9]{64}$'),
  pkce_challenge text not null check (pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  session_token_hash text unique check (
    session_token_hash is null or session_token_hash ~ '^[a-f0-9]{64}$'
  ),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  relay_credential_expires_at timestamptz,
  exchanged_at timestamptz,
  takeover_receipt jsonb,
  release_receipt jsonb,
  last_authorized_at timestamptz,
  control_released_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hivra_remote_desktop_session_window check (
    expires_at > issued_at and expires_at <= issued_at + interval '5 minutes'
  ),
  constraint hivra_remote_desktop_relay_window check (
    relay_credential_expires_at is null
    or (relay_credential_expires_at > issued_at and relay_credential_expires_at <= expires_at)
  ),
  constraint hivra_remote_desktop_audience_shape check (
    audience = 'hivra-computer:' || computer_kind || ':' || computer_id::text || ':desktop'
  ),
  constraint hivra_remote_desktop_input_shape check (
    (input_role='viewer' and input_state='not-requested')
    or (input_role='controller' and input_state<>'not-requested')
  )
);

create index if not exists hivra_remote_desktop_sessions_computer_idx
  on public.hivra_remote_desktop_sessions(computer_kind,computer_id,expires_at desc);
create index if not exists hivra_remote_desktop_sessions_token_idx
  on public.hivra_remote_desktop_sessions(session_token_hash)
  where session_token_hash is not null;

alter table public.hivra_remote_desktop_capabilities enable row level security;
alter table public.hivra_remote_desktop_sessions enable row level security;
revoke all on table public.hivra_remote_desktop_capabilities from public,anon,authenticated;
revoke all on table public.hivra_remote_desktop_sessions from public,anon,authenticated;
grant select on table public.hivra_remote_desktop_capabilities to service_role;
grant select on table public.hivra_remote_desktop_sessions to service_role;

create or replace function public.record_hivra_remote_desktop_capability(
  p_user_id text,p_computer_kind text,p_computer_id uuid,p_generation uuid,
  p_receipt jsonb,p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_observed_at timestamptz;
  v_transports text[];
  v_owner_active boolean:=false;
  v_existing public.hivra_remote_desktop_capabilities%rowtype;
begin
  if p_user_id is null or char_length(p_user_id) not between 1 and 256
    or p_computer_kind not in ('hermes-instance','hivra-agent')
    or p_computer_id is null or p_generation is null
    or p_expires_at is null or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
    or not (p_receipt ?& array[
      'protocol','computerKind','computerId','capabilityGeneration','observedRevision',
      'compositor','installedTransports','privateNetworkReachable',
      'supportsInputTakeover','brokerOrigin','observedAt'
    ])
    or p_receipt-array[
      'protocol','computerKind','computerId','capabilityGeneration','observedRevision',
      'compositor','installedTransports','privateNetworkReachable',
      'supportsInputTakeover','brokerOrigin','observedAt'
    ]<>'{}'::jsonb
    or jsonb_typeof(p_receipt->'protocol')<>'string'
    or jsonb_typeof(p_receipt->'computerKind')<>'string'
    or jsonb_typeof(p_receipt->'computerId')<>'string'
    or jsonb_typeof(p_receipt->'capabilityGeneration')<>'string'
    or jsonb_typeof(p_receipt->'observedRevision')<>'string'
    or jsonb_typeof(p_receipt->'compositor')<>'string'
    or jsonb_typeof(p_receipt->'installedTransports')<>'array'
    or jsonb_typeof(p_receipt->'privateNetworkReachable')<>'boolean'
    or jsonb_typeof(p_receipt->'supportsInputTakeover')<>'boolean'
    or jsonb_typeof(p_receipt->'brokerOrigin')<>'string'
    or jsonb_typeof(p_receipt->'observedAt')<>'string' then
    return jsonb_build_object('status','invalid_receipt');
  end if;
  begin
    v_observed_at:=(p_receipt->>'observedAt')::timestamptz;
  exception when others then
    return jsonb_build_object('status','invalid_receipt');
  end;
  if p_receipt->>'protocol'<>'hivra-remote-desktop-capability-v1'
    or p_receipt->>'computerKind'<>p_computer_kind
    or p_receipt->>'computerId'<>p_computer_id::text
    or p_receipt->>'capabilityGeneration'<>p_generation::text
    or p_receipt->>'observedRevision' !~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
    or p_receipt->>'compositor' not in ('x11','wayland','windows')
    or p_receipt->>'brokerOrigin' !~ '^https://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'
    or v_observed_at > clock_timestamp() + interval '1 minute'
    or v_observed_at < clock_timestamp() - interval '5 minutes'
    or p_expires_at <= clock_timestamp()
    or p_expires_at > v_observed_at + interval '10 minutes' then
    return jsonb_build_object('status','invalid_receipt');
  end if;
  if exists(select 1 from jsonb_array_elements(p_receipt->'installedTransports') e where jsonb_typeof(e)<>'string') then
    return jsonb_build_object('status','invalid_receipt');
  end if;
  select coalesce(array_agg(value order by value),'{}'::text[]) into v_transports
    from (select distinct jsonb_array_elements_text(p_receipt->'installedTransports') value) valueset;
  if cardinality(v_transports)=0 or not (v_transports <@ array[
    'sunshine-moonlight','selkies-webrtc','selkies-websocket','recovery-console'
  ]::text[]) then
    return jsonb_build_object('status','invalid_receipt');
  end if;
  if p_computer_kind='hermes-instance' then
    select exists(select 1 from public.hermes_instances
      where id=p_computer_id and user_id=p_user_id and status='running') into v_owner_active;
  else
    select exists(select 1 from public.hivra_agents
      where id=p_computer_id and user_id=p_user_id and status='running' and desired_state='running') into v_owner_active;
  end if;
  if not v_owner_active then return jsonb_build_object('status','computer_not_ready'); end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'hivra-remote-desktop-v1:'||p_computer_kind||':'||p_computer_id::text,0));
  select * into v_existing from public.hivra_remote_desktop_capabilities
    where computer_kind=p_computer_kind and computer_id=p_computer_id for update;
  if found and v_existing.generation=p_generation and (
    v_existing.revoked_at is not null
    or v_existing.user_id<>p_user_id
    or v_existing.observed_revision<>p_receipt->>'observedRevision'
    or v_existing.compositor<>p_receipt->>'compositor'
    or v_existing.installed_transports is distinct from v_transports
    or v_existing.private_network_reachable is distinct from (p_receipt->>'privateNetworkReachable')::boolean
    or v_existing.supports_input_takeover is distinct from (p_receipt->>'supportsInputTakeover')::boolean
    or v_existing.broker_origin<>p_receipt->>'brokerOrigin'
  ) then
    return jsonb_build_object('status','generation_conflict');
  end if;
  update public.hivra_remote_desktop_sessions set
    revoked_at=coalesce(revoked_at,clock_timestamp()),
    revoke_reason=coalesce(revoke_reason,'capability_rotated'),
    input_state=case when input_state='active' then 'release-pending' else
      case when input_role='controller' then 'released' else input_state end end,
    control_released_at=case when input_state='active' then control_released_at else
      case when input_role='controller' then clock_timestamp() else control_released_at end end,
    updated_at=clock_timestamp()
  where computer_kind=p_computer_kind and computer_id=p_computer_id
    and capability_generation<>p_generation and revoked_at is null;

  insert into public.hivra_remote_desktop_capabilities(
    computer_kind,computer_id,user_id,generation,observed_revision,compositor,
    installed_transports,private_network_reachable,supports_input_takeover,
    broker_origin,attestation,observed_at,expires_at,revoked_at
  ) values (
    p_computer_kind,p_computer_id,p_user_id,p_generation,p_receipt->>'observedRevision',
    p_receipt->>'compositor',v_transports,(p_receipt->>'privateNetworkReachable')::boolean,
    (p_receipt->>'supportsInputTakeover')::boolean,p_receipt->>'brokerOrigin',p_receipt,
    v_observed_at,p_expires_at,null
  ) on conflict(computer_kind,computer_id) do update set
    user_id=excluded.user_id,generation=excluded.generation,
    observed_revision=excluded.observed_revision,compositor=excluded.compositor,
    installed_transports=excluded.installed_transports,
    private_network_reachable=excluded.private_network_reachable,
    supports_input_takeover=excluded.supports_input_takeover,
    broker_origin=excluded.broker_origin,attestation=excluded.attestation,
    observed_at=excluded.observed_at,expires_at=excluded.expires_at,
    revoked_at=null,updated_at=clock_timestamp();
  return jsonb_build_object('status','ready','generation',p_generation);
end;
$$;

create or replace function public.issue_hivra_remote_desktop_session(
  p_user_id text,p_session_id uuid,p_computer_kind text,p_computer_id uuid,
  p_transport text,p_input_role text,p_handoff text,p_exchange_code_hash text,
  p_pkce_challenge text,p_issued_at timestamptz,p_expires_at timestamptz,
  p_relay_credential_expires_at timestamptz
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
      relay_credential_expires_at
    ) values (
      p_session_id,p_user_id,p_computer_kind,p_computer_id,c.generation,p_transport,
      p_input_role,v_input_state,v_audience,p_handoff,p_exchange_code_hash,p_pkce_challenge,
      p_issued_at,p_expires_at,p_relay_credential_expires_at
    );
  exception when unique_violation then
    return jsonb_build_object('status','operation_conflict');
  end;
  return jsonb_build_object(
    'status','issued','sessionId',p_session_id,'computerKind',p_computer_kind,
    'computerId',p_computer_id,'capabilityGeneration',c.generation,'transport',p_transport,
    'inputRole',p_input_role,'audience',v_audience,'handoff',p_handoff,
    'brokerOrigin',c.broker_origin,'issuedAt',p_issued_at,'expiresAt',p_expires_at,
    'relayCredentialExpiresAt',p_relay_credential_expires_at
  );
end;
$$;

create or replace function public.exchange_hivra_remote_desktop_session(
  p_exchange_code_hash text,p_pkce_challenge text,p_session_token_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  c public.hivra_remote_desktop_capabilities%rowtype;
  v_owner_active boolean:=false;
begin
  if p_exchange_code_hash is null or p_exchange_code_hash !~ '^[a-f0-9]{64}$'
    or p_pkce_challenge is null or p_pkce_challenge !~ '^[A-Za-z0-9_-]{43}$'
    or p_session_token_hash is null or p_session_token_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status','invalid');
  end if;
  select * into s from public.hivra_remote_desktop_sessions
    where exchange_code_hash=p_exchange_code_hash for update;
  if not found then return jsonb_build_object('status','invalid'); end if;
  if s.exchanged_at is not null then return jsonb_build_object('status','already_used'); end if;
  if s.revoked_at is not null then return jsonb_build_object('status','revoked'); end if;
  if s.issued_at>clock_timestamp() then return jsonb_build_object('status','not_yet_valid'); end if;
  if s.expires_at<=clock_timestamp() then return jsonb_build_object('status','expired'); end if;
  if s.pkce_challenge<>p_pkce_challenge then return jsonb_build_object('status','invalid'); end if;
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=s.computer_kind and computer_id=s.computer_id
      and generation=s.capability_generation and user_id=s.user_id
      and revoked_at is null and expires_at>clock_timestamp();
  if not found or not (s.transport=any(c.installed_transports)) then
    return jsonb_build_object('status','capability_unavailable');
  end if;
  if (s.transport in ('selkies-webrtc','selkies-websocket') and c.compositor<>'x11')
    or (s.transport='sunshine-moonlight' and not c.private_network_reachable) then
    return jsonb_build_object('status','capability_unavailable');
  end if;
  if s.computer_kind='hermes-instance' then
    select exists(select 1 from public.hermes_instances
      where id=s.computer_id and user_id=s.user_id and status='running') into v_owner_active;
  else
    select exists(select 1 from public.hivra_agents
      where id=s.computer_id and user_id=s.user_id and status='running' and desired_state='running') into v_owner_active;
  end if;
  if not v_owner_active then return jsonb_build_object('status','computer_not_ready'); end if;
  begin
    update public.hivra_remote_desktop_sessions set session_token_hash=p_session_token_hash,
      exchanged_at=clock_timestamp(),updated_at=clock_timestamp() where id=s.id;
  exception when unique_violation then
    return jsonb_build_object('status','operation_conflict');
  end;
  return jsonb_build_object(
    'status','exchanged','sessionId',s.id,'computerKind',s.computer_kind,
    'computerId',s.computer_id,'capabilityGeneration',s.capability_generation,
    'transport',s.transport,'inputRole',s.input_role,'inputReady',false,
    'audience',s.audience,'brokerOrigin',c.broker_origin,'expiresAt',s.expires_at
  );
end;
$$;

create or replace function public.confirm_hivra_remote_desktop_takeover(
  p_user_id text,p_session_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.hivra_remote_desktop_sessions%rowtype;
  v_observed_at timestamptz;
begin
  select * into s from public.hivra_remote_desktop_sessions
    where id=p_session_id and user_id=p_user_id for update;
  if not found or s.input_role<>'controller' or s.input_state<>'takeover-pending'
    or s.exchanged_at is null or s.revoked_at is not null or s.expires_at<=clock_timestamp()
    or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
    or not (p_receipt ?& array['protocol','action','sessionId','computerKind','computerId',
      'capabilityGeneration','transport','agentInputSuspended','controllerCount','observedAt'])
    or p_receipt-array['protocol','action','sessionId','computerKind','computerId',
      'capabilityGeneration','transport','agentInputSuspended','controllerCount','observedAt']<>'{}'::jsonb
    or jsonb_typeof(p_receipt->'protocol')<>'string'
    or jsonb_typeof(p_receipt->'action')<>'string'
    or jsonb_typeof(p_receipt->'sessionId')<>'string'
    or jsonb_typeof(p_receipt->'computerKind')<>'string'
    or jsonb_typeof(p_receipt->'computerId')<>'string'
    or jsonb_typeof(p_receipt->'capabilityGeneration')<>'string'
    or jsonb_typeof(p_receipt->'transport')<>'string'
    or jsonb_typeof(p_receipt->'agentInputSuspended')<>'boolean'
    or jsonb_typeof(p_receipt->'controllerCount')<>'number'
    or jsonb_typeof(p_receipt->'observedAt')<>'string' then return false; end if;
  begin
    v_observed_at:=(p_receipt->>'observedAt')::timestamptz;
  exception when others then return false;
  end;
  if p_receipt->>'protocol'<>'hivra-remote-desktop-input-v1'
    or p_receipt->>'action'<>'agent-input-suspended'
    or p_receipt->>'sessionId'<>s.id::text
    or p_receipt->>'computerKind'<>s.computer_kind
    or p_receipt->>'computerId'<>s.computer_id::text
    or p_receipt->>'capabilityGeneration'<>s.capability_generation::text
    or p_receipt->>'transport'<>s.transport
    or p_receipt->'agentInputSuspended'<>'true'::jsonb
    or p_receipt->>'controllerCount'<>'1'
    or v_observed_at>clock_timestamp()+interval '1 minute'
    or v_observed_at<clock_timestamp()-interval '2 minutes' then return false; end if;
  if not exists(select 1 from public.hivra_remote_desktop_capabilities c
    where c.computer_kind=s.computer_kind and c.computer_id=s.computer_id
      and c.user_id=s.user_id and c.generation=s.capability_generation
      and c.supports_input_takeover and c.revoked_at is null and c.expires_at>clock_timestamp())
  then return false; end if;
  update public.hivra_remote_desktop_sessions set input_state='active',takeover_receipt=p_receipt,
    updated_at=clock_timestamp() where id=s.id;
  return true;
end;
$$;

create or replace function public.authorize_hivra_remote_desktop_session(
  p_session_token_hash text,p_computer_kind text,p_computer_id uuid,
  p_transport text,p_wants_input boolean
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  s public.hivra_remote_desktop_sessions%rowtype;
  c public.hivra_remote_desktop_capabilities%rowtype;
  v_owner_active boolean:=false;
begin
  if p_session_token_hash is null or p_session_token_hash !~ '^[a-f0-9]{64}$'
    or p_computer_kind is null or p_computer_kind not in ('hermes-instance','hivra-agent')
    or p_computer_id is null or p_transport is null or p_transport not in (
      'sunshine-moonlight','selkies-webrtc','selkies-websocket','recovery-console')
    or p_wants_input is null then return jsonb_build_object('status','denied'); end if;
  select * into s from public.hivra_remote_desktop_sessions
    where session_token_hash=p_session_token_hash for update;
  if not found or s.computer_kind<>p_computer_kind or s.computer_id<>p_computer_id
    or s.transport<>p_transport or s.exchanged_at is null or s.revoked_at is not null
    or s.issued_at>clock_timestamp()
    or s.expires_at<=clock_timestamp()
    or (p_wants_input and (s.input_role<>'controller' or s.input_state<>'active')) then
    return jsonb_build_object('status','denied');
  end if;
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=s.computer_kind and computer_id=s.computer_id
      and user_id=s.user_id and generation=s.capability_generation
      and revoked_at is null and expires_at>clock_timestamp();
  if not found or not (s.transport=any(c.installed_transports)) then
    return jsonb_build_object('status','denied');
  end if;
  if (s.transport in ('selkies-webrtc','selkies-websocket') and c.compositor<>'x11')
    or (s.transport='sunshine-moonlight' and not c.private_network_reachable) then
    return jsonb_build_object('status','denied');
  end if;
  if s.computer_kind='hermes-instance' then
    select exists(select 1 from public.hermes_instances
      where id=s.computer_id and user_id=s.user_id and status='running') into v_owner_active;
  else
    select exists(select 1 from public.hivra_agents
      where id=s.computer_id and user_id=s.user_id and status='running' and desired_state='running') into v_owner_active;
  end if;
  if not v_owner_active then return jsonb_build_object('status','denied'); end if;
  update public.hivra_remote_desktop_sessions set last_authorized_at=clock_timestamp(),
    updated_at=clock_timestamp() where id=s.id;
  return jsonb_build_object(
    'status','authorized','sessionId',s.id,'userId',s.user_id,'audience',s.audience,
    'computerKind',s.computer_kind,'computerId',s.computer_id,
    'capabilityGeneration',s.capability_generation,'transport',s.transport,
    'inputRole',s.input_role,'inputReady',(s.input_state='active'),
    'expiresAt',s.expires_at
  );
end;
$$;

create or replace function public.revoke_hivra_remote_desktop_session(
  p_user_id text,p_session_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.hivra_remote_desktop_sessions%rowtype; v_state text;
begin
  if p_reason is null
    or p_reason not in ('user_revoked','handoff_abandoned','connection_closed','computer_stopping','security_event')
  then return jsonb_build_object('status','invalid_request'); end if;
  select * into s from public.hivra_remote_desktop_sessions
    where id=p_session_id and user_id=p_user_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if s.revoked_at is not null then
    return jsonb_build_object('status','revoked','inputState',s.input_state);
  end if;
  v_state:=case when s.input_state='active' then 'release-pending'
    when s.input_role='controller' then 'released' else s.input_state end;
  update public.hivra_remote_desktop_sessions set revoked_at=clock_timestamp(),
    revoke_reason=p_reason,input_state=v_state,
    control_released_at=case when v_state='released' then clock_timestamp() else control_released_at end,
    updated_at=clock_timestamp() where id=s.id;
  return jsonb_build_object('status','revoked','inputState',v_state);
end;
$$;

create or replace function public.confirm_hivra_remote_desktop_release(
  p_user_id text,p_session_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.hivra_remote_desktop_sessions%rowtype;
  v_observed_at timestamptz;
begin
  select * into s from public.hivra_remote_desktop_sessions
    where id=p_session_id and user_id=p_user_id for update;
  if not found or s.input_role<>'controller' or s.input_state<>'release-pending'
    or s.revoked_at is null or p_receipt is null or jsonb_typeof(p_receipt)<>'object'
    or not (p_receipt ?& array['protocol','action','sessionId','computerKind','computerId',
      'capabilityGeneration','transport','agentInputSuspended','controllerCount','observedAt'])
    or p_receipt-array['protocol','action','sessionId','computerKind','computerId',
      'capabilityGeneration','transport','agentInputSuspended','controllerCount','observedAt']<>'{}'::jsonb
    or jsonb_typeof(p_receipt->'protocol')<>'string'
    or jsonb_typeof(p_receipt->'action')<>'string'
    or jsonb_typeof(p_receipt->'sessionId')<>'string'
    or jsonb_typeof(p_receipt->'computerKind')<>'string'
    or jsonb_typeof(p_receipt->'computerId')<>'string'
    or jsonb_typeof(p_receipt->'capabilityGeneration')<>'string'
    or jsonb_typeof(p_receipt->'transport')<>'string'
    or jsonb_typeof(p_receipt->'agentInputSuspended')<>'boolean'
    or jsonb_typeof(p_receipt->'controllerCount')<>'number'
    or jsonb_typeof(p_receipt->'observedAt')<>'string' then return false; end if;
  begin
    v_observed_at:=(p_receipt->>'observedAt')::timestamptz;
  exception when others then return false;
  end;
  if p_receipt->>'protocol'<>'hivra-remote-desktop-input-v1'
    or p_receipt->>'action'<>'agent-input-resumed'
    or p_receipt->>'sessionId'<>s.id::text
    or p_receipt->>'computerKind'<>s.computer_kind
    or p_receipt->>'computerId'<>s.computer_id::text
    or p_receipt->>'capabilityGeneration'<>s.capability_generation::text
    or p_receipt->>'transport'<>s.transport
    or p_receipt->'agentInputSuspended'<>'false'::jsonb
    or p_receipt->>'controllerCount'<>'0'
    or v_observed_at>clock_timestamp()+interval '1 minute'
    or v_observed_at<clock_timestamp()-interval '2 minutes' then return false; end if;
  update public.hivra_remote_desktop_sessions set input_state='released',release_receipt=p_receipt,
    control_released_at=clock_timestamp(),updated_at=clock_timestamp() where id=s.id;
  return true;
end;
$$;

create or replace function public.revoke_hivra_remote_desktop_capability(
  p_user_id text,p_computer_kind text,p_computer_id uuid,p_generation uuid
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'hivra-remote-desktop-v1:'||p_computer_kind||':'||p_computer_id::text,0));
  update public.hivra_remote_desktop_capabilities set revoked_at=clock_timestamp(),
    updated_at=clock_timestamp() where user_id=p_user_id and computer_kind=p_computer_kind
    and computer_id=p_computer_id and generation=p_generation and revoked_at is null;
  if not found then return false; end if;
  update public.hivra_remote_desktop_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()),
    revoke_reason=coalesce(revoke_reason,'computer_stopping'),
    input_state=case when input_state='active' then 'release-pending'
      when input_role='controller' then 'released' else input_state end,
    control_released_at=case when input_state='active' then control_released_at
      when input_role='controller' then clock_timestamp() else control_released_at end,
    updated_at=clock_timestamp()
    where user_id=p_user_id and computer_kind=p_computer_kind and computer_id=p_computer_id
      and capability_generation=p_generation and revoked_at is null;
  return true;
end;
$$;

revoke all on function public.record_hivra_remote_desktop_capability(text,text,uuid,uuid,jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.issue_hivra_remote_desktop_session(text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.exchange_hivra_remote_desktop_session(text,text,text) from public,anon,authenticated;
revoke all on function public.confirm_hivra_remote_desktop_takeover(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.authorize_hivra_remote_desktop_session(text,text,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.revoke_hivra_remote_desktop_session(text,uuid,text) from public,anon,authenticated;
revoke all on function public.confirm_hivra_remote_desktop_release(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.revoke_hivra_remote_desktop_capability(text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.record_hivra_remote_desktop_capability(text,text,uuid,uuid,jsonb,timestamptz) to service_role;
grant execute on function public.issue_hivra_remote_desktop_session(text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz) to service_role;
grant execute on function public.exchange_hivra_remote_desktop_session(text,text,text) to service_role;
grant execute on function public.confirm_hivra_remote_desktop_takeover(text,uuid,jsonb) to service_role;
grant execute on function public.authorize_hivra_remote_desktop_session(text,text,uuid,text,boolean) to service_role;
grant execute on function public.revoke_hivra_remote_desktop_session(text,uuid,text) to service_role;
grant execute on function public.confirm_hivra_remote_desktop_release(text,uuid,jsonb) to service_role;
grant execute on function public.revoke_hivra_remote_desktop_capability(text,text,uuid,uuid) to service_role;

comment on table public.hivra_remote_desktop_capabilities is
  'Service-only, short-lived guest capability receipts. Presence is observed readiness, not launch permission.';
comment on table public.hivra_remote_desktop_sessions is
  'Service-only, hashed remote-desktop grants. One-time exchange, five-minute maximum TTL, revocable, and single-controller.';
