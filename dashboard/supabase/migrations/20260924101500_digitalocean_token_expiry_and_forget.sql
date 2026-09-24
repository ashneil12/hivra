-- DigitalOcean lane: owner-declared token expiry and "Forget this agent".
--
-- 1. DigitalOcean does not report a personal access token's expiry through the
--    API, so Hivra records the date the owner declares when connecting or
--    replacing the token (or that they chose "No expiry"). The card and the
--    agent page read it to warn before the token stops working. It is a hint
--    the owner gave, never provider evidence, and is shown that way.
--
-- 2. When the saved token can no longer reach a session (rejected, revoked, or
--    unreadable), deleting the agent needs that token, so the owner was stuck.
--    A "forgotten" cleanup receipt releases the Hivra row without claiming the
--    session is gone at DigitalOcean. The service only writes it after a
--    failed credential check, and the receipt records that acknowledgement.

create table if not exists public.infrastructure_credential_expiry (
  connection_id uuid primary key,
  user_id text not null check (btrim(user_id) <> ''),
  no_expiry boolean not null,
  expires_on date,
  declared_at timestamptz not null default now(),
  constraint infrastructure_credential_expiry_connection_fk
    foreign key (connection_id, user_id)
    references public.infrastructure_connections (id, user_id) on delete cascade,
  constraint infrastructure_credential_expiry_shape_check
    check ((no_expiry and expires_on is null) or (not no_expiry and expires_on is not null))
);

alter table public.infrastructure_credential_expiry enable row level security;
revoke all on public.infrastructure_credential_expiry from public, anon, authenticated;
grant all on public.infrastructure_credential_expiry to service_role;

-- Restated verbatim from 20260923120000_digitalocean_managed_agent_sessions.sql
-- with one change: a deleted row may also carry a "forgotten" receipt, which
-- must record when the owner acknowledged that the session may remain.
alter table public.hivra_agents
  drop constraint if exists hivra_agents_do_session_identity_check;
alter table public.hivra_agents
  add constraint hivra_agents_do_session_identity_check check ((
    (computer_substrate <> 'do-managed-session'
      and do_session_name is null and do_session_id is null and do_session_harness is null
      and do_session_size is null and do_launch_request_id is null
      and do_session_observation is null and do_cleanup_receipt is null)
    or (computer_substrate = 'do-managed-session'
      and deployment_mode = 'self-managed' and vmid is null
      and provider_capacity_order_id is null and provider_enrollment_attempt_id is null
      and provider_server_id is null and gvisor_sandbox_id is null
      and computer_profile is null
      and infrastructure_binding_token_enforced is true
      and do_launch_request_id is not null
      -- Deterministic per agent so a lost create response is reconciled by
      -- name instead of creating a second billable session.
      and do_session_name = 'hivra-' || replace(id::text, '-', '')
      and (do_session_id is null or do_session_id ~ '^[A-Za-z0-9_.:-]{1,128}$')
      and ((do_session_harness = 'claude-code' and type = 'claude-code')
        or (do_session_harness = 'codex' and type = 'codex')
        or (do_session_harness = 'hermes' and type = 'hermes'))
      and do_session_size in ('mars-1vcpu-1gb','mars-2vcpu-2gb','mars-2vcpu-4gb','mars-4vcpu-8gb','mars-16vcpu-32gb')
      and (do_session_observation is null or jsonb_typeof(do_session_observation) = 'object')
      and (
        (status <> 'deleted' and do_cleanup_receipt is null
          and infrastructure_connection_id is not null and deployment_target_id is not null
          and infrastructure_connection_revision is not null)
        or (status = 'deleted' and infrastructure_connection_id is null
          and deployment_target_id is null and infrastructure_connection_revision is null
          and jsonb_typeof(do_cleanup_receipt) = 'object'
          and (do_cleanup_receipt->>'state' in ('absent', 'never-created')
            or (do_cleanup_receipt->>'state' = 'forgotten'
              and do_cleanup_receipt->>'acknowledgedAt' is not null))
          and do_cleanup_receipt->>'sessionName' = do_session_name))
      and operation_id is null)
  ) is true);
