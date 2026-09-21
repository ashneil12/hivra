-- Durable archive records for dormant VM reclaim.
--
-- This is intentionally separate from instance_deletion_archives:
-- dormancy is reversible and may last indefinitely, while deletion archives
-- are short-lived audit snapshots for rows that are actually being purged.
--
-- The reclaim cron must insert one of these rows only after the Proxmox
-- vzdump backup succeeds, and must not destroy the VM unless this record is
-- written successfully.

create table if not exists public.instance_dormancy_archives (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null,
  user_id text not null,
  archive_kind text not null
    check (archive_kind in ('proxmox_vzdump')),
  archive_path text not null,
  archive_size_bytes bigint,
  source_proxmox_node text,
  source_proxmox_vmid integer,
  source_host_id text,
  metadata jsonb not null default '{}'::jsonb,
  restored_at timestamptz,
  restore_instance_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists instance_dormancy_archives_instance_id_idx
  on public.instance_dormancy_archives (instance_id, created_at desc);

create index if not exists instance_dormancy_archives_user_id_idx
  on public.instance_dormancy_archives (user_id, created_at desc);

create index if not exists instance_dormancy_archives_source_vmid_idx
  on public.instance_dormancy_archives (source_proxmox_node, source_proxmox_vmid)
  where source_proxmox_node is not null and source_proxmox_vmid is not null;

alter table public.instance_dormancy_archives enable row level security;

comment on table public.instance_dormancy_archives is
  'Long-lived backup manifest for inactive instances that were archived and '
  'released from Proxmox capacity. Rows are written only after a Proxmox '
  'backup succeeds, before the VM is destroyed.';

comment on column public.hermes_instances.last_activity_at is
  'Timestamp of the last deliberate user action that touched this instance '
  '(chat send, responses send, terminal start/input, lifecycle action, or '
  'settings update). Passive detail-page reads do not update this field.';
