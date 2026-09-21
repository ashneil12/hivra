-- SCRIPTURE_ANCHOR: schema-record | Malachi 3:16 | Verse: Then those who feared Yahweh spoke one with another, and Yahweh listened and heard.
create table if not exists public.ops_events (
    id uuid primary key default gen_random_uuid(),
    fingerprint text not null unique,
    source text not null,
    severity text not null check (severity in ('info', 'warn', 'error', 'fatal')),
    title text not null,
    message text not null,
    route text,
    user_id text,
    instance_id text,
    conversation_id text,
    profile_name text,
    sample_stack text,
    environment text not null default 'unknown',
    metadata jsonb not null default '{}'::jsonb,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    occurrence_count integer not null default 1,
    created_at timestamptz not null default now()
);

create index if not exists ops_events_last_seen_idx
    on public.ops_events (last_seen_at desc);

create index if not exists ops_events_severity_last_seen_idx
    on public.ops_events (severity, last_seen_at desc);

create index if not exists ops_events_user_last_seen_idx
    on public.ops_events (user_id, last_seen_at desc);

create index if not exists ops_events_instance_last_seen_idx
    on public.ops_events (instance_id, last_seen_at desc);

alter table public.ops_events enable row level security;

create policy "users can view own ops events"
    on public.ops_events
    for select
    to authenticated
    using ((select auth.uid())::text = user_id);
