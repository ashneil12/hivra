-- Whole-computer exports: one row per export the owner starts. The encrypted
-- file lives in the export bucket under object_key until expires_at; the
-- bucket's lifecycle rule deletes it. No passphrase, link or file content is
-- stored here. Service role only.
--
-- Additive and idempotent.

create table if not exists public.hivra_computer_exports (
  id            uuid primary key,
  user_id       text not null,
  agent_id      uuid not null references public.hivra_agents(id) on delete cascade,
  object_key    text not null unique,
  upload_id     text not null,
  part_size     integer not null check (part_size between 5242880 and 536870912),
  part_limit    integer not null check (part_limit between 1 and 2000),
  status        text not null default 'running' check (status in ('running', 'ready', 'failed')),
  byte_count    bigint check (byte_count >= 0),
  sha256        text check (sha256 ~ '^[0-9a-f]{64}$'),
  failure       text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  expires_at    timestamptz not null
);

create index if not exists hivra_computer_exports_agent_created_idx
  on public.hivra_computer_exports (agent_id, created_at desc);
create index if not exists hivra_computer_exports_user_created_idx
  on public.hivra_computer_exports (user_id, created_at desc);

alter table public.hivra_computer_exports enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_computer_exports from anon, authenticated;

comment on table public.hivra_computer_exports is
  'Whole-computer exports started by owners. The encrypted file sits in the export bucket until expires_at. No passphrase, link or content is stored.';
