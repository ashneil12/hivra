-- Compare-and-swap writes for the remaining stable master-key ciphertext
-- surfaces. Transient model delivery, launch custody and first-boot enrollment
-- must settle before rotation and are intentionally not writable here.
create or replace function public.rewrap_encryption_surface_v2(
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
declare v_updated boolean := false;
begin
  if p_id is null or jsonb_typeof(p_expected) is distinct from 'object'
    or jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb
    or octet_length(p_expected::text) > 16777216 or octet_length(p_patch::text) > 16777216
  then return false; end if;

  if p_surface = 'infrastructure_capacity_orders_bootstrap' then
    if not (p_expected ?& array['encrypted_bootstrap_bundle'])
      or p_expected - array['encrypted_bootstrap_bundle'] <> '{}'::jsonb
      or not (p_patch ?& array['encrypted_bootstrap_bundle'])
      or p_patch - array['encrypted_bootstrap_bundle'] <> '{}'::jsonb
      or jsonb_typeof(p_patch->'encrypted_bootstrap_bundle') not in ('string','null')
    then return false; end if;
    update public.infrastructure_capacity_orders o
      set encrypted_bootstrap_bundle=p_patch->>'encrypted_bootstrap_bundle'
      where o.id=p_id and jsonb_build_object(
        'encrypted_bootstrap_bundle',o.encrypted_bootstrap_bundle)=p_expected;

  elsif p_surface = 'bankr_deposit_wallet_credentials_key' then
    if not (p_expected ?& array['api_key_encrypted'])
      or p_expected - array['api_key_encrypted'] <> '{}'::jsonb
      or not (p_patch ?& array['api_key_encrypted'])
      or p_patch - array['api_key_encrypted'] <> '{}'::jsonb
      or jsonb_typeof(p_patch->'api_key_encrypted') not in ('string','null')
    then return false; end if;
    update public.bankr_deposit_wallet_credentials w
      set api_key_encrypted=p_patch->>'api_key_encrypted'
      where w.id=p_id and jsonb_build_object('api_key_encrypted',w.api_key_encrypted)=p_expected;

  elsif p_surface = 'instance_bankr_wallets_key' then
    if not (p_expected ?& array['api_key_encrypted'])
      or p_expected - array['api_key_encrypted'] <> '{}'::jsonb
      or not (p_patch ?& array['api_key_encrypted'])
      or p_patch - array['api_key_encrypted'] <> '{}'::jsonb
      or jsonb_typeof(p_patch->'api_key_encrypted') not in ('string','null')
    then return false; end if;
    update public.instance_bankr_wallets w
      set api_key_encrypted=p_patch->>'api_key_encrypted'
      where w.id=p_id and jsonb_build_object('api_key_encrypted',w.api_key_encrypted)=p_expected;

  elsif p_surface = 'hermes_chat_stream_jobs' then
    if not (p_expected ?& array['stream_request','fallback_request'])
      or p_expected - array['stream_request','fallback_request'] <> '{}'::jsonb
      or p_patch - array['stream_request','fallback_request'] <> '{}'::jsonb
      or exists(select 1 from jsonb_each(p_patch) e where jsonb_typeof(e.value)<>'object')
    then return false; end if;
    update public.hermes_chat_stream_jobs j set
      stream_request=case when p_patch?'stream_request' then p_patch->'stream_request' else j.stream_request end,
      fallback_request=case when p_patch?'fallback_request' then p_patch->'fallback_request' else j.fallback_request end
      where j.id=p_id and jsonb_build_object(
        'stream_request',j.stream_request,'fallback_request',j.fallback_request)=p_expected;
  else
    return false;
  end if;
  v_updated := found;
  return v_updated;
end;
$$;

-- Active agent model ciphertext is coupled to the current journal digest.
-- Move both in one transaction so existing lifecycle triggers remain enabled
-- and continue to reject every unjournaled model-setting change.
create or replace function public.rotate_hivra_agent_llm_secret(
  p_id uuid,
  p_expected text,
  p_replacement text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '2s'
as $$
declare a public.hivra_agents%rowtype;
  j public.hivra_model_key_operations%rowtype;
begin
  if p_id is null or p_expected is null or p_replacement is null
    or p_expected=p_replacement or octet_length(p_expected)>16384 or octet_length(p_replacement)>16384
  then return false; end if;
  select * into a from public.hivra_agents where id=p_id for update;
  if not found or a.llm_api_key_encrypted is distinct from p_expected
    or a.status='deleted' or a.desired_state='deleted'
  then return false; end if;
  select * into j from public.hivra_model_key_operations where agent_id=a.id and is_current for update;
  if found then
    if j.phase<>'applied' or j.cipher_digest is distinct from encode(sha256(convert_to(p_expected,'UTF8')),'hex')
    then return false; end if;
    update public.hivra_model_key_operations set
      cipher_digest=encode(sha256(convert_to(p_replacement,'UTF8')),'hex')
      where operation_id=j.operation_id and cipher_digest=j.cipher_digest;
    if not found then return false; end if;
  elsif exists(select 1 from public.hivra_model_key_operations where agent_id=a.id) then
    return false;
  end if;
  update public.hivra_agents set llm_api_key_encrypted=p_replacement
    where id=a.id and llm_api_key_encrypted=p_expected;
  return found;
end;
$$;

revoke all on function public.rewrap_encryption_surface_v2(text,uuid,jsonb,jsonb),
  public.rotate_hivra_agent_llm_secret(uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.rewrap_encryption_surface_v2(text,uuid,jsonb,jsonb),
  public.rotate_hivra_agent_llm_secret(uuid,text,text)
  to service_role;

comment on function public.rewrap_encryption_surface_v2(text,uuid,jsonb,jsonb) is
  'Service-role-only CAS for stable rotation surfaces; transient custody must settle first.';
comment on function public.rotate_hivra_agent_llm_secret(uuid,text,text) is
  'Service-role-only atomic rewrap of active agent model ciphertext and its current journal digest.';
