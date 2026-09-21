-- Hermes Workspace Cloud lane.
--
-- A separate product surface ("workspace_cloud") that provisions cloud Hermes
-- instances for the standalone Hermes Workspace app, isolated from the HermesOS
-- product. Workspace users authenticate against Hermesdeploy (same Clerk auth),
-- but their instances are tagged and can be routed to a dedicated lane,
-- and billed against separate Stripe plans. This migration adds:
--
--   1. product_surface on hermes_instances — the lane tag. Default 'hermesos'
--      so every existing row keeps its current behaviour untouched.
--   2. workspace_cloud_handoff_codes — a one-time authorization-code ledger for
--      the PKCE handoff that lets the Workspace desktop/web client receive a
--      connection bundle (gateway URL + decrypted api_server_key) without ever
--      putting a long-lived secret on a browser redirect.

-- 1. Lane tag on instances.
alter table public.hermes_instances
  add column if not exists product_surface text not null default 'hermesos'
    check (product_surface in ('hermesos', 'workspace_cloud'));

comment on column public.hermes_instances.product_surface is
  'Product lane this instance belongs to. ''hermesos'' = the main Hermesdeploy '
  'product (default). ''workspace_cloud'' = the standalone Hermes Workspace '
  'cloud lane (routed by deployment configuration, billed separately, surfaced only through '
  '/workspace-cloud and /api/workspace-cloud routes).';

create index if not exists hermes_instances_product_surface_idx
  on public.hermes_instances(product_surface)
  where product_surface <> 'hermesos';

-- 2. One-time handoff code ledger.
--
-- Workspace generates a PKCE verifier/challenge locally; Hermesdeploy stores
-- only the sha256 of the issued code plus the challenge, bound to the owning
-- user and instance. Exchange requires the matching verifier, is single-use
-- (consumed_at), and short-lived (expires_at). Service role only — RLS on,
-- no policies.
create table if not exists public.workspace_cloud_handoff_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  user_id text not null,
  instance_id uuid not null references public.hermes_instances(id) on delete cascade,
  challenge text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists workspace_cloud_handoff_codes_code_hash_idx
  on public.workspace_cloud_handoff_codes(code_hash);

create index if not exists workspace_cloud_handoff_codes_expires_at_idx
  on public.workspace_cloud_handoff_codes(expires_at);

alter table public.workspace_cloud_handoff_codes enable row level security;

comment on table public.workspace_cloud_handoff_codes is
  'One-time PKCE authorization codes for the Hermes Workspace cloud handoff. '
  'Service role only. Exchanged at /api/workspace-cloud/handoff/exchange for a '
  'connection bundle; rows are single-use (consumed_at) and short-lived '
  '(expires_at).';

comment on column public.workspace_cloud_handoff_codes.code_hash is
  'sha256 hex of the issued one-time code. The plaintext code is only ever '
  'sent to the Workspace callback; we never store it.';

comment on column public.workspace_cloud_handoff_codes.challenge is
  'PKCE code_challenge (sha256(verifier), base64url). Exchange must present a '
  'verifier whose hash matches this.';

-- 2b. Separate billing surface for the lane.
--
-- Kept in its own table (not a surface column on hermes_subscriptions) so the
-- HermesOS entitlement path — which does `.eq(user_id).maybeSingle()` — stays
-- single-row-per-user and untouched. The Workspace Cloud entitlement resolver
-- reads only this table. A future Stripe webhook for the lane's products
-- writes rows here. Service role only — RLS on, no policies.
create table if not exists public.workspace_cloud_subscriptions (
  user_id text primary key,
  plan text not null default 'ws_cloud_pro',
  status text not null default 'active'
    check (status in ('active', 'past_due', 'trialing', 'canceled')),
  instance_limit integer not null default 1,
  total_cpu_budget numeric not null default 2,
  total_ram_budget integer not null default 4096,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace trigger workspace_cloud_subscriptions_updated_at
  before update on public.workspace_cloud_subscriptions
  for each row execute function update_updated_at();

alter table public.workspace_cloud_subscriptions enable row level security;

comment on table public.workspace_cloud_subscriptions is
  'Per-user billing entitlement for the Hermes Workspace cloud lane. Separate '
  'from hermes_subscriptions to keep the two products'' billing fully '
  'partitioned. Read by resolveWorkspaceCloudEntitlement; written by the '
  'lane Stripe webhook. Service role only.';

-- Dedicated lane hosts are deployment-owned inventory and are enrolled after
-- capability detection. Fresh source installs intentionally seed none.
