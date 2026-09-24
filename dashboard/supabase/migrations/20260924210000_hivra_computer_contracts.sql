-- Computer Contract: the revisioned note Hivra gives each agent about its
-- computer (docs/superpowers/specs/2026-09-24-agent-computer-contract-and-attach.md,
-- section 4.6).
--
-- 1. hivra_computer_contracts keeps every rendered revision per agent with its
--    input and content digests, and the receipt that proves delivery. Manage
--    shows a revision as delivered only when a receipt for exactly those bytes
--    exists. The revision is monotonic per agent. Service role only.
--
-- 2. DigitalOcean sessions receive the note as a visible first message. The
--    prompt log gains a source column so the transcript can show that message
--    as a Hivra card instead of as something the owner typed.
--
-- Idempotent: every statement can be re-run.

create table if not exists public.hivra_computer_contracts (
  id               uuid        primary key default gen_random_uuid(),
  agent_id         uuid        not null references public.hivra_agents (id) on delete cascade,
  user_id          text        not null check (btrim(user_id) <> ''),
  revision         integer     not null check (revision between 1 and 1000000),
  template_version smallint    not null check (template_version between 1 and 100),
  -- proxmox-seed: Hivra Cloud and My server; provider-seed: My cloud (the
  -- enrolled provider pin); do-setup-message: a visible DigitalOcean message.
  channel          text        not null,
  input            jsonb       not null check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 8192),
  input_sha256     text        not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  content          text        not null check (octet_length(content) between 1 and 4096),
  content_sha256   text        not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  rendered_at      timestamptz not null default now(),
  -- pending: not yet acknowledged; delivered: a receipt for these exact bytes;
  -- sent: DigitalOcean accepted the visible setup message (never "delivered");
  -- conflict: the computer's copy was edited, so Hivra refused to overwrite it.
  delivery_state   text        not null default 'pending'
                               check (delivery_state in ('pending', 'delivered', 'sent', 'conflict')),
  delivered_at     timestamptz,
  receipt          jsonb       check (receipt is null or (jsonb_typeof(receipt) = 'object' and pg_column_size(receipt) <= 4096)),
  checked_at       timestamptz,
  last_attempt_at  timestamptz,
  last_error       text        check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  constraint hivra_computer_contracts_revision_key unique (agent_id, revision),
  -- A delivered or sent revision always carries its receipt. A revision that
  -- was delivered and later found edited keeps its delivery time as history.
  constraint hivra_computer_contracts_delivery_receipt_check check (
    (delivery_state not in ('delivered', 'sent') or (delivered_at is not null and receipt is not null))
    and (delivery_state <> 'pending' or delivered_at is null)
  )
);

-- Named, so a re-run replaces the allowed channels instead of stacking checks.
alter table public.hivra_computer_contracts
  drop constraint if exists hivra_computer_contracts_channel_check;
alter table public.hivra_computer_contracts
  add constraint hivra_computer_contracts_channel_check
  check (channel in ('proxmox-seed', 'provider-seed', 'do-setup-message'));

alter table public.hivra_computer_contracts enable row level security;
revoke all on public.hivra_computer_contracts from public, anon, authenticated;
grant all on public.hivra_computer_contracts to service_role;

alter table public.hivra_do_session_inputs
  add column if not exists source text not null default 'user';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hivra_do_session_inputs_source_check'
      and conrelid = 'public.hivra_do_session_inputs'::regclass
  ) then
    alter table public.hivra_do_session_inputs
      add constraint hivra_do_session_inputs_source_check check (source in ('user', 'hivra-setup'));
  end if;
end
$$;
