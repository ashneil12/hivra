-- Concurrency-safe writes for the deliberately partial legacy encryption
-- rewrapper. This does not cover every master-key dependency and is not an
-- old-key-retirement gate. Expected bodies exclude row IDs and are compared
-- atomically with the update so a concurrent user/runtime write wins.
create or replace function public.rewrap_legacy_encryption_row(
  p_surface text,
  p_id uuid,
  p_expected jsonb,
  p_patch jsonb
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
set lock_timeout = '2s'
as $$
declare
  v_updated boolean := false;
begin
  if p_id is null
    or jsonb_typeof(p_expected) is distinct from 'object'
    or jsonb_typeof(p_patch) is distinct from 'object'
    or p_patch = '{}'::jsonb
    or octet_length(p_expected::text) > 16777216
    or octet_length(p_patch::text) > 16777216
  then
    return false;
  end if;

  if p_surface = 'user_api_keys' then
    if not (p_expected ?& array['encrypted_key'])
      or p_expected - array['encrypted_key'] <> '{}'::jsonb
      or not (p_patch ?& array['encrypted_key'])
      or p_patch - array['encrypted_key'] <> '{}'::jsonb
      or jsonb_typeof(p_patch->'encrypted_key') not in ('string','null')
    then return false; end if;
    update public.user_api_keys k set encrypted_key = p_patch->>'encrypted_key'
      where k.id = p_id
        and jsonb_build_object('encrypted_key', k.encrypted_key) = p_expected;

  elsif p_surface = 'hermes_instances' then
    if not (p_expected ?& array['api_key_encrypted','api_server_key_encrypted','honcho_api_key_encrypted','config'])
      or p_expected - array['api_key_encrypted','api_server_key_encrypted','honcho_api_key_encrypted','config'] <> '{}'::jsonb
      or p_patch - array['api_key_encrypted','api_server_key_encrypted','honcho_api_key_encrypted','config'] <> '{}'::jsonb
      or exists (select 1 from jsonb_each(p_patch) e
        where e.key <> 'config' and jsonb_typeof(e.value) not in ('string','null'))
      or (p_patch ? 'config' and jsonb_typeof(p_patch->'config') not in ('object','null'))
    then return false; end if;
    update public.hermes_instances i set
      api_key_encrypted = case when p_patch ? 'api_key_encrypted' then p_patch->>'api_key_encrypted' else i.api_key_encrypted end,
      api_server_key_encrypted = case when p_patch ? 'api_server_key_encrypted' then p_patch->>'api_server_key_encrypted' else i.api_server_key_encrypted end,
      honcho_api_key_encrypted = case when p_patch ? 'honcho_api_key_encrypted' then p_patch->>'honcho_api_key_encrypted' else i.honcho_api_key_encrypted end,
      config = case when p_patch ? 'config' then nullif(p_patch->'config','null'::jsonb) else i.config end
      where i.id = p_id and jsonb_build_object(
        'api_key_encrypted', i.api_key_encrypted,
        'api_server_key_encrypted', i.api_server_key_encrypted,
        'honcho_api_key_encrypted', i.honcho_api_key_encrypted,
        'config', i.config) = p_expected;

  elsif p_surface = 'hermes_conversations' then
    if not (p_expected ?& array['title']) or p_expected - array['title'] <> '{}'::jsonb
      or not (p_patch ?& array['title']) or p_patch - array['title'] <> '{}'::jsonb
      or jsonb_typeof(p_patch->'title') not in ('string','null')
    then return false; end if;
    update public.hermes_conversations c set title = p_patch->>'title'
      where c.id = p_id and jsonb_build_object('title', c.title) = p_expected;

  elsif p_surface = 'hermes_messages' then
    if not (p_expected ?& array['content','tool_calls','attachments','artifacts','metadata'])
      or p_expected - array['content','tool_calls','attachments','artifacts','metadata'] <> '{}'::jsonb
      or p_patch - array['content','tool_calls','attachments','artifacts','metadata'] <> '{}'::jsonb
      or (p_patch ? 'content' and jsonb_typeof(p_patch->'content') not in ('string','null'))
    then return false; end if;
    update public.hermes_messages m set
      content = case when p_patch ? 'content' then p_patch->>'content' else m.content end,
      tool_calls = case when p_patch ? 'tool_calls' then p_patch->'tool_calls' else m.tool_calls end,
      attachments = case when p_patch ? 'attachments' then p_patch->'attachments' else m.attachments end,
      artifacts = case when p_patch ? 'artifacts' then p_patch->'artifacts' else m.artifacts end,
      metadata = case when p_patch ? 'metadata' then p_patch->'metadata' else m.metadata end
      where m.id = p_id and jsonb_build_object(
        'content', m.content, 'tool_calls', m.tool_calls,
        'attachments', m.attachments, 'artifacts', m.artifacts,
        'metadata', m.metadata) = p_expected;
  else
    return false;
  end if;

  v_updated := found;
  return v_updated;
end;
$$;

-- Bundle key_version is its payload schema. Rewrap must preserve it exactly;
-- using this RPC to convert a v1 bundle into v2 is rejected.
create or replace function public.rotate_infrastructure_connection_secret(
  p_connection_id uuid,
  p_expected_encrypted_bundle text,
  p_encrypted_bundle text,
  p_key_version smallint
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
set lock_timeout = '2s'
as $$
declare v_updated boolean := false;
begin
  update public.infrastructure_connection_secrets
    set encrypted_bundle = p_encrypted_bundle
    where connection_id = p_connection_id
      and encrypted_bundle = p_expected_encrypted_bundle
      and key_version = p_key_version;
  v_updated := found;
  return v_updated;
end;
$$;

revoke all on function public.rewrap_legacy_encryption_row(text,uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.rewrap_legacy_encryption_row(text,uuid,jsonb,jsonb)
  to service_role;

comment on function public.rewrap_legacy_encryption_row(text,uuid,jsonb,jsonb) is
  'Service-role-only CAS for the partial legacy key rewrapper; not complete rotation or key-retirement evidence.';
