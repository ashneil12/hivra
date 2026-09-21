-- Buzz is an account/workspace collaboration connection, not an infrastructure
-- provider. Every bound agent owns one distinct Nostr identity. Secret keys and
-- invite codes remain encrypted server-side and every external side effect is
-- journaled before it can reach the relay.

create table public.hivra_buzz_connections (
  id uuid primary key,
  user_id text not null,
  relay_url text not null,
  http_origin text not null,
  relay_public_key text not null,
  display_name text not null,
  software text,
  relay_version text,
  requires_membership boolean not null,
  revision bigint not null default 1,
  status text not null default 'ready',
  observed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hivra_buzz_connection_relay_url check (
    relay_url ~ '^wss://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'
  ),
  constraint hivra_buzz_connection_http_origin check (
    http_origin ~ '^https://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'
  ),
  constraint hivra_buzz_connection_key check (relay_public_key ~ '^[a-f0-9]{64}$'),
  constraint hivra_buzz_connection_name check (char_length(display_name) between 1 and 160),
  constraint hivra_buzz_connection_private_membership check (requires_membership),
  constraint hivra_buzz_connection_revision check (revision >= 1),
  constraint hivra_buzz_connection_status check (status in ('ready','disconnected')),
  unique (user_id, relay_url),
  unique (id, user_id),
  unique (id, user_id, revision, relay_public_key)
);

create table public.hivra_buzz_agent_bindings (
  id uuid primary key,
  user_id text not null,
  connection_id uuid not null,
  connection_revision bigint not null,
  relay_public_key text not null,
  agent_id uuid not null,
  operation_id uuid not null unique,
  request_digest text not null,
  public_key text not null,
  encrypted_private_key text,
  encrypted_invite_code text,
  status text not null default 'claim_pending',
  claim_receipt jsonb,
  leave_receipt jsonb,
  health_receipt jsonb,
  last_health_at timestamptz,
  last_error_code text,
  lease_id uuid,
  lease_expires_at timestamptz,
  joined_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- Ownership is immutable; relay revision/key are an evidence snapshot. A
  -- relay may legitimately rotate its key only after every prior identity is
  -- revoked, so the historical snapshot must not be an FK to mutable current
  -- connection evidence.
  foreign key (connection_id,user_id)
    references public.hivra_buzz_connections(id,user_id),
  foreign key (agent_id) references public.hivra_agents(id),
  constraint hivra_buzz_binding_digest check (request_digest ~ '^[a-f0-9]{64}$'),
  constraint hivra_buzz_binding_public_key check (public_key ~ '^[a-f0-9]{64}$'),
  constraint hivra_buzz_binding_relay_key check (relay_public_key ~ '^[a-f0-9]{64}$'),
  constraint hivra_buzz_binding_distinct_identity check (public_key <> relay_public_key),
  constraint hivra_buzz_binding_status check (
    status in ('claim_pending','joined','leave_pending','revoked')
  ),
  constraint hivra_buzz_binding_custody check (
    (status='claim_pending' and encrypted_private_key is not null and encrypted_invite_code is not null
      and claim_receipt is null and joined_at is null and revoked_at is null)
    or (status in ('joined','leave_pending') and encrypted_private_key is not null
      and encrypted_invite_code is null and claim_receipt is not null and joined_at is not null and revoked_at is null)
    or (status='revoked' and encrypted_private_key is null and encrypted_invite_code is null
      and lease_id is null and lease_expires_at is null and revoked_at is not null)
  ),
  constraint hivra_buzz_binding_lease check (
    (lease_id is null)=(lease_expires_at is null)
  )
);

create unique index hivra_buzz_one_live_identity_per_agent
  on public.hivra_buzz_agent_bindings(connection_id,agent_id)
  where status in ('claim_pending','joined','leave_pending');
create index hivra_buzz_bindings_owner_idx
  on public.hivra_buzz_agent_bindings(user_id,created_at desc);

alter table public.hivra_buzz_connections enable row level security;
alter table public.hivra_buzz_agent_bindings enable row level security;
revoke all on public.hivra_buzz_connections from public,anon,authenticated;
revoke all on public.hivra_buzz_agent_bindings from public,anon,authenticated;
grant select on public.hivra_buzz_connections to service_role;
grant select on public.hivra_buzz_agent_bindings to service_role;

create function public.upsert_hivra_buzz_connection(
  p_user_id text,p_id uuid,p_relay_url text,p_http_origin text,p_relay_public_key text,
  p_display_name text,p_software text,p_relay_version text,p_requires_membership boolean
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.hivra_buzz_connections%rowtype;
begin
  if p_user_id is null or p_user_id='' or char_length(p_user_id)>256 or p_id is null
    or p_relay_url !~ '^wss://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'
    or p_http_origin !~ '^https://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'
    or p_relay_public_key !~ '^[a-f0-9]{64}$'
    or p_display_name is null or char_length(p_display_name) not between 1 and 160
    or p_requires_membership is distinct from true then
    raise exception 'invalid Buzz connection' using errcode='22023';
  end if;
  select * into c from public.hivra_buzz_connections
    where user_id=p_user_id and relay_url=p_relay_url for update;
  if found then
    if (c.relay_public_key<>p_relay_public_key or c.requires_membership<>p_requires_membership) and exists(
      select 1 from public.hivra_buzz_agent_bindings b where b.connection_id=c.id
        and b.user_id=p_user_id and b.status in ('claim_pending','joined','leave_pending')
    ) then
      raise exception 'Buzz relay identity changed with live bindings' using errcode='55006';
    end if;
    update public.hivra_buzz_connections set
      http_origin=p_http_origin,relay_public_key=p_relay_public_key,display_name=p_display_name,
      software=p_software,relay_version=p_relay_version,requires_membership=p_requires_membership,
      revision=case when relay_public_key=p_relay_public_key then revision else revision+1 end,
      status='ready',observed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=c.id;
    return c.id;
  end if;
  insert into public.hivra_buzz_connections(
    id,user_id,relay_url,http_origin,relay_public_key,display_name,software,relay_version,requires_membership
  ) values (
    p_id,p_user_id,p_relay_url,p_http_origin,p_relay_public_key,p_display_name,p_software,p_relay_version,p_requires_membership
  );
  return p_id;
end;
$$;

create function public.admit_hivra_buzz_binding(
  p_user_id text,p_binding_id uuid,p_connection_id uuid,p_agent_id uuid,p_operation_id uuid,
  p_request_digest text,p_public_key text,p_encrypted_private_key text,p_encrypted_invite_code text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.hivra_buzz_connections%rowtype; a public.hivra_agents%rowtype;
  b public.hivra_buzz_agent_bindings%rowtype;
begin
  if p_user_id is null or p_user_id='' or char_length(p_user_id)>256
    or p_binding_id is null or p_connection_id is null or p_agent_id is null or p_operation_id is null
    or p_request_digest !~ '^[a-f0-9]{64}$' or p_public_key !~ '^[a-f0-9]{64}$'
    or p_encrypted_private_key is null or p_encrypted_private_key=''
    or p_encrypted_invite_code is null or p_encrypted_invite_code='' then
    return jsonb_build_object('status','invalid_request');
  end if;
  select * into c from public.hivra_buzz_connections where id=p_connection_id
    and user_id=p_user_id and status='ready' for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and status<>'deleted' and desired_state<>'deleted' for update;
  if not found then return jsonb_build_object('status','agent_not_found'); end if;
  if c.relay_public_key=p_public_key then return jsonb_build_object('status','invalid_request'); end if;
  select * into b from public.hivra_buzz_agent_bindings where operation_id=p_operation_id for update;
  if found then
    if b.user_id=p_user_id and b.id=p_binding_id and b.connection_id=p_connection_id and b.agent_id=p_agent_id
      and b.request_digest=p_request_digest and b.public_key=p_public_key
      and b.connection_revision=c.revision and b.relay_public_key=c.relay_public_key then
      return jsonb_build_object('status',b.status,'bindingId',b.id);
    end if;
    return jsonb_build_object('status','operation_conflict');
  end if;
  select * into b from public.hivra_buzz_agent_bindings where connection_id=p_connection_id
    and agent_id=p_agent_id and status in ('claim_pending','joined','leave_pending') for update;
  if found then return jsonb_build_object('status','already_bound','bindingId',b.id); end if;
  insert into public.hivra_buzz_agent_bindings(
    id,user_id,connection_id,connection_revision,relay_public_key,agent_id,operation_id,
    request_digest,public_key,encrypted_private_key,encrypted_invite_code
  ) values (
    p_binding_id,p_user_id,p_connection_id,c.revision,c.relay_public_key,p_agent_id,p_operation_id,
    p_request_digest,p_public_key,p_encrypted_private_key,p_encrypted_invite_code
  );
  return jsonb_build_object('status','claim_pending','bindingId',p_binding_id);
exception when unique_violation then
  return jsonb_build_object('status','operation_conflict');
end;
$$;

create function public.claim_hivra_buzz_membership(
  p_user_id text,p_binding_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; v_lease uuid:=gen_random_uuid();
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found or b.status<>'claim_pending' or b.encrypted_private_key is null or b.encrypted_invite_code is null
    or (b.lease_expires_at is not null and b.lease_expires_at>clock_timestamp()) then return null; end if;
  if not exists(select 1 from public.hivra_buzz_connections c where c.id=b.connection_id and c.user_id=p_user_id
    and c.revision=b.connection_revision and c.relay_public_key=b.relay_public_key and c.status='ready')
    or not exists(select 1 from public.hivra_agents a where a.id=b.agent_id and a.user_id=p_user_id
      and a.status<>'deleted' and a.desired_state<>'deleted') then return null; end if;
  update public.hivra_buzz_agent_bindings set lease_id=v_lease,
    lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
    where id=b.id;
  return to_jsonb(b) || jsonb_build_object('lease_id',v_lease,
    'lease_expires_at',clock_timestamp()+interval '60 seconds');
end;
$$;

create function public.settle_hivra_buzz_membership(
  p_user_id text,p_binding_id uuid,p_lease_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; c public.hivra_buzz_connections%rowtype;
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found then return false; end if;
  if b.status='joined' then return b.claim_receipt is not distinct from p_receipt; end if;
  select * into c from public.hivra_buzz_connections where id=b.connection_id and user_id=p_user_id for update;
  if b.status<>'claim_pending' or p_lease_id is null or b.lease_id is distinct from p_lease_id
    or b.lease_expires_at is null or b.lease_expires_at<=clock_timestamp()
    or c.revision is distinct from b.connection_revision or c.relay_public_key is distinct from b.relay_public_key
    or p_receipt is null or jsonb_typeof(p_receipt) is distinct from 'object'
    or not (p_receipt ?& array['protocol','connectionId','connectionRevision','relayPublicKey','relayUrl','publicKey','status','communityId','host','role','rosterEventId','rosterCreatedAt','rosterMember'])
    or p_receipt-array['protocol','connectionId','connectionRevision','relayPublicKey','relayUrl','publicKey','status','communityId','host','role','rosterEventId','rosterCreatedAt','rosterMember']<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(p_receipt->'protocol')<>'string' or jsonb_typeof(p_receipt->'connectionId')<>'string'
    or jsonb_typeof(p_receipt->'connectionRevision')<>'number' or jsonb_typeof(p_receipt->'relayPublicKey')<>'string'
    or jsonb_typeof(p_receipt->'relayUrl')<>'string' or jsonb_typeof(p_receipt->'publicKey')<>'string'
    or jsonb_typeof(p_receipt->'status')<>'string' or jsonb_typeof(p_receipt->'communityId')<>'string'
    or jsonb_typeof(p_receipt->'host')<>'string' or jsonb_typeof(p_receipt->'role')<>'string'
    or jsonb_typeof(p_receipt->'rosterEventId')<>'string' or jsonb_typeof(p_receipt->'rosterCreatedAt')<>'number'
    or jsonb_typeof(p_receipt->'rosterMember')<>'boolean' then return false; end if;
  if p_receipt->>'protocol' is distinct from 'hivra-buzz-claim-v1'
    or p_receipt->>'connectionId' is distinct from b.connection_id::text
    or p_receipt->>'connectionRevision' is distinct from b.connection_revision::text
    or p_receipt->>'relayPublicKey' is distinct from b.relay_public_key
    or p_receipt->>'relayUrl' is distinct from c.relay_url
    or p_receipt->>'publicKey' is distinct from b.public_key
    or not (coalesce(p_receipt->>'status','') in ('joined','already_member'))
    or coalesce(p_receipt->>'communityId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    or p_receipt->>'host' is distinct from regexp_replace(c.http_origin,'^https://','')
    or p_receipt->>'role' is distinct from 'member'
    or p_receipt->>'rosterEventId' !~ '^[a-f0-9]{64}$'
    or p_receipt->>'rosterCreatedAt' !~ '^[0-9]+$'
    or p_receipt->'rosterMember' is distinct from 'true'::jsonb then return false; end if;
  update public.hivra_buzz_agent_bindings set status='joined',encrypted_invite_code=null,
    claim_receipt=p_receipt,lease_id=null,lease_expires_at=null,joined_at=clock_timestamp(),
    last_health_at=clock_timestamp(),last_error_code=null,updated_at=clock_timestamp()
    where id=b.id;
  return true;
end;
$$;

create function public.abandon_hivra_buzz_membership(
  p_user_id text,p_binding_id uuid,p_lease_id uuid,p_error_code text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_error_code not in ('invalid_invite','invite_expired','invite_exhausted','join_policy_required') then return false; end if;
  update public.hivra_buzz_agent_bindings set status='revoked',encrypted_private_key=null,
    encrypted_invite_code=null,lease_id=null,lease_expires_at=null,revoked_at=clock_timestamp(),
    last_error_code=p_error_code,updated_at=clock_timestamp()
  where id=p_binding_id and user_id=p_user_id and status='claim_pending' and lease_id=p_lease_id
    and lease_expires_at>clock_timestamp();
  return found;
end;
$$;

create function public.claim_hivra_buzz_leave(
  p_user_id text,p_binding_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; v_lease uuid:=gen_random_uuid();
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found or b.status not in ('joined','leave_pending') or b.encrypted_private_key is null
    or (b.lease_expires_at is not null and b.lease_expires_at>clock_timestamp()) then return null; end if;
  update public.hivra_buzz_agent_bindings set status='leave_pending',lease_id=v_lease,
    lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
    where id=b.id;
  return to_jsonb(b) || jsonb_build_object('status','leave_pending','lease_id',v_lease,
    'lease_expires_at',clock_timestamp()+interval '60 seconds');
end;
$$;

create function public.settle_hivra_buzz_leave(
  p_user_id text,p_binding_id uuid,p_lease_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; c public.hivra_buzz_connections%rowtype;
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found then return false; end if;
  if b.status='revoked' then return b.leave_receipt is not null and b.leave_receipt is not distinct from p_receipt; end if;
  select * into c from public.hivra_buzz_connections where id=b.connection_id and user_id=p_user_id;
  if b.status<>'leave_pending' or p_lease_id is null or b.lease_id is distinct from p_lease_id
    or b.lease_expires_at is null or b.lease_expires_at<=clock_timestamp()
    or c.revision is distinct from b.connection_revision or c.relay_public_key is distinct from b.relay_public_key
    or p_receipt is null or jsonb_typeof(p_receipt) is distinct from 'object'
    or not (p_receipt ?& array['protocol','connectionId','connectionRevision','relayPublicKey','relayUrl','publicKey','status','eventId','rosterEventId','rosterCreatedAt','rosterMember','observerPublicKey'])
    or p_receipt-array['protocol','connectionId','connectionRevision','relayPublicKey','relayUrl','publicKey','status','eventId','rosterEventId','rosterCreatedAt','rosterMember','observerPublicKey']<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(p_receipt->'protocol')<>'string' or jsonb_typeof(p_receipt->'connectionId')<>'string'
    or jsonb_typeof(p_receipt->'connectionRevision')<>'number' or jsonb_typeof(p_receipt->'relayPublicKey')<>'string'
    or jsonb_typeof(p_receipt->'relayUrl')<>'string' or jsonb_typeof(p_receipt->'publicKey')<>'string'
    or jsonb_typeof(p_receipt->'status')<>'string' or jsonb_typeof(p_receipt->'eventId') not in ('null','string')
    or jsonb_typeof(p_receipt->'rosterEventId')<>'string' or jsonb_typeof(p_receipt->'rosterCreatedAt')<>'number'
    or jsonb_typeof(p_receipt->'rosterMember')<>'boolean' or jsonb_typeof(p_receipt->'observerPublicKey')<>'string' then return false; end if;
  if p_receipt->>'protocol' is distinct from 'hivra-buzz-leave-v1'
    or p_receipt->>'connectionId' is distinct from b.connection_id::text
    or p_receipt->>'connectionRevision' is distinct from b.connection_revision::text
    or p_receipt->>'relayPublicKey' is distinct from b.relay_public_key
    or p_receipt->>'relayUrl' is distinct from c.relay_url
    or p_receipt->>'publicKey' is distinct from b.public_key
    or p_receipt->>'status' is distinct from 'left'
    or not (p_receipt->'eventId'='null'::jsonb or coalesce(p_receipt->>'eventId','') ~ '^[a-f0-9]{64}$')
    or p_receipt->>'rosterEventId' !~ '^[a-f0-9]{64}$'
    or p_receipt->>'rosterCreatedAt' !~ '^[0-9]+$'
    or p_receipt->'rosterMember' is distinct from 'false'::jsonb
    or p_receipt->>'observerPublicKey' !~ '^[a-f0-9]{64}$'
    or p_receipt->>'observerPublicKey'=b.public_key
    or not exists(select 1 from public.hivra_buzz_agent_bindings observer
      where observer.connection_id=b.connection_id and observer.user_id=p_user_id
        and observer.status='joined' and observer.public_key=p_receipt->>'observerPublicKey')
    or (p_receipt->>'rosterCreatedAt')::bigint < (b.claim_receipt->>'rosterCreatedAt')::bigint
    or p_receipt->>'rosterEventId' is not distinct from b.claim_receipt->>'rosterEventId' then return false; end if;
  update public.hivra_buzz_agent_bindings set status='revoked',encrypted_private_key=null,
    encrypted_invite_code=null,lease_id=null,lease_expires_at=null,revoked_at=clock_timestamp(),
    leave_receipt=p_receipt,last_error_code=null,updated_at=clock_timestamp() where id=b.id;
  return true;
end;
$$;

create function public.confirm_hivra_buzz_health(
  p_user_id text,p_binding_id uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.hivra_buzz_agent_bindings%rowtype; c public.hivra_buzz_connections%rowtype;
begin
  select * into b from public.hivra_buzz_agent_bindings where id=p_binding_id and user_id=p_user_id for update;
  if not found or b.status<>'joined' then return false; end if;
  select * into c from public.hivra_buzz_connections where id=b.connection_id and user_id=p_user_id;
  if p_receipt is null or jsonb_typeof(p_receipt) is distinct from 'object'
    or not (p_receipt ?& array['protocol','connectionId','connectionRevision','relayPublicKey','relayUrl','publicKey','status','rosterEventId','rosterCreatedAt','rosterMember'])
    or p_receipt-array['protocol','connectionId','connectionRevision','relayPublicKey','relayUrl','publicKey','status','rosterEventId','rosterCreatedAt','rosterMember']<>'{}'::jsonb then return false; end if;
  if jsonb_typeof(p_receipt->'protocol')<>'string' or jsonb_typeof(p_receipt->'connectionId')<>'string'
    or jsonb_typeof(p_receipt->'connectionRevision')<>'number' or jsonb_typeof(p_receipt->'relayPublicKey')<>'string'
    or jsonb_typeof(p_receipt->'relayUrl')<>'string' or jsonb_typeof(p_receipt->'publicKey')<>'string'
    or jsonb_typeof(p_receipt->'status')<>'string' or jsonb_typeof(p_receipt->'rosterEventId')<>'string'
    or jsonb_typeof(p_receipt->'rosterCreatedAt')<>'number' or jsonb_typeof(p_receipt->'rosterMember')<>'boolean' then return false; end if;
  if p_receipt->>'protocol' is distinct from 'hivra-buzz-health-v1'
    or p_receipt->>'connectionId' is distinct from b.connection_id::text
    or p_receipt->>'connectionRevision' is distinct from b.connection_revision::text
    or p_receipt->>'relayPublicKey' is distinct from b.relay_public_key
    or p_receipt->>'relayUrl' is distinct from c.relay_url
    or p_receipt->>'publicKey' is distinct from b.public_key
    or p_receipt->>'status' is distinct from 'member'
    or p_receipt->>'rosterEventId' !~ '^[a-f0-9]{64}$'
    or p_receipt->>'rosterCreatedAt' !~ '^[0-9]+$'
    or p_receipt->'rosterMember' is distinct from 'true'::jsonb
    or (p_receipt->>'rosterCreatedAt')::bigint < (b.claim_receipt->>'rosterCreatedAt')::bigint then return false; end if;
  update public.hivra_buzz_agent_bindings set last_health_at=clock_timestamp(),health_receipt=p_receipt,
    last_error_code=null,updated_at=clock_timestamp() where id=b.id;
  return true;
end;
$$;

revoke all on function public.upsert_hivra_buzz_connection(text,uuid,text,text,text,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.admit_hivra_buzz_binding(text,uuid,uuid,uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.claim_hivra_buzz_membership(text,uuid) from public,anon,authenticated;
revoke all on function public.settle_hivra_buzz_membership(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.abandon_hivra_buzz_membership(text,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.claim_hivra_buzz_leave(text,uuid) from public,anon,authenticated;
revoke all on function public.settle_hivra_buzz_leave(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.confirm_hivra_buzz_health(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.upsert_hivra_buzz_connection(text,uuid,text,text,text,text,text,text,boolean) to service_role;
grant execute on function public.admit_hivra_buzz_binding(text,uuid,uuid,uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.claim_hivra_buzz_membership(text,uuid) to service_role;
grant execute on function public.settle_hivra_buzz_membership(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.abandon_hivra_buzz_membership(text,uuid,uuid,text) to service_role;
grant execute on function public.claim_hivra_buzz_leave(text,uuid) to service_role;
grant execute on function public.settle_hivra_buzz_leave(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.confirm_hivra_buzz_health(text,uuid,jsonb) to service_role;
