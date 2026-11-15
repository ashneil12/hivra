-- Telegram wake: arm the bot again after a wake that failed.
--
-- WHY
-- A wake takes the bot's wake webhook down before the host resumes the
-- computer. When that wake then fails, the agent row says wake_failed and the
-- computer may still be paused or saved to disk. The claim below refused any
-- agent that was not napping or hibernated, so such an agent was left asleep
-- with no webhook: deaf to its bot until someone opened it. A wake_failed
-- agent now counts as asleep for arming, and the next Telegram message wakes
-- it again (the webhook handler already wakes wake_failed agents).
--
-- Only the claim changes: one more sleep state is accepted. Idempotent.

set local lock_timeout = '2s';

create or replace function public.claim_hivra_agent_tg_arm(
  p_agent_id uuid, p_arm_id uuid, p_min_pending_s integer)
returns integer language plpgsql security definer set search_path = public as $$
declare a public.hivra_agents%rowtype; t public.hivra_agent_telegram_wake%rowtype;
begin
  if p_agent_id is null or p_arm_id is null or p_min_pending_s is null or p_min_pending_s < 0 then return null; end if;
  -- The agent row first, the same order every wake takes, so a wake claim and this never cross.
  select * into a from public.hivra_agents where id = p_agent_id for update;
  if not found then return null; end if;
  select * into t from public.hivra_agent_telegram_wake where agent_id = p_agent_id for update;
  if not found then return null; end if;
  if t.enabled is distinct from true or t.token_enc is null then return null; end if;
  if not (t.state = 'pending_arm'
    or (t.state = 'arming' and t.arm_started_at < clock_timestamp() - interval '2 minutes')) then return null; end if;
  if t.pending_since is null or t.pending_since > clock_timestamp() - make_interval(secs => p_min_pending_s) then return null; end if;
  if t.next_attempt_at is not null and t.next_attempt_at > clock_timestamp() then return null; end if;
  if t.blocked_until is not null and t.blocked_until > clock_timestamp() then return null; end if;
  -- wake_failed: a wake that failed may have left the computer paused or saved.
  if a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or a.operation_id is not null or a.sleep_state not in ('napping', 'hibernated', 'wake_failed') then return null; end if;
  update public.hivra_agent_telegram_wake set
    state = 'arming', arm_id = p_arm_id, arm_started_at = clock_timestamp(), updated_at = clock_timestamp()
  where agent_id = p_agent_id;
  return t.arm_failures;
end;
$$;

revoke all on function public.claim_hivra_agent_tg_arm(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_hivra_agent_tg_arm(uuid, uuid, integer) to service_role;
