-- instance_pending_prompts — "your agent is waiting on you" signal.
--
-- When tools/approval.py blocks an agent worker thread on a dangerous-command
-- approval, the only signal is an `approval.request` JSON-RPC frame pushed down
-- the workspace iframe's /api/ws socket. If the owner isn't looking at that
-- iframe the agent is indistinguishable from an idle one until the approval
-- times out (approvals.gateway_timeout) and unwinds as denied.
--
-- The agent now relays that block to POST /api/internal/agent-notify (see the
-- hivra_approval_relay plugin), which lands here.
--
-- Why NOT ops_events: getLatestInstanceFailureAlerts() takes the most recent
-- *unarchived* ops_event for an instance with no severity filter and renders it
-- as a failure badge. Writing an approval-pending row there would (a) label a
-- perfectly healthy agent as failed and (b) mask a real failure alert, since
-- only the first row per instance survives that dedupe loop. Approval-pending
-- is a distinct, self-resolving lane, so it gets its own table. An ops_event is
-- still written under the operator-only `synthetic.*` source prefix, which
-- getLatestInstanceFailureAlerts explicitly suppresses.
--
-- Additive + idempotent.

create table if not exists public.instance_pending_prompts (
  id              uuid        primary key default gen_random_uuid(),
  instance_id     uuid        not null references public.hermes_instances(id) on delete cascade,
  -- Stable across the pre/post hook pair: the agent's tool_call_id when present,
  -- else a digest of (session_key, turn_id, pattern_key, command).
  prompt_id       text        not null,
  user_id         text        not null,
  kind            text        not null default 'approval'
                                check (kind in ('approval', 'clarify')),
  surface         text,
  summary         text,
  -- Redacted + truncated on the agent before it leaves the box
  -- (agent.redact.redact_sensitive_text(force=True)).
  command         text,
  session_key     text,
  created_at      timestamptz not null default now(),
  -- Backstop for an agent that dies while blocked and never fires
  -- post_approval_response. Derived from the relayed ttl_seconds.
  expires_at      timestamptz not null,
  resolved_at     timestamptz,
  resolved_choice text        check (
                    resolved_choice is null
                    or resolved_choice in ('once', 'session', 'always', 'deny', 'timeout')
                  ),
  -- Set by the expire-pending-prompts cron AFTER Resend accepts the
  -- "your agent needs you" nudge. The email fires once per prompt: the sweep
  -- only selects rows where this is null (email-first, mark-second), and a
  -- stable Resend idempotencyKey backstops a lost marker write.
  notified_at     timestamptz
);

-- One row per (instance, prompt). The relay's `prompt.resolved` event and any
-- duplicate `prompt.pending` retry both upsert onto this key.
create unique index if not exists instance_pending_prompts_instance_prompt_key
  on public.instance_pending_prompts using btree (instance_id, prompt_id);

-- The hot read: "does this instance have an unresolved, unexpired prompt?"
create index if not exists instance_pending_prompts_open_idx
  on public.instance_pending_prompts using btree (instance_id, created_at desc)
  where resolved_at is null;

create index if not exists instance_pending_prompts_user_idx
  on public.instance_pending_prompts using btree (user_id, created_at desc);

-- Sweep support for the expiry/email cron.
create index if not exists instance_pending_prompts_expiry_idx
  on public.instance_pending_prompts using btree (expires_at)
  where resolved_at is null;

alter table public.instance_pending_prompts enable row level security;

drop policy if exists "users can view own pending prompts" on public.instance_pending_prompts;
drop policy if exists "service role full access" on public.instance_pending_prompts;

create policy "users can view own pending prompts"
  on public.instance_pending_prompts
  for select
  to authenticated
  using (public.requesting_user_id() = user_id);

create policy "service role full access"
  on public.instance_pending_prompts
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.instance_pending_prompts from anon;

comment on table public.instance_pending_prompts is
  'Open user-input prompts an agent is blocked on (approval/clarify). Written by POST /api/internal/agent-notify from the hivra_approval_relay agent plugin; resolved by the matching prompt.resolved event or expired by cron.';
