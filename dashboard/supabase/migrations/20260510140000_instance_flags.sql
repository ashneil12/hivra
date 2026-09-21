-- instance_flags — resource watchdog incidents.
--
-- The resource-watchdog cron raises one row here every time a heuristic
-- fires (free-tier RAM cap pinned, paid-tier sustained CPU at the cap,
-- future abuse signals). The row is the queryable record of "we noticed
-- X, did Y about it, here's how the user / operator should respond."
--
-- Free tier rows are auto-resolved by the same cron when the offending
-- VM is paused (paused_reason = 'ram_cap_hit') — paused VMs can't keep
-- pinning the cap, so the flag's job is done. Paid tier rows stay open
-- until the operator manually resolves them via dashboard or DB update.
-- An (instance_id, flag_type) partial unique index on unresolved rows
-- keeps the cron idempotent: each instance can have at most one open
-- flag per type, so cron retries don't spam.
--
-- flag_data jsonb captures the numbers that triggered the heuristic:
--   { window_minutes, sample_count, avg_ram_pct } for ram_cap_hit
--   { window_hours, avg_cpu_pct, runtime_seconds_delta } for cpu_sustained
-- Reading the row alone gives the operator everything needed to decide
-- ignore / warn / suspend without re-querying metering events.

create table if not exists public.instance_flags (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.hermes_instances(id) on delete cascade,
  user_id text not null,
  flag_type text not null,
  flag_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- 'ignore' | 'warn' | 'suspend' | 'auto_resolved' — what the operator
  -- (or the cron, for ram_cap_hit) chose. NULL while the row is open.
  resolution_action text
);

create index if not exists instance_flags_instance_idx
  on public.instance_flags (instance_id, created_at desc);

create index if not exists instance_flags_open_idx
  on public.instance_flags (created_at desc)
  where resolved_at is null;

-- Idempotency rail: cron must not spam new flags while the previous one
-- is still open. UI can show the existing flag; operator can resolve to
-- get a fresh signal.
create unique index if not exists instance_flags_open_per_type_idx
  on public.instance_flags (instance_id, flag_type)
  where resolved_at is null;

alter table public.instance_flags enable row level security;

-- Service role manages everything. No user-facing reads — operators
-- query directly or via admin tooling, not via Clerk-authenticated UI.

comment on table public.instance_flags is
  'Resource-watchdog incidents. Append-on-detect, resolve-on-action. '
  'See src/lib/resource-watchdog.ts for the producers and '
  'src/lib/email/resource-watchdog-* for the operator notifications.';

comment on column public.instance_flags.flag_type is
  'Heuristic that fired: ''ram_cap_hit'' (free tier RAM pinned at cap) '
  'or ''cpu_sustained'' (paid tier 95%+ CPU over 24h). Reserved for '
  'future heuristics — extend the producer, no migration needed.';

comment on column public.instance_flags.flag_data is
  'Numbers that justified the flag (avg %, sample count, window length). '
  'Read directly by the admin email template so the operator sees '
  'context without re-querying.';

comment on column public.instance_flags.resolution_action is
  '''ignore'' = legitimate workload, no action. ''warn'' = follow-up '
  'email sent. ''suspend'' = manual VM pause + customer notice. '
  '''auto_resolved'' = cron itself closed the flag (e.g. ram_cap_hit '
  'after the VM was paused).';
