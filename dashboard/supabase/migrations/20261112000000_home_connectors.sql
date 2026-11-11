-- A machine at home, with no ports opened (WP-220 section 3).
--
-- One row per machine that runs hivra-connector. The row id is the relay's
-- connection id. Hivra never stores the connector secret (it is derived from
-- HOST_RELAY_SECRET, the id and the generation) or the enrolment token (only
-- its purpose-bound sha256). Additive and rerun-safe; nothing reads this table
-- unless HIVRA_HOME_CONNECTOR_ENABLED is on.
--
-- Rows are written only by the dashboard's service role. RLS is on with no
-- policy, so no other role can read or write them.

create table if not exists public.infrastructure_home_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  -- Raised on revoke; the relay refuses connectors below it.
  generation integer not null default 1 check (generation >= 1),
  enrolment_token_hash text not null,
  enrolment_expires_at timestamptz not null,
  enrolment_consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists infrastructure_home_connectors_token_hash_key
  on public.infrastructure_home_connectors (enrolment_token_hash);
create index if not exists infrastructure_home_connectors_user_idx
  on public.infrastructure_home_connectors (user_id);

alter table public.infrastructure_home_connectors enable row level security;

comment on table public.infrastructure_home_connectors is
  'Machines that reach Hivra through the outbound connector and relay. id is the relay connection id. No secret is stored: the connector secret derives from the relay secret, id and generation.';
