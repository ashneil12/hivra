-- The original `profiles` table was committed as a tiny compatibility stub.
-- WebUI profile management now uses it as the agent-profile cache, so production
-- needs the full shape before live VM updates can restore profile gateway routes.

alter table public.profiles
  add column if not exists instance_id uuid references public.hermes_instances(id) on delete cascade,
  add column if not exists name text,
  add column if not exists display_name text,
  add column if not exists model text,
  add column if not exists provider text,
  add column if not exists system_prompt text,
  add column if not exists gateway_port integer,
  add column if not exists status text not null default 'running',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.profiles
set display_name = name
where display_name is null
  and name is not null;

create unique index if not exists profiles_instance_name_idx
  on public.profiles (instance_id, name);

create index if not exists profiles_instance_user_idx
  on public.profiles (instance_id, user_id);

create index if not exists profiles_gateway_routes_idx
  on public.profiles (instance_id, user_id, gateway_port)
  where gateway_port is not null;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.update_updated_at();

alter table public.profiles enable row level security;

drop policy if exists "users manage own profiles" on public.profiles;
create policy "users manage own profiles"
  on public.profiles
  for all
  to authenticated
  using (public.requesting_user_id() = user_id)
  with check (public.requesting_user_id() = user_id);

drop policy if exists "service role full access profiles" on public.profiles;
create policy "service role full access profiles"
  on public.profiles
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.profiles from anon;
