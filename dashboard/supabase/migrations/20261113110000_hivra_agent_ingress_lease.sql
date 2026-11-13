-- A lease on hivra_agent_ingress, so one host ingress enable or rollback runs
-- for an agent at a time.
--
-- WHY
-- The per-agent cutover (enable) and its rollback each run several steps on the
-- host, in the guest and at Cloudflare. Two of them for the same agent at once
-- could leave a connector on neither side. The lease is taken with a
-- conditional update (free, or expired) and every phase write is conditioned on
-- the caller still holding it. An expired lease can be taken over, so a
-- crashed run never blocks the agent for good. Nothing reads these columns
-- until HIVRA_HOST_INGRESS is set; with no rows nothing changes.
--
-- Additive and idempotent. The table stays service role only.

set local lock_timeout = '2s';

alter table public.hivra_agent_ingress
  add column if not exists lease_id uuid,
  add column if not exists lease_expires_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.hivra_agent_ingress'::regclass
       and conname = 'hivra_agent_ingress_lease_pair_check'
  ) then
    alter table public.hivra_agent_ingress
      add constraint hivra_agent_ingress_lease_pair_check
      check ((lease_id is null) = (lease_expires_at is null)) not valid;
  end if;
end
$$;

alter table public.hivra_agent_ingress validate constraint hivra_agent_ingress_lease_pair_check;

comment on column public.hivra_agent_ingress.lease_id is
  'Set while an enable or rollback runs for this agent. Every phase write checks it.';
comment on column public.hivra_agent_ingress.lease_expires_at is
  'When the lease may be taken over by another run (a crashed run never blocks the agent for good).';

alter table public.hivra_agent_ingress enable row level security;
revoke all on public.hivra_agent_ingress from public, anon, authenticated;
grant select, insert, update, delete on public.hivra_agent_ingress to service_role;
