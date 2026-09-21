-- Public waitlist reservations for the hermesos.cloud/reserve page.
--
-- A reservation is email + tier intent only. No wallet, no payment, no
-- token-ownership signal lives on this row. The /api/reserve route is the
-- only writer; service-role only — no anon or authenticated direct read or
-- write. Position is assigned by a sequence so the queue order is stable.
--
-- Note: the requested filename was 20260429120000_reservations.sql, but
-- that timestamp is already taken by 20260429120000_unwind_fleet_command_legacy.sql.
-- Using 20260429130000 keeps the ordering stable and avoids a duplicate
-- timestamp that would break the migration history.

create sequence if not exists public.reservations_position_seq;

create table if not exists public.reservations (
    id uuid primary key default gen_random_uuid(),
    email text not null check (email ~* '^.+@.+\..+$'),
    tier_intent text not null check (tier_intent in ('free', 'pro', 'power')),
    position bigint not null default nextval('public.reservations_position_seq'),
    status text not null default 'queued' check (status in ('queued', 'invited', 'onboarded', 'cancelled')),
    notes jsonb not null default '{}'::jsonb,
    clerk_user_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter sequence public.reservations_position_seq owned by public.reservations.position;

create unique index if not exists reservations_email_lower_idx
    on public.reservations (lower(email));

create index if not exists reservations_position_idx
    on public.reservations (position);

create index if not exists reservations_clerk_user_idx
    on public.reservations (clerk_user_id)
    where clerk_user_id is not null;

create index if not exists reservations_status_position_idx
    on public.reservations (status, position);

alter table public.reservations enable row level security;

revoke all on public.reservations from anon, authenticated;
revoke all on sequence public.reservations_position_seq from anon, authenticated;

drop policy if exists "service role full access" on public.reservations;
create policy "service role full access"
    on public.reservations
    for all
    to service_role
    using (true)
    with check (true);

-- Keep updated_at fresh on row updates.
create or replace function public.reservations_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists reservations_set_updated_at on public.reservations;
create trigger reservations_set_updated_at
    before update on public.reservations
    for each row
    execute function public.reservations_set_updated_at();
