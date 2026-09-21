-- HermesOS v2 LLM usage accounting foundation.
-- LLM spend is tracked separately from compute usage and token holdings.

create table if not exists public.llm_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (btrim(user_id) <> ''),
  instance_id uuid references public.hermes_instances(id) on delete set null,
  conversation_id text,
  provider text not null check (btrim(provider) <> ''),
  model text not null check (btrim(model) <> ''),
  billing_source text not null check (
    billing_source in ('hermes_credits', 'bankr_llm_credits', 'byo_key')
  ),
  credits_delta integer not null default 0 check (credits_delta <= 0),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  total_tokens integer check (total_tokens is null or total_tokens >= 0),
  reference_id text not null check (btrim(reference_id) <> ''),
  usage_period_start timestamptz,
  usage_period_end timestamptz,
  status text not null default 'recorded' check (status in ('recorded', 'voided')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc'::text, now()),
  unique (billing_source, reference_id)
);

create index if not exists llm_usage_events_user_created_idx
  on public.llm_usage_events (user_id, created_at desc);

create index if not exists llm_usage_events_instance_created_idx
  on public.llm_usage_events (instance_id, created_at desc);

create index if not exists llm_usage_events_reference_idx
  on public.llm_usage_events (billing_source, reference_id);

alter table public.llm_usage_events enable row level security;

drop policy if exists "Users can read own llm usage events" on public.llm_usage_events;
create policy "Users can read own llm usage events"
  on public.llm_usage_events for select
  using (user_id = current_setting('request.jwt.claims', true)::json->>'sub');

drop policy if exists "Service role full access llm_usage_events" on public.llm_usage_events;
create policy "Service role full access llm_usage_events"
  on public.llm_usage_events for all to service_role
  using (true) with check (true);
