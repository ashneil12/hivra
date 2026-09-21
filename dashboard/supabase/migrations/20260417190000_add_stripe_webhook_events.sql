create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  status text not null check (status in ('processing', 'processed', 'failed')),
  received_at timestamptz not null default timezone('utc'::text, now()),
  processed_at timestamptz null,
  updated_at timestamptz not null default timezone('utc'::text, now()),
  last_error text null
);

create index if not exists stripe_webhook_events_status_idx
  on public.stripe_webhook_events (status);
