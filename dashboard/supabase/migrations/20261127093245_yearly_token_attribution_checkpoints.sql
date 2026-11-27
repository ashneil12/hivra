create table if not exists public.yearly_token_attribution_checkpoints (
  quote_id uuid primary key references public.yearly_token_quotes(id) on delete cascade,
  revision uuid not null,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  progressed_at timestamptz not null
);

alter table public.yearly_token_attribution_checkpoints enable row level security;
revoke all on public.yearly_token_attribution_checkpoints from public, anon, authenticated;
grant select, insert, update, delete on public.yearly_token_attribution_checkpoints to service_role;
