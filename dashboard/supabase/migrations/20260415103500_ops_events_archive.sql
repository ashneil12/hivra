alter table public.ops_events
    add column if not exists archived_at timestamptz,
    add column if not exists archived_by_user_id text;

create index if not exists ops_events_active_last_seen_idx
    on public.ops_events (last_seen_at desc)
    where archived_at is null;
