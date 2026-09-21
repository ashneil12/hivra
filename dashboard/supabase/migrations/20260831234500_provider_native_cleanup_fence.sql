-- Private DeepSeek v2 operation fencing. No catalog/route admission, provider
-- mutation or whole-VM fallback. v1 retains its historical installer semantics.
create function public.hivra_provider_native_identity_valid(p_identity jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_identity)='object'
    and p_identity-array['version','agentId','operationId','bundle','nativeCleanup']='{}'::jsonb
    and p_identity->'version'='2'::jsonb
    and p_identity->>'agentId'=p_agent_id::text and p_identity->>'operationId'=p_operation_id::text
    and jsonb_typeof(p_identity->'bundle')='object'
    and (p_identity->'bundle')-array['version','state','scopeSha256','bundleSha256','provisionerVersion']='{}'::jsonb
    and p_identity->'bundle'->'version'='1'::jsonb and p_identity->'bundle'->>'state'='bundle_installed'
    and jsonb_typeof(p_identity->'bundle'->'scopeSha256')='string'
    and p_identity->'bundle'->>'scopeSha256' ~ '^[0-9a-f]{64}$'
    and p_identity->'bundle'->>'bundleSha256'='8f74ff4ce921d21c84784fdff6885f2ff60b1e83b9c1f3609a95422982bc16ec'
    and p_identity->'bundle'->>'provisionerVersion'='2026.08.31.3'
    and jsonb_typeof(p_identity->'nativeCleanup')='object'
    and (p_identity->'nativeCleanup')-array['profile','closureSha256']='{}'::jsonb
    and p_identity->'nativeCleanup'->>'profile'='deepseek-owned-service-v1'
    and p_identity->'nativeCleanup'->>'closureSha256'='ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91'
  ) is true;
$$;

create or replace function public.hivra_provider_install_identity_valid(p_identity jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select ((jsonb_typeof(p_identity)='object'
    and p_identity-array['version','agentId','operationId','bundle']='{}'::jsonb
    and p_identity->'version'='1'::jsonb
    and p_identity->>'agentId'=p_agent_id::text
    and p_identity->>'operationId'=p_operation_id::text
    and jsonb_typeof(p_identity->'bundle')='object'
    and (p_identity->'bundle')-array['version','state','scopeSha256','bundleSha256','provisionerVersion']='{}'::jsonb
    and p_identity->'bundle'->'version'='1'::jsonb
    and p_identity->'bundle'->>'state'='bundle_installed'
    and jsonb_typeof(p_identity->'bundle'->'scopeSha256')='string'
    and p_identity->'bundle'->>'scopeSha256' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(p_identity->'bundle'->'bundleSha256')='string'
    and p_identity->'bundle'->>'bundleSha256' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(p_identity->'bundle'->'provisionerVersion')='string'
    and p_identity->'bundle'->>'provisionerVersion' ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]{0,3}$'
  ) is true) or public.hivra_provider_native_identity_valid(p_identity,p_agent_id,p_operation_id);
$$;

create function public.hivra_provider_native_stopped_receipt_valid(p_receipt jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_receipt)='object'
    and p_receipt-array['version','identity','state','stopped','nativeCleanup']='{}'::jsonb
    and p_receipt->'version'='2'::jsonb and p_receipt->'stopped'='true'::jsonb
    and p_receipt->>'state' in ('cancelled','failed','succeeded')
    and public.hivra_provider_native_identity_valid(p_receipt->'identity',p_agent_id,p_operation_id)
    and jsonb_typeof(p_receipt->'nativeCleanup')='object'
    and ((p_receipt->'nativeCleanup'='{"state":"pending"}'::jsonb)
      or ((p_receipt->'nativeCleanup')-array['state','bootId']='{}'::jsonb
        and p_receipt->'nativeCleanup'->>'state' in ('not_started','verified_stopped')
        and (p_receipt->'nativeCleanup'->>'state'<>'not_started' or p_receipt->>'state'='cancelled')
        and jsonb_typeof(p_receipt->'nativeCleanup'->'bootId')='string'
        and p_receipt->'nativeCleanup'->>'bootId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
  ) is true;
$$;

-- One current observation grant, not a renewable cached success. Starting a
-- new observation invalidates older proof. Only narrowly scoped RPCs may write
-- this table; normal service-role direct agent writers cannot fabricate proof.
create table public.hivra_provider_native_cleanup (
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
  check(public.hivra_provider_native_identity_valid(identity,agent_id,operation_id)),
  check(((receipt is null and observed_at is null)
    or (public.hivra_provider_native_stopped_receipt_valid(receipt,agent_id,operation_id)
      and receipt->'identity'=identity and receipt->'nativeCleanup'->>'state' in ('not_started','verified_stopped')
      and observed_at>=issued_at and observed_at<expires_at)) is true)
);
alter table public.hivra_provider_native_cleanup enable row level security;
revoke all on public.hivra_provider_native_cleanup from public,anon,authenticated,service_role;
grant select on public.hivra_provider_native_cleanup to service_role;

create function public.begin_hivra_provider_native_cleanup(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_native_cleanup%rowtype;
  observed timestamptz; token uuid;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and computer_substrate='provider-vm' and type='deepseek-harness'
    and operation_id=p_operation_id and allocation_operation_id=p_operation_id
    and operation_kind='provision' and status='provisioning' for update;
  if not found or not public.hivra_provider_native_identity_valid(p_identity,p_agent_id,p_operation_id)
    or a.provider_install_identity is distinct from p_identity then return null; end if;
  -- All callers lock agent then observation journal. Acquiring a new observation
  -- never changes the installer identity, outcome, deadline or parent operation.
  select * into j from public.hivra_provider_native_cleanup where agent_id=a.id for update;
  if found and row(j.user_id,j.operation_id,j.identity) is distinct from row(a.user_id,a.operation_id,p_identity) then return null; end if;
  observed := clock_timestamp(); token := pg_catalog.gen_random_uuid();
  insert into public.hivra_provider_native_cleanup(agent_id,user_id,operation_id,identity,observation_id,issued_at,expires_at)
    values(a.id,a.user_id,a.operation_id,p_identity,token,observed,observed+interval '30 seconds')
    on conflict(agent_id) do update set observation_id=excluded.observation_id,
      issued_at=excluded.issued_at,expires_at=excluded.expires_at,receipt=null,observed_at=null;
  return jsonb_build_object('observationId',token,'budgetMs',30000);
end;
$$;

create function public.record_hivra_provider_native_cleanup(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_observation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_native_cleanup%rowtype; observed timestamptz;
begin
  if not public.hivra_provider_native_stopped_receipt_valid(p_receipt,p_agent_id,p_operation_id)
    or p_receipt->'nativeCleanup'->>'state' not in ('not_started','verified_stopped') then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and computer_substrate='provider-vm' and type='deepseek-harness'
    and operation_id=p_operation_id and allocation_operation_id=p_operation_id
    and operation_kind='provision' and status='provisioning' for update;
  if not found or a.provider_install_identity is distinct from p_receipt->'identity'
    or a.provider_install_stopped_at is null or a.provider_install_outcome is distinct from p_receipt->>'state' then return false; end if;
  select * into j from public.hivra_provider_native_cleanup where agent_id=a.id and user_id=a.user_id
    and operation_id=a.operation_id and observation_id=p_observation_id for update;
  observed := clock_timestamp();
  if not found or j.identity is distinct from a.provider_install_identity
    or observed<j.issued_at or observed>=j.expires_at then return false; end if;
  if j.receipt is not null then return j.receipt=p_receipt; end if;
  -- The server parser verifies this receipt against the guest clock sampled on
  -- the same pinned SSH invocation. This RPC cannot infer a guest boot itself.
  -- Retransmission never refreshes the grant or its first recorded timestamp.
  update public.hivra_provider_native_cleanup set receipt=p_receipt,observed_at=observed where agent_id=a.id;
  return true;
end;
$$;

create function public.hivra_provider_native_cleanup_verified(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb,p_outcome text)
returns boolean language sql volatile security invoker set search_path=public,pg_temp as $$
  select exists(select 1 from public.hivra_provider_native_cleanup j
    where j.agent_id=p_agent_id and j.user_id=p_user_id and j.operation_id=p_operation_id and j.identity=p_identity
      and j.receipt->'identity'=p_identity and j.receipt->>'state'=p_outcome
      and j.observed_at>=j.issued_at and j.observed_at<=clock_timestamp() and clock_timestamp()<j.expires_at
      and public.hivra_provider_native_stopped_receipt_valid(j.receipt,p_agent_id,p_operation_id)
      and j.receipt->'nativeCleanup'->>'state' in ('not_started','verified_stopped'));
$$;

create function public.guard_hivra_provider_native_lifecycle()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.provider_install_identity is not null and
    ((new.provider_install_identity->'version'='2'::jsonb) is distinct from (new.type='deepseek-harness')) then
    raise exception 'Native runtime requires its original cleanup obligation' using errcode='55006'; end if;
  if tg_op='INSERT' then return new; end if;
  if (old.type='deepseek-harness' or new.type='deepseek-harness')
    and (old.provider_install_identity is not null or new.provider_install_identity is not null)
    and new.type is distinct from old.type then
    raise exception 'Do not change native runtime while dispatching or observing' using errcode='55006'; end if;
  if old.provider_install_identity->'version' is distinct from '2'::jsonb then return new; end if;
  if new.type is distinct from old.type then
    raise exception 'Retain native runtime identity' using errcode='55006'; end if;
  if old.status is distinct from 'running' and new.status='running'
    and coalesce(old.operation_kind,'') not in ('start','restart')
    and exists(select 1 from public.hivra_provider_native_cleanup
      where agent_id=old.id and operation_id=old.allocation_operation_id) then
    raise exception 'Cancelled native installation cannot reuse cached success' using errcode='55006'; end if;
  if old.operation_kind='provision' and old.operation_id=old.allocation_operation_id
    and row(new.operation_id,new.operation_kind,new.status) is distinct from row(old.operation_id,old.operation_kind,old.status) then
    -- All recovery RPCs load the held original op in provisioning. Do not
    -- strand it in error/stopped with a short-lived proof that cannot renew.
    -- Release+optional error is atomic; metadata-only errors remain allowed.
    if new.operation_id is not null or new.operation_kind is not null
      or new.operation_started_at is not null or new.operation_payload is not null then
      raise exception 'Retain native provisioning state until atomic handoff' using errcode='55006'; end if;
    -- A combined stopped+release update cannot bypass committed evidence.
    if old.provider_install_stopped_at is null then
      raise exception 'Verify native installer termination before handoff' using errcode='55006'; end if;
    if new.status='running' and old.desired_state='running' and new.desired_state='running'
      and new.operation_id is null and new.operation_kind is null and old.provider_install_outcome='succeeded'
      and not exists(select 1 from public.hivra_provider_native_cleanup
        where agent_id=old.id and operation_id=old.operation_id) then
      return new; -- Readiness intentionally retains the owned native service.
    end if;
    -- A grant durably latches cancellation intent even if its response was
    -- lost or it expired. Do not race readiness against a stopping native app.
    if new.status='running' then
      raise exception 'Native cancellation prevents successful readiness' using errcode='55006'; end if;
    if not public.hivra_provider_native_cleanup_verified(old.user_id,old.id,old.operation_id,
      old.provider_install_identity,old.provider_install_outcome) then
      raise exception 'Verify fresh native cleanup before releasing the provision operation' using errcode='55006'; end if;
  end if;
  return new;
end;
$$;
create trigger hivra_agents_provider_native_lifecycle_guard before insert or update on public.hivra_agents
  for each row execute function public.guard_hivra_provider_native_lifecycle();

create or replace function public.record_hivra_provider_install_stopped(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  if not (((jsonb_typeof(p_receipt)='object'
    and p_receipt-array['version','identity','state','stopped']='{}'::jsonb
    and p_receipt->'version'='1'::jsonb and p_receipt->'identity'->'version'='1'::jsonb
    and p_receipt->'stopped'='true'::jsonb and p_receipt->>'state' in ('cancelled','failed','succeeded')
    and public.hivra_provider_install_identity_valid(p_receipt->'identity',p_agent_id,p_operation_id)) is true)
    or public.hivra_provider_native_stopped_receipt_valid(p_receipt,p_agent_id,p_operation_id)) then return false; end if;
  select * into a from public.hivra_agents where user_id=p_user_id and id=p_agent_id
    and computer_substrate='provider-vm' and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and status='provisioning' for update;
  if not found or a.provider_install_identity is distinct from p_receipt->'identity' then return false; end if;
  if a.provider_install_stopped_at is not null then return a.provider_install_outcome=p_receipt->>'state'; end if;
  update public.hivra_agents set provider_install_stopped_at=clock_timestamp(),provider_install_outcome=p_receipt->>'state' where id=a.id;
  return true; -- Installer outcome only, never native cleanup or operation release.
end;
$$;

revoke all on function public.hivra_provider_native_identity_valid(jsonb,uuid,uuid) from public,anon,authenticated;
revoke all on function public.hivra_provider_native_stopped_receipt_valid(jsonb,uuid,uuid) from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_native_cleanup(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.record_hivra_provider_native_cleanup(text,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.hivra_provider_native_cleanup_verified(text,uuid,uuid,jsonb,text) from public,anon,authenticated;
revoke all on function public.guard_hivra_provider_native_lifecycle() from public,anon,authenticated;
grant execute on function public.hivra_provider_native_identity_valid(jsonb,uuid,uuid) to service_role;
grant execute on function public.hivra_provider_native_stopped_receipt_valid(jsonb,uuid,uuid) to service_role;
grant execute on function public.begin_hivra_provider_native_cleanup(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.record_hivra_provider_native_cleanup(text,uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.hivra_provider_native_cleanup_verified(text,uuid,uuid,jsonb,text) to service_role;
