-- Owner-bound idempotency receipts for native Codex and Ubuntu launches.
-- This journal fences only admission/replay. Existing provision, provider,
-- lifecycle, access, and cleanup operations retain their authority.
create table public.hivra_launch_operations (
  user_id text not null check (length(user_id) between 1 and 256 and btrim(user_id) <> ''),
  request_id uuid not null,
  operation_id uuid not null unique,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  intent_digest text not null check (intent_digest ~ '^[a-f0-9]{64}$'),
  resource_kind text not null check (resource_kind in ('agent', 'computer')),
  runtime_id text not null check (runtime_id in ('codex', 'linux-desktop')),
  phase text not null default 'reserved'
    check (phase in ('reserved', 'reconciling', 'bound', 'accepted', 'failed')),
  -- Deliberately not a foreign key: mature hard-delete/cleanup authority must
  -- not be blocked by the receipt journal. The bind RPC proves the owner row.
  agent_id uuid,
  response_status integer check (response_status in (201, 202)),
  failure_status integer check (failure_status between 400 and 599),
  failure_code text check (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz not null default clock_timestamp(),
  bound_at timestamptz,
  accepted_at timestamptz,
  failed_at timestamptz,
  primary key (user_id, request_id),
  constraint hivra_launch_operation_kind_check check (
    (resource_kind = 'agent' and runtime_id = 'codex')
    or (resource_kind = 'computer' and runtime_id = 'linux-desktop')
  ),
  constraint hivra_launch_operation_phase_check check (
    (phase in ('reserved', 'reconciling') and agent_id is null and response_status is null
      and failure_status is null and failure_code is null and bound_at is null
      and accepted_at is null and failed_at is null)
    or (phase = 'bound' and agent_id is not null and response_status is null
      and failure_status is null and failure_code is null and bound_at is not null
      and accepted_at is null and failed_at is null)
    or (phase = 'accepted' and agent_id is not null and response_status is not null
      and failure_status is null and failure_code is null and bound_at is not null
      and accepted_at is not null and failed_at is null)
    or (phase = 'failed' and agent_id is null and response_status is null
      and failure_status is not null and failure_code is not null and bound_at is null
      and accepted_at is null and failed_at is not null)
  )
);

alter table public.hivra_launch_operations enable row level security;
revoke all on table public.hivra_launch_operations from public, anon, authenticated, service_role;
grant select on table public.hivra_launch_operations to service_role;

-- Serialize same-owner duplicate requests before either caller can insert an
-- agent row or invoke an external provider. The submitted digest—not mutable
-- catalog/template/config output—decides whether reuse conflicts.
create function public.reserve_hivra_launch_operation(
  p_user_id text,
  p_request_id uuid,
  p_operation_id uuid,
  p_request_digest text,
  p_intent_digest text,
  p_resource_kind text,
  p_runtime_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.hivra_launch_operations%rowtype;
begin
  if p_user_id is null or length(p_user_id) not between 1 and 256 or btrim(p_user_id) = ''
    or p_request_id is null or p_operation_id is null
    or p_request_digest is null or p_request_digest !~ '^[a-f0-9]{64}$'
    or p_intent_digest is null or p_intent_digest !~ '^[a-f0-9]{64}$'
    or p_resource_kind is null or p_runtime_id is null
    or (p_resource_kind, p_runtime_id) not in (('agent', 'codex'), ('computer', 'linux-desktop'))
  then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'hivra-launch-operation-v2:' || p_user_id || ':' || p_request_id::text,
    0
  ));

  select * into q
  from public.hivra_launch_operations
  where user_id = p_user_id and request_id = p_request_id;

  if found then
    if q.request_digest <> p_request_digest then
      return jsonb_build_object('status', 'request_conflict');
    end if;
    return jsonb_build_object('status', 'existing', 'operation', to_jsonb(q));
  end if;

  insert into public.hivra_launch_operations(
    user_id, request_id, operation_id, request_digest, intent_digest, resource_kind, runtime_id
  ) values (
    p_user_id, p_request_id, p_operation_id, p_request_digest, p_intent_digest,
    p_resource_kind, p_runtime_id
  ) returning * into q;

  return jsonb_build_object('status', 'reserved', 'operation', to_jsonb(q));
end;
$$;

-- Bind only an existing owner/type/profile row. Managed Proxmox rows must carry
-- the journal operation ID, which closes the insert/bind lost-ack gap. The
-- provider adapter has its own mature operation identity and may bind only a
-- returned provider-vm row; an uncertain provider outcome never reaches here.
create function public.bind_hivra_launch_operation_agent(
  p_user_id text,
  p_request_id uuid,
  p_operation_id uuid,
  p_request_digest text,
  p_intent_digest text,
  p_agent_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.hivra_launch_operations%rowtype;
  a public.hivra_agents%rowtype;
begin
  select * into q
  from public.hivra_launch_operations
  where user_id = p_user_id and request_id = p_request_id
  for update;

  if not found or q.operation_id is distinct from p_operation_id
    or q.request_digest is distinct from p_request_digest
    or q.intent_digest is distinct from p_intent_digest
  then
    return null;
  end if;
  if q.phase in ('bound', 'accepted') then
    return case when q.agent_id = p_agent_id then to_jsonb(q) else null end;
  end if;
  if q.phase not in ('reserved', 'reconciling') then return null; end if;

  select * into a
  from public.hivra_agents
  where id = p_agent_id and user_id = p_user_id
  for key share;
  if not found or a.type <> q.runtime_id
    or (q.runtime_id = 'codex' and (q.resource_kind <> 'agent' or a.computer_profile is not null))
    or (q.runtime_id = 'linux-desktop'
      and (q.resource_kind <> 'computer' or a.computer_profile is distinct from 'ubuntu-desktop'))
    or (a.computer_substrate is distinct from 'provider-vm'
      and a.operation_id is distinct from q.operation_id)
  then
    return null;
  end if;

  update public.hivra_launch_operations
  set phase = 'bound', agent_id = p_agent_id, bound_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id
  returning * into q;
  return to_jsonb(q);
end;
$$;

-- Record durable resource acceptance as soon as the owner-bound row exists.
-- A later completed kickoff upgrades 202 to 201; 201 is monotonic and can
-- never be downgraded by an older retry.
create function public.accept_hivra_launch_operation(
  p_user_id text,
  p_request_id uuid,
  p_operation_id uuid,
  p_request_digest text,
  p_intent_digest text,
  p_agent_id uuid,
  p_response_status integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.hivra_launch_operations%rowtype;
begin
  if p_response_status is null or p_response_status not in (201, 202) then return null; end if;
  select * into q
  from public.hivra_launch_operations
  where user_id = p_user_id and request_id = p_request_id
  for update;

  if not found or q.operation_id is distinct from p_operation_id
    or q.request_digest is distinct from p_request_digest
    or q.intent_digest is distinct from p_intent_digest
    or q.agent_id is distinct from p_agent_id
  then
    return null;
  end if;
  if q.phase = 'accepted' then
    if q.response_status = 201 or q.response_status = p_response_status then return to_jsonb(q); end if;
    if q.response_status = 202 and p_response_status = 201 then
      update public.hivra_launch_operations set response_status = 201
      where user_id = p_user_id and request_id = p_request_id returning * into q;
      return to_jsonb(q);
    end if;
    return null;
  end if;
  if q.phase <> 'bound' then return null; end if;

  update public.hivra_launch_operations
  set phase = 'accepted', response_status = p_response_status, accepted_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id
  returning * into q;
  return to_jsonb(q);
end;
$$;

-- Unknown provider or database acknowledgements remain explicitly
-- reconciling. This state is intentionally not permission to redrive.
create function public.reconcile_hivra_launch_operation(
  p_user_id text,
  p_request_id uuid,
  p_operation_id uuid,
  p_request_digest text,
  p_intent_digest text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.hivra_launch_operations%rowtype;
begin
  select * into q from public.hivra_launch_operations
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found or q.operation_id is distinct from p_operation_id
    or q.request_digest is distinct from p_request_digest
    or q.intent_digest is distinct from p_intent_digest
    or q.phase = 'failed'
  then return null; end if;
  if q.phase = 'reserved' then
    update public.hivra_launch_operations set phase = 'reconciling'
    where user_id = p_user_id and request_id = p_request_id returning * into q;
  end if;
  return to_jsonb(q);
end;
$$;

-- Only a confirmed failure before an owner row exists may terminate a receipt.
create function public.fail_hivra_launch_operation(
  p_user_id text,
  p_request_id uuid,
  p_operation_id uuid,
  p_request_digest text,
  p_intent_digest text,
  p_failure_status integer,
  p_failure_code text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  q public.hivra_launch_operations%rowtype;
begin
  if p_failure_status is null or p_failure_status not between 400 and 599
    or p_failure_code is null or p_failure_code !~ '^[a-z][a-z0-9_]{0,63}$'
  then return null; end if;
  select * into q from public.hivra_launch_operations
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found or q.operation_id is distinct from p_operation_id
    or q.request_digest is distinct from p_request_digest
    or q.intent_digest is distinct from p_intent_digest
  then return null; end if;
  if q.phase = 'failed' then
    return case when q.failure_status = p_failure_status and q.failure_code = p_failure_code
      then to_jsonb(q) else null end;
  end if;
  if q.phase not in ('reserved', 'reconciling') or q.agent_id is not null then return null; end if;
  update public.hivra_launch_operations
  set phase = 'failed', failure_status = p_failure_status,
    failure_code = p_failure_code, failed_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id returning * into q;
  return to_jsonb(q);
end;
$$;

revoke all on function public.reserve_hivra_launch_operation(text, uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.bind_hivra_launch_operation_agent(text, uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.accept_hivra_launch_operation(text, uuid, uuid, text, text, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.reconcile_hivra_launch_operation(text, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_hivra_launch_operation(text, uuid, uuid, text, text, integer, text)
  from public, anon, authenticated, service_role;

grant execute on function public.reserve_hivra_launch_operation(text, uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.bind_hivra_launch_operation_agent(text, uuid, uuid, text, text, uuid)
  to service_role;
grant execute on function public.accept_hivra_launch_operation(text, uuid, uuid, text, text, uuid, integer)
  to service_role;
grant execute on function public.reconcile_hivra_launch_operation(text, uuid, uuid, text, text)
  to service_role;
grant execute on function public.fail_hivra_launch_operation(text, uuid, uuid, text, text, integer, text)
  to service_role;
