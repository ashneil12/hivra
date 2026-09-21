-- Evidence only: recording staged bytes must not activate a binding or release
-- the shared lifecycle lease. Application roles cannot submit results yet.
create table public.hivra_agent_attachment_staging_results (
  operation_id uuid primary key references public.hivra_agent_attachment_dispatches(operation_id)
    references public.hivra_agent_attachment_guest_observations(operation_id),
  result jsonb not null check (jsonb_typeof(result)='object'),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.hivra_agent_attachment_staging_results enable row level security;
revoke all on public.hivra_agent_attachment_staging_results from public,anon,authenticated,service_role;
grant select on public.hivra_agent_attachment_staging_results to service_role;

create function public.record_hivra_attachment_staging_result(
  p_owner text,p_operation_id uuid,p_expected_generation bigint,
  p_expected_authority jsonb,p_observed_boot_id uuid,p_result jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  p public.hivra_agent_attachments%rowtype;
  r public.hivra_agent_attachment_installations%rowtype;
  o public.hivra_agent_attachment_guest_observations%rowtype;
  saved jsonb; receipt jsonb; expected_receipt jsonb;
  archive_digest text; binary_digest text; k text;
begin
  if p_owner is null or p_operation_id is null or p_expected_generation is null
    or p_expected_authority is null or p_observed_boot_id is null
    or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>16384
  then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner;
  if not found or p.authority_generation is distinct from p_expected_generation
    or p.guest_authority is distinct from p_expected_authority then return false; end if;
  perform 1 from public.hivra_agents where id=p.source_id and user_id=p_owner for update;
  if not found then return false; end if;
  select * into p from public.hivra_agent_attachments where id=p_operation_id and user_id=p_owner for update;
  if p.phase is distinct from 'dispatched'
    or not exists(select 1 from public.hivra_agents where id=p.source_id and user_id=p_owner
      and operation_id=p.id and operation_kind='agent_attach' and status='running' and desired_state in ('running','deleted')
      and public.hivra_desktop_prepare_authority(hivra_agents)=p.guest_authority)
  then return false; end if;
  perform 1 from public.hivra_canonical_relationship_authority where computer_id=p.computer_id and user_id=p_owner
    and write_authority='canonical' and generation=p_expected_generation and command_id=p.authority_command_id for update;
  if not found then return false; end if;
  select * into r from public.hivra_agent_attachment_installations where operation_id=p.id;
  if not found then return false; end if;
  select * into o from public.hivra_agent_attachment_guest_observations where operation_id=p.id;
  if not found or o.boot_id is distinct from p_observed_boot_id then return false; end if;
  if p_result-'receipt' is distinct from jsonb_build_object(
      'version',1,'phase','staged','bootId',o.boot_id::text,'identity',jsonb_build_object(
        'operationId',p.id::text,'dispatchId',p.dispatch_id::text,'installationId',r.installation_id::text,
        'bindingId',r.binding_id::text,'computerId',p.computer_id::text,'sourceId',p.source_id::text,'architecture',r.architecture))
  then return false; end if;
  if r.architecture='x86_64' then
    archive_digest:='e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278';
    binary_digest:='73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba';
  elsif r.architecture='aarch64' then
    archive_digest:='14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0';
    binary_digest:='2447e3fef519401ff6d6e90759ab1bf66082da48966fc6e4fe9a77108f9c20d8';
  else return false; end if;
  receipt:=p_result->'receipt';
  expected_receipt:=jsonb_build_object('version',1,'state','staged','operationId',p.id::text,
    'installationId',r.installation_id::text,'runtimeId','codex','runtimeVersion','0.149.1','architecture',r.architecture,
    'archiveSha256',archive_digest,'binarySha256',binary_digest,
    'account','hva_'||left(replace(r.installation_id::text,'-',''),24),
    'home','/var/lib/hivra/agent-homes/'||r.installation_id::text,
    'executable','/opt/hivra/agent-installations/'||r.installation_id::text||'/codex');
  if jsonb_typeof(receipt) is distinct from 'object' then return false; end if;
  if receipt-'uid'-'gid' is distinct from expected_receipt then return false; end if;
  foreach k in array array['uid','gid'] loop
    if jsonb_typeof(receipt->k) is distinct from 'number'
      or coalesce(receipt->>k,'') !~ '^[1-9][0-9]{0,9}$' then return false; end if;
    if (receipt->>k)::bigint>4294967294 then return false; end if;
  end loop;
  select result into saved from public.hivra_agent_attachment_staging_results where operation_id=p.id;
  if found then return saved=p_result; end if;
  insert into public.hivra_agent_attachment_staging_results(operation_id,result) values(p.id,p_result);
  return true;
end;
$$;
revoke all on function public.record_hivra_attachment_staging_result(text,uuid,bigint,jsonb,uuid,jsonb)
  from public,anon,authenticated,service_role;
