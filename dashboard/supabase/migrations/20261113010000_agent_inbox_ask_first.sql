-- "Ask me first" for Claude Code agents: the owner's switch per computer, and
-- which tool each prompt was for (so "Allow for this chat" can cover the next
-- request from the same tool in the same chat). Additive and idempotent.

alter table public.agent_inbox_installs add column if not exists ask_first boolean not null default false;
alter table public.agent_inbox_prompts add column if not exists tool text;

create index if not exists agent_inbox_prompts_session_idx
  on public.agent_inbox_prompts using btree (agent_id, session_id, tool)
  where answer_choice = 'session';
