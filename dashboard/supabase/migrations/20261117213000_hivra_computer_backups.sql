-- Off-host backups of Hivra computers.
--
-- One row per job the backup cron starts on a Proxmox host: a backup (raw disk
-- copy of a short-lived snapshot, uploaded encrypted to cold storage), a drill
-- (reads a backup back and checks every byte), a restore, or the purge of a
-- deleted computer's repository. agent_id has no foreign key on purpose: the
-- rows outlive the computer so its repository can be found and removed.
--
-- Service role only. Owners read their own computer's latest backup through
-- an API route that checks ownership.

create table if not exists public.hivra_computer_backups (
  id uuid primary key,
  agent_id uuid not null,
  user_id text not null,
  kind text not null,
  status text not null default 'running',
  proxmox_host text not null,
  vmid integer null,
  reason text null,
  added_bytes bigint not null default 0,
  disks jsonb not null default '[]'::jsonb,
  source_backup_id uuid null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint hivra_computer_backups_kind_check
    check (kind in ('backup', 'drill', 'restore', 'purge')),
  constraint hivra_computer_backups_status_check
    check (status in ('running', 'succeeded', 'failed', 'skipped')),
  constraint hivra_computer_backups_reason_check
    check (reason is null or reason ~ '^[a-z_]{1,40}$'),
  constraint hivra_computer_backups_disks_check
    check (jsonb_typeof(disks) = 'array'),
  constraint hivra_computer_backups_added_check
    check (added_bytes >= 0)
);

create index if not exists hivra_computer_backups_agent_kind_idx
  on public.hivra_computer_backups (agent_id, kind, started_at desc);

create index if not exists hivra_computer_backups_running_idx
  on public.hivra_computer_backups (proxmox_host, started_at)
  where status = 'running';

alter table public.hivra_computer_backups enable row level security;

revoke all on public.hivra_computer_backups from anon, authenticated;
