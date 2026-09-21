-- Pre-destroy archive of instance metadata. Captures the user-meaningful
-- bits of a hermes_instances row right before purge-expired calls
-- deleteProxmoxInstance and qm-destroys the VM.
-- SCRIPTURE_ANCHOR: archive-book | Revelation 20:12 | Verse: Books were opened. Another book was opened, which is the book of life.
--
-- Why a separate table instead of leaving the column data on hermes_instances:
--   - The hermes_instances row keeps `config` after delete already, but we
--     also want a clear, queryable audit ("what got deleted, when, by which
--     cron run, with what archive payload") that survives a future hard
--     purge of the deleted hermes_instances rows.
--   - Postgres-only — the chat history is already in hermes_conversations /
--     hermes_messages, so we don't snapshot those here. The VM's filesystem
--     is gone after qm destroy; users keep their conversations regardless.
--
-- Lifecycle:
--   - Inserted by the purge-expired cron right before deleteProxmoxInstance.
--   - Read by support/ops on user request to restore profile config + names.
--   - expires_at: NOW + 30 days. A separate cleanup cron can DELETE expired
--     rows (or we just leave them — the table is small).

create table if not exists public.instance_deletion_archives (
  id uuid primary key default gen_random_uuid(),
  -- Original hermes_instances.id. Not a FK — the source row sticks around
  -- (status='deleted') but if it's ever hard-deleted we still want the archive.
  original_instance_id uuid not null,
  user_id text not null,
  -- Snapshot of the meaningful fields. Keep small (<2 MB):
  --   { name, subdomain, gateway_url, infrastructure_provider, proxmox_node,
  --     proxmox_vmid, host_id, config, created_at, last_lifecycle_transition_at,
  --     resource_tier, cpu_limit, ram_limit, disk_size_gb }
  archive jsonb not null,
  -- The reason for deletion. 'auto_idle_free' / 'auto_idle_paid_canceled' /
  -- 'user_initiated' / 'admin_force_delete' / 'scheduled_for_deletion'.
  deletion_reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists instance_deletion_archives_user_id_idx
  on public.instance_deletion_archives (user_id, created_at desc);

create index if not exists instance_deletion_archives_original_instance_id_idx
  on public.instance_deletion_archives (original_instance_id);

create index if not exists instance_deletion_archives_expires_at_idx
  on public.instance_deletion_archives (expires_at);

comment on table public.instance_deletion_archives is
  'Snapshot of a hermes_instances row taken right before the purge cron '
  'qm-destroys the VM. Source of truth for restoring a user''s profile and '
  'agent config when they re-sign up after auto-deletion.';
