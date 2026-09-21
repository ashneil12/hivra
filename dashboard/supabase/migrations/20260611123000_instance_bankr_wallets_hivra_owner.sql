-- Extend instance_bankr_wallets to also key a per-agent Bankr wallet to a
-- Hivra-catalog box (public.hivra_agents), not just a Hermes instance. This is
-- how the Hivra-lane CLI agents (codex / claude-code) get their own wallets,
-- reusing the exact same table + provisioning code as the Hermes lane.
--
-- Additive + back-compatible + idempotent: every existing row is instance_id-owned
-- and so satisfies the new exactly-one-owner CHECK unchanged.

alter table public.instance_bankr_wallets alter column instance_id drop not null;

alter table public.instance_bankr_wallets
  add column if not exists hivra_agent_id uuid references public.hivra_agents(id) on delete cascade;

-- A wallet belongs to a Hermes instance XOR a Hivra agent — never both, never neither.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'instance_bankr_wallets_one_owner') then
    alter table public.instance_bankr_wallets
      add constraint instance_bankr_wallets_one_owner
      check ((instance_id is not null) <> (hivra_agent_id is not null));
  end if;
end $$;

-- Swap the unconditional unique on instance_id for a partial one (so Hivra-owned
-- rows with a NULL instance_id are allowed) and add the matching partial unique
-- on hivra_agent_id (one wallet per box).
drop index if exists instance_bankr_wallets_instance_id_idx;
create unique index if not exists instance_bankr_wallets_instance_id_idx
  on public.instance_bankr_wallets(instance_id) where instance_id is not null;
create unique index if not exists instance_bankr_wallets_hivra_agent_id_idx
  on public.instance_bankr_wallets(hivra_agent_id) where hivra_agent_id is not null;

comment on column public.instance_bankr_wallets.hivra_agent_id is
  'Owning Hivra-catalog box (hivra_agents.id) when this is a Hivra-lane wallet. Mutually exclusive with instance_id (see instance_bankr_wallets_one_owner).';
