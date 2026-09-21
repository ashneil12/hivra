-- Phase 1 (Hivra V1 rebuild): formalize the implicit compute pool into an explicit
-- entity, and make agent type first-class.
--
-- The "pool" already existed implicitly as the subscription compute budget
-- (hermes_subscriptions.{instance_limit,total_cpu_budget,total_ram_budget}, summed
-- across a user's agents at instance-service.ts:~1978). This makes it a real row that
-- both agent tables reference, and adds an explicit agent_type discriminator.
--
-- Additive + idempotent + nullable-first: old code ignores pool_id; it is written now
-- (backfill + billing webhooks) and read later (Phase 4). Provisioning behaviour is
-- unchanged. Architecture lock (v1.1): one agent = one isolated VM; the pool is a
-- USER-LEVEL budget across separate deployments — NOT a shared VM.

-- 1) pools — one per (user_id, product_surface), mirrors the subscription budget.
create table if not exists public.pools (
  id              uuid        primary key default gen_random_uuid(),
  user_id         text        not null,
  product_surface text        not null default 'hermesos',
  subscription_id uuid,
  cpu_budget      numeric     not null default 0,
  ram_budget_mb   integer     not null default 0,
  agent_slots     integer     not null default 1,
  priority        integer     not null default 0,   -- Phase 5 scheduling weight (0=low..2=high)
  status          text        not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, product_surface)
);
create index if not exists pools_user_idx on public.pools using btree (user_id);

-- 2) agents reference a pool; agent type becomes explicit (hivra_agents.type already is the type).
alter table public.hermes_instances add column if not exists pool_id uuid references public.pools(id) on delete restrict;
alter table public.hermes_instances add column if not exists agent_type text not null default 'hermes';
alter table public.hivra_agents     add column if not exists pool_id uuid references public.pools(id) on delete restrict;

-- 3) backfill pools from existing subscriptions (pool budget == the user's existing budget).
insert into public.pools (user_id, product_surface, subscription_id, cpu_budget, ram_budget_mb, agent_slots, status)
select s.user_id, 'hermesos', s.id, s.total_cpu_budget, s.total_ram_budget, s.instance_limit, coalesce(s.status, 'active')
from public.hermes_subscriptions s
on conflict (user_id, product_surface) do nothing;

insert into public.pools (user_id, product_surface, cpu_budget, ram_budget_mb, agent_slots, status)
select w.user_id, 'workspace_cloud', w.total_cpu_budget, w.total_ram_budget, w.instance_limit, coalesce(w.status, 'active')
from public.workspace_cloud_subscriptions w
on conflict (user_id, product_surface) do nothing;

-- 3b) any user with live agents but no subscription-derived pool → minimal free pool,
--     so pool_id is never orphaned (e.g. free tier with no subscription row).
insert into public.pools (user_id, product_surface, cpu_budget, ram_budget_mb, agent_slots, status)
select distinct i.user_id, coalesce(i.product_surface, 'hermesos'), 0.5, 1024, 1, 'active'
from public.hermes_instances i
where i.status <> 'deleted'
on conflict (user_id, product_surface) do nothing;

insert into public.pools (user_id, product_surface, cpu_budget, ram_budget_mb, agent_slots, status)
select distinct a.user_id, 'hermesos', 0.5, 1024, 1, 'active'
from public.hivra_agents a
where a.status <> 'deleted'
on conflict (user_id, product_surface) do nothing;

-- 4) link agents to their pool (idempotent — only fills nulls).
update public.hermes_instances i set pool_id = p.id
from public.pools p
where p.user_id = i.user_id and p.product_surface = coalesce(i.product_surface, 'hermesos') and i.pool_id is null;

update public.hivra_agents a set pool_id = p.id
from public.pools p
where p.user_id = a.user_id and p.product_surface = 'hermesos' and a.pool_id is null;
