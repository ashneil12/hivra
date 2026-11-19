-- agent_inbox_prompts — what an agent on a Hivra computer is waiting on its
-- owner for (an approval or a question), and the owner's answer.
--
-- The hivra-inbox Hermes plugin (provisioner/hermes-plugins/hivra-inbox)
-- reports a prompt through POST /api/internal/agent-prompts, polls the same
-- route for an answer, and reports when the wait ends. The owner answers from
-- Needs you through POST /api/hivra/agents/[id]/prompts/[promptId]/answer.
--
-- agent_inbox_installs records which computers have the plugin, so the
-- install sweep (/api/cron/agent-inbox-install) visits each computer once per
-- plugin version.
--
-- Additive and idempotent.

create table if not exists public.agent_inbox_prompts (
  id               uuid        primary key default gen_random_uuid(),
  agent_id         uuid        not null references public.hivra_agents(id) on delete cascade,
  user_id          text        not null,
  -- Hermes's own request id for an approval; the hook's request id for a question.
  prompt_id        text        not null,
  kind             text        not null check (kind in ('approval', 'clarify')),
  -- Redacted on the computer by Hermes's redactor before it leaves.
  summary          text,
  command          text,
  -- False when the command was too long to show in full: then it may only be refused from Hivra.
  command_complete boolean     not null default false,
  -- The answers Hermes offers for this approval (subset of once/session/always/deny).
  choices          text[]      not null default '{}',
  session_id       text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  answer_choice    text        check (answer_choice is null or answer_choice in ('once', 'session', 'always', 'deny')),
  answer_text      text,
  answered_at      timestamptz,
  resolved_at      timestamptz,
  resolved_outcome text
);

create unique index if not exists agent_inbox_prompts_agent_prompt_key
  on public.agent_inbox_prompts using btree (agent_id, prompt_id);

create index if not exists agent_inbox_prompts_open_idx
  on public.agent_inbox_prompts using btree (agent_id, created_at desc)
  where resolved_at is null;

create index if not exists agent_inbox_prompts_user_idx
  on public.agent_inbox_prompts using btree (user_id, created_at desc);

alter table public.agent_inbox_prompts enable row level security;

drop policy if exists "owners read their agent prompts" on public.agent_inbox_prompts;
create policy "owners read their agent prompts"
  on public.agent_inbox_prompts for select to authenticated
  using (public.requesting_user_id() = user_id);

drop policy if exists "service role full access" on public.agent_inbox_prompts;
create policy "service role full access"
  on public.agent_inbox_prompts for all to service_role
  using (true) with check (true);

revoke all on public.agent_inbox_prompts from anon;

create table if not exists public.agent_inbox_installs (
  agent_id      uuid        primary key references public.hivra_agents(id) on delete cascade,
  version       text,
  installed_at  timestamptz,
  attempted_at  timestamptz,
  attempts      integer     not null default 0,
  last_error    text
);

alter table public.agent_inbox_installs enable row level security;

drop policy if exists "service role full access" on public.agent_inbox_installs;
create policy "service role full access"
  on public.agent_inbox_installs for all to service_role
  using (true) with check (true);

revoke all on public.agent_inbox_installs from anon, authenticated;

comment on table public.agent_inbox_prompts is
  'Approvals and questions an agent on a Hivra computer is waiting on, and the owner''s answers. Written by /api/internal/agent-prompts (hivra-inbox Hermes plugin) and /api/hivra/agents/[id]/prompts/[promptId]/answer.';
comment on table public.agent_inbox_installs is
  'Which Hivra computers have the hivra-inbox Hermes plugin, per version. Written by /api/cron/agent-inbox-install.';
