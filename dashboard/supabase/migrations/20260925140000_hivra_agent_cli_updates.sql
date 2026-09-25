-- Claude Code and Codex versions on Hivra agents, and automatic updates.
--
-- WHY
-- Hivra turns the vendors' own self-updaters off and moves Claude Code and
-- Codex to the version it has tested (provisioner/agent-cli-versions.json)
-- through the in-place connection-service update. Owners need to see when an
-- agent is behind that version and what an update did, and Hivra needs to
-- update idle agents on its own. One row per agent holds:
--   * the last observation read from the computer (GET /api/meta agentCli,
--     read server-side with the computer's bearer, which never reaches the
--     browser for this);
--   * the version Hivra itself confirmed on the computer, so an owner's own
--     newer install is never downgraded automatically;
--   * the last update request (owner or automatic) and its immediate result,
--     with a claim function that allows one request per target every 20 hours
--     and refuses an automatic one the owner hasn't allowed;
--   * the owner's automatic-update choice: null follows Hivra's default (on
--     for Hivra Cloud, off on the owner's own server), and the pause after an
--     automatic update to a target failed.
-- Skipped automatic updates are not written anywhere, so Activity isn't
-- flooded (the same argument as hivra_activity_collectors' heartbeats).
--
-- Written only by the service role (the owner API, the lifecycle route and the
-- update-hivra-agent-clis cron). RLS enabled with no policies, closed to the
-- API roles. Additive: nothing existing changes.

create table if not exists public.hivra_agent_cli_updates (
  agent_id uuid primary key references public.hivra_agents (id) on delete cascade,
  user_id text not null,
  -- null follows Hivra's default: on for Hivra Cloud, off for My server.
  auto_update boolean,
  auto_update_changed_at timestamptz,
  cli_name text check (cli_name in ('claude-code', 'codex')),
  observation text check (observation in (
    'reported', 'checking', 'version_unreadable', 'older_connection_service', 'unreachable', 'not_reported'
  )),
  installed_version text check (installed_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  tested_version text check (tested_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  hivra_installed_version text check (hivra_installed_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  update_state text check (update_state in (
    'downloading', 'waiting', 'installing', 'done', 'deferred', 'rolled_back', 'failed'
  )),
  update_target text check (update_target ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  update_reason text check (update_reason ~ '^[a-z_]{1,40}$'),
  update_updated_at timestamptz,
  observed_at timestamptz,
  requested_at timestamptz,
  requested_target text check (requested_target ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  requested_by text check (requested_by in ('owner', 'auto')),
  request_result text check (request_result in (
    'scheduled', 'current', 'running', 'failed', 'host_not_ready', 'busy', 'unverified', 'refused'
  )),
  auto_paused_target text check (auto_paused_target ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  auto_paused_reason text check (auto_paused_reason in ('rolled_back', 'failed')),
  updated_at timestamptz not null default now(),
  constraint hivra_agent_cli_updates_pause_shape
    check ((auto_paused_target is null) = (auto_paused_reason is null)),
  constraint hivra_agent_cli_updates_request_shape
    check ((requested_at is null) = (requested_target is null)
      and (requested_at is null) = (requested_by is null)),
  constraint hivra_agent_cli_updates_update_shape
    check ((update_state is null) = (update_target is null))
);

create index if not exists hivra_agent_cli_updates_user_idx
  on public.hivra_agent_cli_updates (user_id);

alter table public.hivra_agent_cli_updates enable row level security;
revoke all on public.hivra_agent_cli_updates from public, anon, authenticated;
grant all on public.hivra_agent_cli_updates to service_role;

comment on table public.hivra_agent_cli_updates is
  'Claude Code / Codex version observations, update requests and the owner''s automatic-update choice per Hivra agent; service role only.';

-- Claims one update request for (agent, target). Refuses when the agent isn't
-- the owner's, or when the same target was already requested in the cooldown
-- window, so overlapping sweeps and a failing target can't repeat an update.
-- Only a request that never reached the computer because the host hadn't
-- taken the current release yet or another operation held the agent
-- (host_not_ready, busy) leaves the cooldown open: those clear by themselves.
-- Any other refusal (a credential to replace, no computer, a bad address)
-- holds it, so an automatic update isn't retried every run for a reason that
-- won't change.
--
-- For an automatic request this function is the authority on the owner's
-- choice, checked against the row it locks: it refuses when the owner turned
-- automatic updates off, when they never chose and the agent is on their own
-- server (off by default), and when the target is paused after an automatic
-- update to it failed. A sweep that read a stale or missing row can't
-- override the owner.
-- Returns true when this caller holds the request.
create or replace function public.claim_hivra_agent_cli_update_request(
  p_agent_id uuid,
  p_user_id text,
  p_cli_name text,
  p_target text,
  p_requested_by text,
  p_cooldown interval default interval '20 hours'
) returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  claimed boolean;
  agent_mode text;
begin
  select a.deployment_mode into agent_mode
  from public.hivra_agents a
  where a.id = p_agent_id and a.user_id = p_user_id and a.status <> 'deleted';
  if not found then
    return false;
  end if;
  -- On the owner's own server automatic updates are off until the owner
  -- turns them on, so with no stored choice there is nothing to claim.
  if p_requested_by = 'auto' and agent_mode = 'self-managed' and not exists (
    select 1 from public.hivra_agent_cli_updates r
    where r.agent_id = p_agent_id and r.auto_update is true
  ) then
    return false;
  end if;
  insert into public.hivra_agent_cli_updates as current_row (
    agent_id, user_id, cli_name, requested_at, requested_target, requested_by, request_result, updated_at
  )
  values (p_agent_id, p_user_id, p_cli_name, now(), p_target, p_requested_by, null, now())
  on conflict (agent_id) do update
    set cli_name = excluded.cli_name,
        requested_at = excluded.requested_at,
        requested_target = excluded.requested_target,
        requested_by = excluded.requested_by,
        request_result = null,
        updated_at = excluded.updated_at
    where current_row.user_id = excluded.user_id
      and (p_requested_by <> 'auto' or (
        coalesce(current_row.auto_update, agent_mode is distinct from 'self-managed')
        and current_row.auto_paused_target is distinct from excluded.requested_target))
      and (current_row.requested_target is distinct from excluded.requested_target
        or current_row.requested_at is null
        or current_row.requested_at < now() - p_cooldown
        or current_row.request_result in ('host_not_ready', 'busy'))
  returning true into claimed;
  return coalesce(claimed, false);
end
$$;

revoke all on function public.claim_hivra_agent_cli_update_request(uuid, text, text, text, text, interval)
  from public, anon, authenticated;
grant execute on function public.claim_hivra_agent_cli_update_request(uuid, text, text, text, text, interval)
  to service_role;
