-- Privacy controls for agent computers (both off by default behind flags):
--
-- 1. hivra_agent_allowed_sites: an owner's list of the internet sites one
--    agent's computer may reach. Enforced on the Proxmox host by
--    scripts/proxmox-host-vm-egress-allowlist.sh. No row, or enabled=false,
--    means the computer is not limited.
-- 2. hivra_computer_access_log: what connected into an agent's computer from
--    its Proxmox host (a command run through the guest agent, a console, an
--    SSH session or a file copy), by whom (Hivra's automatic systems or a
--    person at Hivra), counted per hour. Collected from the host's audit log
--    by scripts/proxmox-host-guest-access-audit.sh. Holds no command
--    arguments, file contents or output: only the channel and, for commands,
--    the program's name.
-- 3. hivra_access_log_cursors: how far each host's spool has been read.
--
-- Service role only: owners read through the dashboard API, scoped to their
-- own agents. Additive and idempotent.

create table if not exists public.hivra_agent_allowed_sites (
  agent_id      uuid primary key references public.hivra_agents(id) on delete cascade,
  user_id       text        not null,
  enabled       boolean     not null default false,
  sites         text[]      not null default '{}'::text[],
  apply_state   text        not null default 'pending'
                check (apply_state in ('pending', 'applied', 'saved', 'failed')),
  apply_error   text,
  applied_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint hivra_agent_allowed_sites_count check (cardinality(sites) <= 100)
);

create index if not exists hivra_agent_allowed_sites_user_idx
  on public.hivra_agent_allowed_sites (user_id);

alter table public.hivra_agent_allowed_sites enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_allowed_sites from anon, authenticated;

comment on table public.hivra_agent_allowed_sites is
  'Owner-set list of sites an agent computer may reach, enforced on its Proxmox host. apply_state: pending (not yet sent), applied (host enforces it), saved (host has the file but has no enforcer installed yet), failed.';

create table if not exists public.hivra_computer_access_log (
  id            bigint generated always as identity primary key,
  proxmox_host  text        not null,
  vmid          integer     not null check (vmid > 0),
  agent_id      uuid        references public.hivra_agents(id) on delete cascade,
  user_id       text,
  hour          timestamptz not null,
  actor_class   text        not null check (actor_class in ('system', 'staff')),
  actor_label   text        not null check (char_length(actor_label) between 1 and 80),
  channel       text        not null check (channel in ('command', 'files', 'console', 'screen', 'status', 'ssh')),
  programs      text[]      not null default '{}'::text[],
  count         integer     not null default 1 check (count > 0),
  first_at      timestamptz not null,
  last_at       timestamptz not null,
  constraint hivra_computer_access_log_bucket unique (proxmox_host, vmid, hour, actor_class, actor_label, channel)
);

create index if not exists hivra_computer_access_log_agent_idx
  on public.hivra_computer_access_log (agent_id, hour desc);
create index if not exists hivra_computer_access_log_hour_idx
  on public.hivra_computer_access_log (hour);

alter table public.hivra_computer_access_log enable row level security;
revoke all on public.hivra_computer_access_log from anon, authenticated;

comment on table public.hivra_computer_access_log is
  'Connections into an agent computer seen on its Proxmox host, counted per hour by who (system or staff) and channel. No arguments, contents or output.';

create table if not exists public.hivra_access_log_cursors (
  proxmox_host  text primary key,
  last_seq      bigint      not null default 0,
  first_collected_at timestamptz not null default now(),
  collected_at  timestamptz not null default now()
);

alter table public.hivra_access_log_cursors enable row level security;
revoke all on public.hivra_access_log_cursors from anon, authenticated;

-- Adds one batch of hourly buckets: counts add up, first/last widen, program
-- names merge (at most 12 kept per bucket).
create or replace function public.hivra_record_computer_access(entries jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  written integer := 0;
  e jsonb;
begin
  if jsonb_typeof(entries) <> 'array' then
    raise exception 'entries must be a JSON array';
  end if;
  for e in select * from jsonb_array_elements(entries) loop
    insert into public.hivra_computer_access_log as l
      (proxmox_host, vmid, agent_id, user_id, hour, actor_class, actor_label, channel, programs, count, first_at, last_at)
    values (
      e->>'proxmox_host',
      (e->>'vmid')::integer,
      nullif(e->>'agent_id', '')::uuid,
      nullif(e->>'user_id', ''),
      (e->>'hour')::timestamptz,
      e->>'actor_class',
      e->>'actor_label',
      e->>'channel',
      coalesce(array(select jsonb_array_elements_text(coalesce(e->'programs', '[]'::jsonb))), '{}'::text[]),
      greatest(1, (e->>'count')::integer),
      (e->>'first_at')::timestamptz,
      (e->>'last_at')::timestamptz
    )
    on conflict (proxmox_host, vmid, hour, actor_class, actor_label, channel) do update set
      count = l.count + excluded.count,
      first_at = least(l.first_at, excluded.first_at),
      last_at = greatest(l.last_at, excluded.last_at),
      agent_id = coalesce(l.agent_id, excluded.agent_id),
      user_id = coalesce(l.user_id, excluded.user_id),
      programs = (
        select coalesce(array_agg(p order by p), '{}'::text[])
        from (select distinct p from unnest(l.programs || excluded.programs) as p limit 12) merged
      );
    written := written + 1;
  end loop;
  return written;
end;
$$;

revoke all on function public.hivra_record_computer_access(jsonb) from public, anon, authenticated;
grant execute on function public.hivra_record_computer_access(jsonb) to service_role;
