-- Setup from a coding agent (off unless HIVRA_AGENT_SETUP_HANDSHAKE is on).
--
-- A coding agent on someone's laptop (Claude Code, Codex, Cursor...) asks Hivra
-- to set up an agent for its person. It gets a short code, a link for the person
-- and a secret it polls with. The person opens the link, signs in, checks the
-- code and continues to Launch with the agent preselected. The poll then reports
-- the first matching agent the person launched after that, with its link.
--
-- Only the server reads or writes this table (service role). Nothing here grants
-- anything: the person still signs in and presses Launch themselves.
create table if not exists public.hivra_agent_setup_requests (
  id            uuid        primary key default gen_random_uuid(),
  code          text        not null unique,
  token_hash    text        not null,
  agent         text,
  inference     text,
  client        text,
  user_id       text,
  claimed_at    timestamptz,
  agent_id      uuid,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  constraint hivra_agent_setup_requests_code_shape check (code ~ '^[A-Z2-9]{8}$'),
  constraint hivra_agent_setup_requests_inference check (inference is null or inference in ('venice', 'venice-key')),
  constraint hivra_agent_setup_requests_claim_pair check ((user_id is null) = (claimed_at is null))
);

create index if not exists hivra_agent_setup_requests_expires_idx
  on public.hivra_agent_setup_requests using btree (expires_at);

alter table public.hivra_agent_setup_requests enable row level security;
revoke all on public.hivra_agent_setup_requests from anon, authenticated;
