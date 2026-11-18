-- agent_inbox_allow_rules — durable "Always allow" for Claude Code prompts in
-- Needs you. Created when the owner answers "Always allow" on a Claude Code
-- approval; checked by recordPending before a new prompt is shown, so a
-- scheduled job (new chat each run) does not ask again for the same thing.
--
-- command_pattern is the EXACT command text the owner saw (Bash), or the exact
-- "Write /path" / "Edit /path" text for file tools. Never a wildcard.
--
-- Server-only: RLS on, no public policies (the service role bypasses RLS).
-- Additive and idempotent.

create table if not exists public.agent_inbox_allow_rules (
  id                  uuid        primary key default gen_random_uuid(),
  agent_id            uuid        not null references public.hivra_agents(id) on delete cascade,
  user_id             text        not null,
  tool                text        not null,
  command_pattern     text,
  created_from_prompt uuid        references public.agent_inbox_prompts(id) on delete set null,
  created_at          timestamptz not null default now(),
  revoked_at          timestamptz
);

create index if not exists agent_inbox_allow_rules_active_idx
  on public.agent_inbox_allow_rules using btree (agent_id, tool)
  where revoked_at is null;

alter table public.agent_inbox_allow_rules enable row level security;

revoke all on public.agent_inbox_allow_rules from anon, authenticated;

comment on table public.agent_inbox_allow_rules is
  'Always-allow rules the owner created from Needs you for Claude Code (exact command or exact file path per tool). Read and written by the server only.';
