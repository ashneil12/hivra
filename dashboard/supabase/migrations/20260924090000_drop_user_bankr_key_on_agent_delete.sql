-- Drop Hivra's copy of a user-connected Bankr key when its agent is deleted.
--
-- Agent deletion is a soft delete (hermes_instances.status or
-- hivra_agents.status = 'deleted'), so the agent's instance_bankr_wallets row
-- survives it. For a wallet the user connected from their own Bankr account
-- (metadata.custodyModel = 'user_owned_bankr_account') that row holds the
-- encrypted API key the user handed to the agent; with the agent gone the
-- wallet page no longer lists it and the user cannot Disconnect it. Least
-- custody: drop the key exactly as disconnectUserBankrWalletForOwner does.
--
-- Hivra-provisioned wallets (custodyModel 'bankr_custodied_agent_wallet') are
-- untouched: their funds may still need withdrawing with the stored key.
--
-- A trigger rather than app code because a dozen writers reach the terminal
-- state (user delete, ops force-delete, host delete, purge cron, provider and
-- gVisor completion, error purge, ...). Best effort: a failure is logged as a
-- WARNING and never blocks the delete. The key stays valid at Bankr until the
-- user revokes it at bankr.bot/api-keys, which Hivra cannot do for them.

create or replace function public.drop_user_bankr_key_after_agent_delete()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  v_dropped integer;
begin
  begin
    update public.instance_bankr_wallets w set
      api_key_encrypted=null,
      api_key_preview=null,
      api_key_status='revoked',
      status='revoked',
      metadata=w.metadata || jsonb_build_object(
        'disconnectedAt', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'disconnectReason', 'agent_deleted'),
      updated_at=clock_timestamp()
    where w.metadata->>'custodyModel'='user_owned_bankr_account'
      and (w.api_key_encrypted is not null or w.api_key_preview is not null
        or w.status<>'revoked' or w.api_key_status<>'revoked')
      and case when tg_table_name='hivra_agents' then w.hivra_agent_id=new.id else w.instance_id=new.id end;
    get diagnostics v_dropped = row_count;
    if v_dropped > 0 then
      raise log 'drop_user_bankr_key_after_agent_delete: dropped user-connected Bankr key for %.%', tg_table_name, new.id;
    end if;
  exception when others then
    raise warning 'drop_user_bankr_key_after_agent_delete: failed for %.%: % (%)', tg_table_name, new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$$;

drop trigger if exists drop_user_bankr_key_after_hermes_instance_delete on public.hermes_instances;
create trigger drop_user_bankr_key_after_hermes_instance_delete
  after update of status on public.hermes_instances
  for each row when (new.status='deleted' and old.status is distinct from 'deleted')
  execute function public.drop_user_bankr_key_after_agent_delete();

drop trigger if exists drop_user_bankr_key_after_hivra_agent_delete on public.hivra_agents;
create trigger drop_user_bankr_key_after_hivra_agent_delete
  after update of status on public.hivra_agents
  for each row when (new.status='deleted' and old.status is distinct from 'deleted')
  execute function public.drop_user_bankr_key_after_agent_delete();

-- Trigger function: nothing calls it directly, so no role needs EXECUTE.
revoke all on function public.drop_user_bankr_key_after_agent_delete() from public, anon, authenticated, service_role;

-- Backfill keys already left behind by agents deleted before this trigger.
update public.instance_bankr_wallets w set
  api_key_encrypted=null,
  api_key_preview=null,
  api_key_status='revoked',
  status='revoked',
  metadata=w.metadata || jsonb_build_object(
    'disconnectedAt', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'disconnectReason', 'agent_deleted'),
  updated_at=clock_timestamp()
where w.metadata->>'custodyModel'='user_owned_bankr_account'
  and (w.api_key_encrypted is not null or w.api_key_preview is not null
    or w.status<>'revoked' or w.api_key_status<>'revoked')
  and (exists(select 1 from public.hermes_instances i where i.id=w.instance_id and i.status='deleted')
    or exists(select 1 from public.hivra_agents a where a.id=w.hivra_agent_id and a.status='deleted'));
