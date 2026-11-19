-- A host credential, so a host's wake proxy can call Hivra. Dark until
-- HIVRA_INGRESS_HOST_CREDENTIAL is on.
--
-- WHY
-- When the wake proxy on a host resumes a napping computer itself, Hivra hears
-- of it only at the next sweep, and a channel armed for the nap (a Telegram
-- webhook) stays up meanwhile. With a host credential the proxy reports the
-- wake at once (wake-report), and can ask Hivra to wake a computer it cannot
-- resume itself, such as a hibernated one (wake-request).
--
-- The credential is HMAC(HIVRA_INGRESS_SECRET, host id and generation). Hivra
-- stores no credential, only the generation it currently honours. Moving the
-- generation on revokes the host's credential at once.
--
-- 1. proxmox_hosts.ingress_credential_generation: 0 means no credential was
--    ever issued, so the host can call nothing.
-- 2. hivra_ingress_host_nonces: each signed request's nonce, kept until its
--    timestamp can no longer be accepted, so a captured request cannot be
--    replayed. Service role only.
--
-- Additive and idempotent.

set local lock_timeout = '2s';

-- 1. proxmox_hosts.ingress_credential_generation -------------------------------

alter table public.proxmox_hosts
  add column if not exists ingress_credential_generation bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.proxmox_hosts'::regclass
       and conname = 'proxmox_hosts_ingress_credential_generation_check'
  ) then
    alter table public.proxmox_hosts
      add constraint proxmox_hosts_ingress_credential_generation_check
      check (ingress_credential_generation >= 0) not valid;
  end if;
end
$$;

alter table public.proxmox_hosts validate constraint proxmox_hosts_ingress_credential_generation_check;

comment on column public.proxmox_hosts.ingress_credential_generation is
  'The host credential generation Hivra accepts from this host''s wake proxy. 0: none issued. Moving it on revokes the credential the host holds.';

-- 2. hivra_ingress_host_nonces -------------------------------------------------

create table if not exists public.hivra_ingress_host_nonces (
  host_id     text not null references public.proxmox_hosts(id) on update cascade on delete cascade,
  nonce       text not null check (nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  primary key (host_id, nonce)
);

create index if not exists hivra_ingress_host_nonces_expires_idx
  on public.hivra_ingress_host_nonces using btree (host_id, expires_at);

alter table public.hivra_ingress_host_nonces enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_ingress_host_nonces from public, anon, authenticated;
grant select, insert, delete on public.hivra_ingress_host_nonces to service_role;

comment on table public.hivra_ingress_host_nonces is
  'Nonces of signed host requests (wake-report, wake-request), kept until they expire, so none can be replayed. Service role only.';
