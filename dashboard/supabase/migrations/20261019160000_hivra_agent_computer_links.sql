-- Agent ↔ computer links: any of an owner's agents may use any of the owner's
-- computers, many to many, set from either the agent's page or the computer's.
-- Design: docs/superpowers/specs/2026-10-19-agent-computer-links.md
--
-- 1. hivra_agent_computer_links: one row per (agent, computer) pair the owner
--    linked. Both ends are hivra_agents rows of the same owner; the routes
--    check that, and the check below stops a row linking an agent to itself.
--    Removing the row removes the access: the agent API reads it on every
--    request. `last_used_at` is the last command Hivra ran for the agent there.
--
-- 2. hivra_agent_link_keys: the agent's one credential for the agent API
--    (POST /api/agent-link), stored only as SHA-256. `key_sha256` is the key
--    the agent's computer last confirmed; `pending_key_sha256` is the one Hivra
--    is delivering now, accepted too, so a rotation never leaves a window in
--    which the agent's own key is refused. `kit_sha256` is the digest of the
--    non-secret files Hivra last delivered (the list of computers, the CLI and
--    its skill), so delivery runs again only when one of them changes.
--    `delivery_claimed_at` is the single-flight claim for one delivery.
--
-- 3. Both go when either end is deleted (status 'deleted', a soft delete, so
--    the foreign keys' cascade alone never fires). Account deletion removes
--    the rest by user_id (ACCOUNT_DELETION_TABLES).
--
-- Service role only: RLS on, no policies. Additive and rerun-safe.

create table if not exists public.hivra_agent_computer_links (
  id           uuid        primary key default gen_random_uuid(),
  user_id      text        not null check (btrim(user_id) <> ''),
  agent_id     uuid        not null references public.hivra_agents (id) on delete cascade,
  computer_id  uuid        not null references public.hivra_agents (id) on delete cascade,
  created_from text        not null check (created_from in ('agent', 'computer')),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  constraint hivra_agent_computer_links_distinct check (agent_id <> computer_id),
  constraint hivra_agent_computer_links_pair unique (agent_id, computer_id)
);

create index if not exists hivra_agent_computer_links_user_idx on public.hivra_agent_computer_links (user_id);
create index if not exists hivra_agent_computer_links_computer_idx on public.hivra_agent_computer_links (computer_id);

alter table public.hivra_agent_computer_links enable row level security;
revoke all on public.hivra_agent_computer_links from public, anon, authenticated;
grant all on public.hivra_agent_computer_links to service_role;

create table if not exists public.hivra_agent_link_keys (
  agent_id            uuid        primary key references public.hivra_agents (id) on delete cascade,
  user_id             text        not null check (btrim(user_id) <> ''),
  key_sha256          text        check (key_sha256 is null or key_sha256 ~ '^[0-9a-f]{64}$'),
  pending_key_sha256  text        check (pending_key_sha256 is null or pending_key_sha256 ~ '^[0-9a-f]{64}$'),
  kit_sha256          text        check (kit_sha256 is null or kit_sha256 ~ '^[0-9a-f]{64}$'),
  delivered_at        timestamptz,
  delivery_claimed_at timestamptz,
  last_error          text        check (last_error is null or char_length(last_error) <= 200),
  updated_at          timestamptz not null default now()
);

create unique index if not exists hivra_agent_link_keys_key_idx on public.hivra_agent_link_keys (key_sha256) where key_sha256 is not null;
create unique index if not exists hivra_agent_link_keys_pending_idx on public.hivra_agent_link_keys (pending_key_sha256) where pending_key_sha256 is not null;

alter table public.hivra_agent_link_keys enable row level security;
revoke all on public.hivra_agent_link_keys from public, anon, authenticated;
grant all on public.hivra_agent_link_keys to service_role;

create or replace function public.delete_hivra_agent_links_after_agent_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from 'deleted' and new.status = 'deleted' then
    delete from public.hivra_agent_computer_links l where l.agent_id = new.id or l.computer_id = new.id;
    delete from public.hivra_agent_link_keys k where k.agent_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists delete_hivra_agent_links_after_agent_delete on public.hivra_agents;
create trigger delete_hivra_agent_links_after_agent_delete
after update of status on public.hivra_agents
for each row execute function public.delete_hivra_agent_links_after_agent_delete();

revoke all on function public.delete_hivra_agent_links_after_agent_delete() from public, anon, authenticated;
