-- Ensure hermes_instances.product_surface exists before the platform-stats
-- rollup function references it. Canary already has this column (added with
-- the workspace_cloud lane); prod (Moltbotservers) predates it. Additive,
-- nullable, idempotent — no backfill needed (the rollup coalesces null to
-- 'unknown'). Dated just before the platform_stats migration so a fresh
-- apply (prod) creates the column first.

alter table public.hermes_instances
  add column if not exists product_surface text;

comment on column public.hermes_instances.product_surface is
  'Which product lane provisioned this agent (e.g. hermesos, workspace_cloud). Nullable; consumed by platform analytics rollups.';
