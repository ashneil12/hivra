-- hivra_agents — per-user AI-agent boxes for the Hivra pilot (Claude Code / Codex / Hermes).
--
-- Idempotent: `create table if not exists` is a guaranteed no-op against an
-- existing deployment and a fresh create for self-hosted installations.

create table if not exists public.hivra_agents (
  id             uuid primary key default gen_random_uuid(),
  user_id        text        not null,
  type           text        not null,
  name           text        not null,
  status         text        not null default 'provisioning',
  proxmox_host   text        not null default 'local',
  vmid           integer,
  ip             text,
  chat_url       text,
  cpu            integer     not null default 4,
  ram            integer     not null default 8,
  error          text,
  created_at     timestamptz not null default now(),
  provisioned_at timestamptz,
  api_token      text,
  cf_tunnel_id   text,
  cf_hostname    text
);

create index if not exists hivra_agents_user_idx
  on public.hivra_agents using btree (user_id, created_at desc);
