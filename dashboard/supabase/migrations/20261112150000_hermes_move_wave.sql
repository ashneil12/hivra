-- Moving every old Hermes agent onto the official Hermes, automatically.
--
-- WHY
-- Every old Hermes agent has to move to keep getting updates, so there is no
-- button: a wave moves them a few a day. The owner is emailed the day before
-- (hermes_instances.config.moveNoticeAt records when) and again once it is done.
-- The wave is one row an operator controls: off by default, a daily limit, and a
-- pause. Any automatic move that ends failed or needs attention pauses the wave
-- (paused_at); an operator looks, then resumes it (resumed_at), and only failures
-- after the last resume pause it again.
--
-- initiated_by gains 'auto' so the wave's moves are told apart from an
-- operator's single moves when the daily limit and the pause are counted.
--
-- Additive and idempotent. Service role only.

create table if not exists public.hermes_move_wave (
  id            boolean primary key default true check (id),
  enabled       boolean not null default false,
  per_day       integer not null default 5 check (per_day between 0 and 200),
  paused_at     timestamptz,
  paused_reason text,
  resumed_at    timestamptz,
  updated_at    timestamptz not null default now()
);

insert into public.hermes_move_wave (id) values (true) on conflict (id) do nothing;

alter table public.hermes_move_wave enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hermes_move_wave from anon, authenticated;

comment on table public.hermes_move_wave is
  'The automatic move of old Hermes agents onto the official Hermes: on/off, moves per day, and the pause a failed move sets. One row.';

alter table public.hermes_computer_moves
  drop constraint if exists hermes_computer_moves_initiated_by_check;

alter table public.hermes_computer_moves
  add constraint hermes_computer_moves_initiated_by_check
    check (initiated_by in ('owner', 'operator', 'auto'));

create index if not exists hermes_computer_moves_initiated_started_idx
  on public.hermes_computer_moves (initiated_by, started_at);
