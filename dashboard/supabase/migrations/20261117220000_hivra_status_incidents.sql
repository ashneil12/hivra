-- Public status page incidents. Written by an admin through
-- /api/admin/status-incidents; only rows with published = true are shown on
-- /status. Reads and writes go through the service role (supabaseAdmin).
--
-- Idempotent: safe to run against a database that already has the table.

create table if not exists public.hivra_status_incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  component text,
  severity text not null check (severity in ('degraded', 'down', 'maintenance')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hivra_status_incidents_published_started_idx
  on public.hivra_status_incidents (started_at desc)
  where published;

alter table public.hivra_status_incidents enable row level security;

-- No policies on purpose: the service role bypasses RLS, and nobody else may
-- read or write this table directly.

comment on table public.hivra_status_incidents is
  'Incidents and maintenance notes shown on the public status page. Only published rows are shown.';
