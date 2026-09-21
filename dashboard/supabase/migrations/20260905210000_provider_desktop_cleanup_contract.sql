-- Private desktop cleanup observation contract for sealed .05.6 only.
-- Does not admit desktop dispatch, change shared identity/lease triggers, or
-- release an operation. Dispatch/access/readiness lifecycle integration follows
-- separately before any caller or Canary application.
create function public.hivra_provider_desktop_identity_valid(p_identity jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_identity)='object'
    and p_identity-array['version','agentId','operationId','bundle','desktopCleanup']='{}'::jsonb
    and p_identity->'version'='3'::jsonb
    and p_identity->>'agentId'=p_agent_id::text and p_identity->>'operationId'=p_operation_id::text
    and jsonb_typeof(p_identity->'bundle')='object'
    and (p_identity->'bundle')-array['version','state','scopeSha256','bundleSha256','provisionerVersion']='{}'::jsonb
    and p_identity->'bundle'->'version'='1'::jsonb and p_identity->'bundle'->>'state'='bundle_installed'
    and jsonb_typeof(p_identity->'bundle'->'scopeSha256')='string'
    and p_identity->'bundle'->>'scopeSha256' ~ '^[0-9a-f]{64}$'
    and p_identity->'bundle'->>'bundleSha256'='1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4'
    and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.6'
    and jsonb_typeof(p_identity->'desktopCleanup')='object'
    and (p_identity->'desktopCleanup')-array['profile','closureSha256']='{}'::jsonb
    and p_identity->'desktopCleanup'->>'profile'='desktop-owned-services-v1'
    and p_identity->'desktopCleanup'->>'closureSha256'='d3dd454b6f386deadb0d3f45f0eee3cb21999f5229c0a831b5dc62f82a578225'
  ) is true;
$$;

create function public.hivra_provider_desktop_stopped_receipt_valid(p_receipt jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_receipt)='object'
    and p_receipt-array['version','identity','state','stopped','desktopCleanup']='{}'::jsonb
    and p_receipt->'version'='3'::jsonb and p_receipt->'stopped'='true'::jsonb
    and p_receipt->>'state' in ('cancelled','failed','succeeded')
    and public.hivra_provider_desktop_identity_valid(p_receipt->'identity',p_agent_id,p_operation_id)
    and jsonb_typeof(p_receipt->'desktopCleanup')='object'
    and ((p_receipt->'desktopCleanup'='{"state":"pending"}'::jsonb)
      or ((p_receipt->'desktopCleanup')-array['state','bootId']='{}'::jsonb
        and p_receipt->'desktopCleanup'->>'state' in ('not_started','verified_stopped')
        and (p_receipt->'desktopCleanup'->>'state'<>'not_started' or p_receipt->>'state'='cancelled')
        and jsonb_typeof(p_receipt->'desktopCleanup'->'bootId')='string'
        and p_receipt->'desktopCleanup'->>'bootId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
  ) is true;
$$;

-- One current observation grant, not a renewable cached success. Starting a
-- new observation invalidates older proof. Only narrowly scoped RPCs may write
-- this table; normal service-role direct agent writers cannot fabricate proof.
create table public.hivra_provider_desktop_cleanup (
  agent_id uuid primary key references public.hivra_agents(id),
  user_id text not null,
  operation_id uuid not null,
  identity jsonb not null,
  observation_id uuid not null unique,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  receipt jsonb,
  observed_at timestamptz,
  check(expires_at=issued_at+interval '30 seconds'),
  check(public.hivra_provider_desktop_identity_valid(identity,agent_id,operation_id)),
  check(((receipt is null and observed_at is null)
    or (public.hivra_provider_desktop_stopped_receipt_valid(receipt,agent_id,operation_id)
      and receipt->'identity'=identity and receipt->'desktopCleanup'->>'state' in ('not_started','verified_stopped')
      and observed_at>=issued_at and observed_at<expires_at)) is true)
);
alter table public.hivra_provider_desktop_cleanup enable row level security;
revoke all on public.hivra_provider_desktop_cleanup from public,anon,authenticated,service_role;
grant select on public.hivra_provider_desktop_cleanup to service_role;

create function public.begin_hivra_provider_desktop_cleanup(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_desktop_cleanup%rowtype;
  observed timestamptz; token uuid;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and computer_substrate='provider-vm' and type='linux-desktop' and computer_profile='ubuntu-desktop'
    and operation_id=p_operation_id and allocation_operation_id=p_operation_id
    and operation_kind='provision' and status='provisioning' for update;
  if not found or not public.hivra_provider_desktop_identity_valid(p_identity,p_agent_id,p_operation_id)
    or a.provider_install_identity is distinct from p_identity then return null; end if;
  -- All callers lock agent then observation journal. Acquiring a new observation
  -- never changes the installer identity, outcome, deadline or parent operation.
  select * into j from public.hivra_provider_desktop_cleanup where agent_id=a.id for update;
  if found and row(j.user_id,j.operation_id,j.identity) is distinct from row(a.user_id,a.operation_id,p_identity) then return null; end if;
  observed := clock_timestamp(); token := pg_catalog.gen_random_uuid();
  insert into public.hivra_provider_desktop_cleanup(agent_id,user_id,operation_id,identity,observation_id,issued_at,expires_at)
    values(a.id,a.user_id,a.operation_id,p_identity,token,observed,observed+interval '30 seconds')
    on conflict(agent_id) do update set observation_id=excluded.observation_id,
      issued_at=excluded.issued_at,expires_at=excluded.expires_at,receipt=null,observed_at=null;
  return jsonb_build_object('observationId',token,'budgetMs',30000);
end;
$$;

create function public.record_hivra_provider_desktop_cleanup(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_observation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_desktop_cleanup%rowtype; observed timestamptz;
begin
  if not public.hivra_provider_desktop_stopped_receipt_valid(p_receipt,p_agent_id,p_operation_id)
    or p_receipt->'desktopCleanup'->>'state' not in ('not_started','verified_stopped') then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and computer_substrate='provider-vm' and type='linux-desktop' and computer_profile='ubuntu-desktop'
    and operation_id=p_operation_id and allocation_operation_id=p_operation_id
    and operation_kind='provision' and status='provisioning' for update;
  if not found or a.provider_install_identity is distinct from p_receipt->'identity'
    or a.provider_install_stopped_at is null or a.provider_install_outcome is distinct from p_receipt->>'state' then return false; end if;
  select * into j from public.hivra_provider_desktop_cleanup where agent_id=a.id and user_id=a.user_id
    and operation_id=a.operation_id and observation_id=p_observation_id for update;
  observed := clock_timestamp();
  if not found or j.identity is distinct from a.provider_install_identity
    or observed<j.issued_at or observed>=j.expires_at then return false; end if;
  if j.receipt is not null then return j.receipt=p_receipt; end if;
  -- The server parser verifies this receipt against the guest clock sampled on
  -- the same pinned SSH invocation. This RPC cannot infer a guest boot itself.
  -- Retransmission never refreshes the grant or its first recorded timestamp.
  update public.hivra_provider_desktop_cleanup set receipt=p_receipt,observed_at=observed where agent_id=a.id;
  return true;
end;
$$;

create function public.hivra_provider_desktop_cleanup_verified(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb,p_outcome text)
returns boolean language sql volatile security invoker set search_path=public,pg_temp as $$
  select exists(select 1 from public.hivra_provider_desktop_cleanup j
    where j.agent_id=p_agent_id and j.user_id=p_user_id and j.operation_id=p_operation_id and j.identity=p_identity
      and j.receipt->'identity'=p_identity and j.receipt->>'state'=p_outcome
      and j.observed_at>=j.issued_at and j.observed_at<=clock_timestamp() and clock_timestamp()<j.expires_at
      and public.hivra_provider_desktop_stopped_receipt_valid(j.receipt,p_agent_id,p_operation_id)
      and j.receipt->'desktopCleanup'->>'state' in ('not_started','verified_stopped'));
$$;


revoke all on function public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.hivra_provider_desktop_identity_valid(jsonb,uuid,uuid) to service_role;

revoke all on function public.hivra_provider_desktop_stopped_receipt_valid(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.hivra_provider_desktop_stopped_receipt_valid(jsonb,uuid,uuid) to service_role;

revoke all on function public.begin_hivra_provider_desktop_cleanup(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.begin_hivra_provider_desktop_cleanup(text,uuid,uuid,jsonb) to service_role;

revoke all on function public.record_hivra_provider_desktop_cleanup(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_hivra_provider_desktop_cleanup(text,uuid,uuid,uuid,jsonb) to service_role;

revoke all on function public.hivra_provider_desktop_cleanup_verified(text,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.hivra_provider_desktop_cleanup_verified(text,uuid,uuid,jsonb,text) to service_role;
