-- Local bridge (WP-220d): an agent asks to run one command on the owner's own
-- computer, and the owner approves it in the dashboard first. Whole feature is
-- behind HIVRA_LOCAL_BRIDGE_ENABLED (off by default).
--
-- 1. hivra_bridge_computers: one row per computer the owner enrolled. `id` is
--    both the computer id and the relay connection id. `generation` is the
--    relay connector generation; a revoke raises it, which stops the bridge.
--
-- 2. hivra_bridge_requests: every exec request and the owner's decision. The
--    control plane mints a ticket only for a row it moved approved -> running.
--    `result` holds what the command printed (owner and agent only read it).
--
-- 3. hivra_bridge_allowances: "allow this agent for 1 hour". At most one per
--    (agent, computer), and the check constraint caps it at one hour, so there
--    is no allow-forever.
--
-- Service role only: RLS on, no policies. Additive and rerun-safe.

create table if not exists public.hivra_bridge_computers (
  id          uuid        primary key default gen_random_uuid(),
  user_id     text        not null check (btrim(user_id) <> ''),
  label       text        not null check (char_length(btrim(label)) between 1 and 80),
  generation  integer     not null default 1 check (generation >= 1),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists hivra_bridge_computers_user_idx on public.hivra_bridge_computers (user_id);

alter table public.hivra_bridge_computers enable row level security;
revoke all on public.hivra_bridge_computers from public, anon, authenticated;
grant all on public.hivra_bridge_computers to service_role;

create table if not exists public.hivra_bridge_requests (
  id               uuid        primary key default gen_random_uuid(),
  user_id          text        not null check (btrim(user_id) <> ''),
  agent_id         uuid        not null references public.hivra_agents (id) on delete cascade,
  computer_id      uuid        not null references public.hivra_bridge_computers (id) on delete cascade,
  argv             jsonb       not null check (jsonb_typeof(argv) = 'array'),
  argv_sha256      text        not null check (argv_sha256 ~ '^[0-9a-f]{64}$'),
  cwd              text        check (cwd is null or char_length(cwd) <= 4096),
  timeout_seconds  integer     not null check (timeout_seconds between 1 and 120),
  max_output_bytes integer     not null check (max_output_bytes between 1 and 1048576),
  status           text        not null default 'pending'
                   check (status in ('pending', 'approved', 'running', 'done', 'denied', 'expired', 'failed')),
  decision         text        check (decision is null or decision in ('approve', 'deny', 'allow_hour', 'allowance')),
  decided_at       timestamptz,
  result           jsonb,
  error_code       text        check (error_code is null or char_length(error_code) <= 80),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  dispatched_at    timestamptz,
  finished_at      timestamptz
);

create index if not exists hivra_bridge_requests_user_idx on public.hivra_bridge_requests (user_id, created_at desc);
create index if not exists hivra_bridge_requests_agent_idx on public.hivra_bridge_requests (agent_id, status);

alter table public.hivra_bridge_requests enable row level security;
revoke all on public.hivra_bridge_requests from public, anon, authenticated;
grant all on public.hivra_bridge_requests to service_role;

create table if not exists public.hivra_bridge_allowances (
  id          uuid        primary key default gen_random_uuid(),
  user_id     text        not null check (btrim(user_id) <> ''),
  agent_id    uuid        not null references public.hivra_agents (id) on delete cascade,
  computer_id uuid        not null references public.hivra_bridge_computers (id) on delete cascade,
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  constraint hivra_bridge_allowances_pair unique (agent_id, computer_id),
  constraint hivra_bridge_allowances_one_hour check (expires_at > granted_at and expires_at <= granted_at + interval '1 hour')
);

alter table public.hivra_bridge_allowances enable row level security;
revoke all on public.hivra_bridge_allowances from public, anon, authenticated;
grant all on public.hivra_bridge_allowances to service_role;
