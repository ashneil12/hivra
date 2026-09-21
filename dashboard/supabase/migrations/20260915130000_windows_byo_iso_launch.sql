-- Customer-owned Windows ISO setup on an exact owner-bound Proxmox target.
-- No ISO bytes, product key, activation material, or reusable credential is
-- accepted or stored by this contract.

alter table public.hivra_agents
  add column if not exists windows_iso_volume text,
  add column if not exists windows_disk_gb integer,
  add column if not exists windows_iso_size_bytes bigint,
  add column if not exists windows_iso_modified_at_seconds bigint,
  add column if not exists windows_iso_file_identity_sha256 text,
  add column if not exists windows_rights_attested_by text,
  add column if not exists windows_rights_attested_at timestamptz,
  add column if not exists windows_rights_terms_version text;

alter table public.hivra_agents
  drop constraint if exists hivra_windows_byo_iso_shape_check,
  add constraint hivra_windows_byo_iso_shape_check check (
    (windows_iso_volume is null and windows_disk_gb is null and windows_iso_size_bytes is null
      and windows_iso_modified_at_seconds is null and windows_iso_file_identity_sha256 is null and windows_rights_attested_by is null
      and windows_rights_attested_at is null and windows_rights_terms_version is null)
    or
    (computer_profile = 'windows' and deployment_mode = 'self-managed'
      and windows_iso_volume ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:iso/[A-Za-z0-9][A-Za-z0-9._+@() -]{0,190}[.][Ii][Ss][Oo]$'
      and windows_disk_gb between 64 and 2048
      and windows_iso_size_bytes > 0
      and windows_iso_modified_at_seconds >= 0
      and windows_iso_file_identity_sha256 ~ '^[a-f0-9]{64}$'
      and length(windows_rights_attested_by) between 1 and 256
      and windows_rights_attested_at is not null
      and windows_rights_terms_version = 'windows-byo-iso-v1')
  ) not valid;

-- Retained private-preview Windows fixtures predate this customer launch
-- contract and remain untouched. Validate only new/changed rows until they are
-- migrated or retired under their separate acceptance authority.

create table public.hivra_windows_byo_iso_launches (
  user_id text not null check (length(user_id) between 1 and 256 and btrim(user_id) <> ''),
  request_id uuid not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  operation_id uuid not null unique,
  agent_id uuid not null unique,
  binding_token_hash text not null check (binding_token_hash ~ '^[a-f0-9]{64}$'),
  media_evidence jsonb not null check (jsonb_typeof(media_evidence)='object'
    and media_evidence ?& array['sizeBytes','modifiedAtSeconds','fileIdentitySha256']
    and media_evidence - array['sizeBytes','modifiedAtSeconds','fileIdentitySha256'] = '{}'::jsonb
    and jsonb_typeof(media_evidence->'sizeBytes')='number'
    and media_evidence->>'sizeBytes' ~ '^[0-9]+$'
    and (media_evidence->>'sizeBytes')::numeric > 0
    and (media_evidence->>'sizeBytes')::numeric <= 9007199254740991
    and jsonb_typeof(media_evidence->'modifiedAtSeconds')='number'
    and media_evidence->>'modifiedAtSeconds' ~ '^[0-9]+$'
    and (media_evidence->>'modifiedAtSeconds')::numeric >= 0
    and (media_evidence->>'modifiedAtSeconds')::numeric <= 9007199254740991
    and jsonb_typeof(media_evidence->'fileIdentitySha256')='string'
    and media_evidence->>'fileIdentitySha256' ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, request_id)
);

alter table public.hivra_windows_byo_iso_launches enable row level security;
revoke all on table public.hivra_windows_byo_iso_launches from public, anon, authenticated, service_role;
grant select on table public.hivra_windows_byo_iso_launches to service_role;

create function public.reserve_windows_byo_iso_launch(
  p_user_id text, p_request_id uuid, p_request_digest text, p_media_evidence jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare q public.hivra_windows_byo_iso_launches%rowtype; a public.hivra_agents%rowtype;
begin
  if p_user_id is null or length(p_user_id) not between 1 and 256 or btrim(p_user_id) = ''
    or p_request_id is null or p_request_digest !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_media_evidence) is distinct from 'object'
    or not (p_media_evidence ?& array['sizeBytes','modifiedAtSeconds','fileIdentitySha256'])
    or p_media_evidence - array['sizeBytes','modifiedAtSeconds','fileIdentitySha256'] <> '{}'::jsonb
    or jsonb_typeof(p_media_evidence->'sizeBytes') is distinct from 'number'
    or p_media_evidence->>'sizeBytes' !~ '^[0-9]+$'
    or (p_media_evidence->>'sizeBytes')::numeric <= 0
    or (p_media_evidence->>'sizeBytes')::numeric > 9007199254740991
    or jsonb_typeof(p_media_evidence->'modifiedAtSeconds') is distinct from 'number'
    or p_media_evidence->>'modifiedAtSeconds' !~ '^[0-9]+$'
    or (p_media_evidence->>'modifiedAtSeconds')::numeric < 0
    or (p_media_evidence->>'modifiedAtSeconds')::numeric > 9007199254740991
    or jsonb_typeof(p_media_evidence->'fileIdentitySha256') is distinct from 'string'
    or p_media_evidence->>'fileIdentitySha256' !~ '^[a-f0-9]{64}$'
  then return jsonb_build_object('status', 'invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended('windows-byo-iso-v1:' || p_user_id || ':' || p_request_id::text, 0));
  select * into q from public.hivra_windows_byo_iso_launches
    where user_id=p_user_id and request_id=p_request_id;
  if found then
    if q.request_digest <> p_request_digest then return jsonb_build_object('status', 'conflict'); end if;
    select * into a from public.hivra_agents where id=q.agent_id and user_id=p_user_id;
    if found and q.accepted_at is null then return jsonb_build_object('status', 'pending',
      'operationId',q.operation_id,'agentId',q.agent_id,'bindingHash',q.binding_token_hash); end if;
    if found then return jsonb_build_object('status', 'existing', 'agent', jsonb_build_object(
      'id',a.id,'name',a.name,'status',a.status,'vmid',a.vmid,
      'computer_profile',a.computer_profile,'deployment_mode',a.deployment_mode)); end if;
    return jsonb_build_object('status', 'reserved', 'operationId', q.operation_id,
      'agentId', q.agent_id, 'bindingHash', q.binding_token_hash);
  end if;
  insert into public.hivra_windows_byo_iso_launches(user_id,request_id,request_digest,operation_id,agent_id,binding_token_hash,media_evidence)
    values(p_user_id,p_request_id,p_request_digest,gen_random_uuid(),gen_random_uuid(),
      replace(pg_catalog.gen_random_uuid()::text,'-','') || replace(pg_catalog.gen_random_uuid()::text,'-',''),
      p_media_evidence) returning * into q;
  return jsonb_build_object('status', 'reserved', 'operationId', q.operation_id,
    'agentId', q.agent_id, 'bindingHash', q.binding_token_hash);
end;
$$;

create function public.accept_windows_byo_iso_launch(
  p_user_id text, p_request_id uuid, p_agent_id uuid, p_operation_id uuid, p_vmid integer
) returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare q public.hivra_windows_byo_iso_launches%rowtype;
begin
  if p_vmid not between 100 and 999999999 then return false; end if;
  select * into q from public.hivra_windows_byo_iso_launches where user_id=p_user_id
    and request_id=p_request_id and agent_id=p_agent_id and operation_id=p_operation_id for update;
  if not found then return false; end if;
  update public.hivra_agents a set vmid=p_vmid,operation_id=null,operation_kind=null,
    operation_started_at=null,operation_payload=null
  where a.id=p_agent_id and a.user_id=p_user_id and a.computer_profile='windows'
    and a.deployment_mode='self-managed' and a.allocation_operation_id=p_operation_id
    and (a.vmid is null or a.vmid=p_vmid)
    and ((a.operation_id=p_operation_id and a.operation_kind='provision') or
      (a.operation_id is null and a.operation_kind is null and a.operation_started_at is null and a.operation_payload is null));
  if not found then return false; end if;
  update public.hivra_windows_byo_iso_launches set accepted_at=coalesce(accepted_at,clock_timestamp())
    where user_id=p_user_id and request_id=p_request_id;
  return true;
end;
$$;

revoke all on function public.reserve_windows_byo_iso_launch(text,uuid,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.accept_windows_byo_iso_launch(text,uuid,uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.reserve_windows_byo_iso_launch(text,uuid,text,jsonb) to service_role;
grant execute on function public.accept_windows_byo_iso_launch(text,uuid,uuid,uuid,integer) to service_role;
