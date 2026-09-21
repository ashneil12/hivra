-- Hivra free Claude launch: allow half-core agent rows.
--
-- Free Claude boxes are intentionally 0.5 CPU / 1 GB. Proxmox represents that
-- as one guest-visible core capped by --cpulimit 0.5, so the database row must
-- store the scheduler cap as numeric instead of rounding to an integer.

alter table public.hivra_agents
  alter column cpu type numeric using cpu::numeric,
  alter column cpu set default 0.5;
