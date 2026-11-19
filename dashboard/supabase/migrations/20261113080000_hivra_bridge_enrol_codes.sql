-- Local bridge: one-command setup. "Set up a computer" no longer hands the
-- browser the bridge's secrets. It issues a one-time code (hvb_...) instead; the
-- owner pastes one command on that computer, which redeems the code once for the
-- configuration. Only the sha256 of the code is stored, it expires after 15
-- minutes, and redeeming it clears it (a code works once).
--
-- Additive and rerun-safe. The table keeps its existing lock-down: RLS on, no
-- policies, service role only.

alter table public.hivra_bridge_computers add column if not exists enrol_token_hash text;
alter table public.hivra_bridge_computers add column if not exists enrol_expires_at timestamptz;

alter table public.hivra_bridge_computers drop constraint if exists hivra_bridge_computers_enrol_pair;
alter table public.hivra_bridge_computers add constraint hivra_bridge_computers_enrol_pair
  check ((enrol_token_hash is null) = (enrol_expires_at is null)
         and (enrol_token_hash is null or enrol_token_hash ~ '^[0-9a-f]{64}$'));

create unique index if not exists hivra_bridge_computers_enrol_token_idx
  on public.hivra_bridge_computers (enrol_token_hash) where enrol_token_hash is not null;

alter table public.hivra_bridge_computers enable row level security;
revoke all on public.hivra_bridge_computers from public, anon, authenticated;
grant all on public.hivra_bridge_computers to service_role;
