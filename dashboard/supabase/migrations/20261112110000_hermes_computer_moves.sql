-- Moving an existing Hermes agent onto the official Hermes: the move record.
--
-- WHY
-- A move runs for about ten minutes across two computers and several guest jobs,
-- and it must finish when the owner closes the page (a cron advances it) and be
-- undoable for a week. So each move is a durable row: its state machine, the
-- per-move encryption key (encrypted at rest, never returned to a browser), the
-- part list the new computer verifies, and the counts both sides must agree on.
-- Service role only: owners read a trimmed view through the move routes.
--
-- One move per old computer may be in flight at a time (partial unique index);
-- finished moves (done, failed, undone, needs_attention) stay as history.
-- lease_until is the advance lock (the owner's poll and the cron both advance a
-- move; the one holding the lease runs the step). prev_instance_status is what
-- the old row said before the pack stopped it, so a failure or an undo can put
-- it back. step_attempts and step_started_at bound retries of one step.
--
-- The bucket carries the encrypted parts between the two guests; the dashboard
-- only mints short-lived signed URLs, and parts are deleted once the move ends.
-- 52428800 bytes is the project upload limit (parts are at most 45 MB).
--
-- Additive and idempotent.

create table if not exists public.hermes_computer_moves (
  id                   uuid primary key default gen_random_uuid(),
  user_id              text not null,
  instance_id          uuid not null,
  agent_id             uuid,
  state                text not null default 'queued',
  step                 text not null default 'queued',
  message              text not null default '',
  key_encrypted        text,
  parts                jsonb,
  counts_before        jsonb,
  counts_after         jsonb,
  managed_model        boolean,
  initiated_by         text not null default 'owner',
  error                text,
  failure              jsonb,
  lease_until          timestamptz,
  prev_instance_status text,
  step_attempts        integer not null default 0,
  step_started_at      timestamptz,
  started_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  finished_at          timestamptz,
  undo_until           timestamptz
);

alter table public.hermes_computer_moves
  drop constraint if exists hermes_computer_moves_state_check,
  drop constraint if exists hermes_computer_moves_initiated_by_check;

alter table public.hermes_computer_moves
  add constraint hermes_computer_moves_state_check
    check (state in ('queued', 'launching', 'packing', 'uploading', 'unpacking', 'finishing',
                     'done', 'failed', 'needs_attention', 'undoing', 'undone')),
  add constraint hermes_computer_moves_initiated_by_check
    check (initiated_by in ('owner', 'operator'));

create unique index if not exists hermes_computer_moves_one_active_per_instance
  on public.hermes_computer_moves (instance_id)
  where state not in ('done', 'failed', 'needs_attention', 'undone');

create index if not exists hermes_computer_moves_state_idx
  on public.hermes_computer_moves (state);

create index if not exists hermes_computer_moves_agent_idx
  on public.hermes_computer_moves (agent_id);

alter table public.hermes_computer_moves enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hermes_computer_moves from anon, authenticated;

comment on table public.hermes_computer_moves is
  'One move of an old Hermes agent (hermes_instances) onto a new official Hermes computer (hivra_agents). State machine, per-move key (encrypted) and checks; service role only.';
comment on column public.hermes_computer_moves.failure is
  'Why a move failed or needs attention: { failureType, reason (plain English for the owner), technical }.';
comment on column public.hermes_computer_moves.key_encrypted is
  'Per-move AES key for the encrypted parts, encrypted with encryptSecret. Never returned to a browser.';
comment on column public.hermes_computer_moves.lease_until is
  'Advance lock: a step runs only while it holds an unexpired lease.';
comment on column public.hermes_computer_moves.prev_instance_status is
  'hermes_instances.status before the pack stopped the old row; restored on failure or undo.';

insert into storage.buckets (id, name, public, file_size_limit)
values ('hermes-moves', 'hermes-moves', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;
