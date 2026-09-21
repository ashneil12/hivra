-- Keep revocation evidence stable after delete intent wins, including writes
-- from older LLM-settings clients. No historical rows are rewritten.
create or replace function public.guard_hivra_agent_delete_credentials()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_key_id text;
  v_key_status text;
begin
  if old.desired_state = 'deleted' and (
    new.llm_config is distinct from old.llm_config
    or new.llm_api_key_encrypted is distinct from old.llm_api_key_encrypted
  ) and not (
    new.status = 'deleted'
    and new.llm_config is null
    and new.llm_api_key_encrypted is null
  ) then
    raise exception 'agent credentials are frozen after delete intent'
      using errcode = '55000';
  end if;

  if new.status = 'deleted' then
    if old.status <> 'deleted' and old.llm_config is not null then
      if coalesce(old.llm_config->>'provider', '') <> 'venice'
        or coalesce(old.llm_config->>'mode', '') not in ('managed', 'byok')
      then
        raise exception 'agent key revocation metadata is incomplete'
          using errcode = '55000';
      end if;
      v_key_id := old.llm_config->>'proxyKeyId';
      if old.llm_config->>'mode' = 'managed' and coalesce(v_key_id, '') = '' then
        raise exception 'agent managed key identity is missing'
          using errcode = '55000';
      end if;
      if v_key_id is not null then
        select status into v_key_status
        from public.managed_venice_proxy_keys
        where id::text = v_key_id and user_id = old.user_id
        for update;
        if not found or v_key_status <> 'revoked' then
          raise exception 'agent managed key revocation is not verified'
            using errcode = '55000';
        end if;
      end if;
    end if;
    -- Erase the persisted BYOK/managed ciphertext only on terminal deletion.
    -- Failed or interrupted cleanup retains the original revocation metadata.
    new.llm_config := null;
    new.llm_api_key_encrypted := null;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_hivra_agent_delete_credentials()
  from public, anon, authenticated;
grant execute on function public.guard_hivra_agent_delete_credentials()
  to service_role;

drop trigger if exists hivra_agents_delete_credential_guard on public.hivra_agents;
create trigger hivra_agents_delete_credential_guard
  before update of status, llm_config, llm_api_key_encrypted on public.hivra_agents
  for each row execute function public.guard_hivra_agent_delete_credentials();
