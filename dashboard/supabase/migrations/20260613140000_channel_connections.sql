-- channel_connections — a persisted, queryable signal that a user connected an
-- agent to an outbound channel (Telegram today). Powers the deploy→connect
-- activation funnel on /dashboard/insights, which a live box probe can't: boxes
-- pause / churn, so the "connected" signal must outlive any single box.
--
-- Written only by the service-role API route (/api/telegram/record-connection)
-- after a successful connect. RLS is enabled with NO public policies, so anon /
-- authenticated PostgREST clients get nothing; only the service role (which
-- bypasses RLS) reads/writes. Rerun-safe (if-not-exists throughout).

create table if not exists public.channel_connections (
  id                uuid        primary key default gen_random_uuid(),
  user_id           text        not null,
  channel           text        not null,           -- 'telegram' (future: 'discord' …)
  target_kind       text        not null,           -- 'hivra' | 'hermes'
  target_id         text        not null,
  connected_at      timestamptz not null default now(),
  last_connected_at timestamptz not null default now(),
  unique (user_id, channel, target_kind, target_id)
);

comment on table public.channel_connections is
  'One row per (user, channel, agent) that has been connected. Feeds the activation funnel; written by /api/telegram/record-connection (service role).';

create index if not exists idx_channel_connections_connected_at
  on public.channel_connections(connected_at);
create index if not exists idx_channel_connections_channel_connected_at
  on public.channel_connections(channel, connected_at);
create index if not exists idx_channel_connections_user
  on public.channel_connections(user_id);

alter table public.channel_connections enable row level security;
