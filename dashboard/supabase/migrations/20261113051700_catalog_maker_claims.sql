-- Maker claims on catalog pages, and use per agent type.
--
-- WHY
-- A catalog page names the project that makes an agent. Someone from that
-- project can prove it by adding a file, holding a line Hivra gave them, to the
-- project's own repository. A proven claim marks the page as claimed and lets
-- that person read how much the agent is used on Hivra. Records and reading
-- only: nothing here pays, bills or changes what can be launched.
--
-- 1. hivra_catalog_claims: one row per person and page.
-- 2. hivra_catalog_use_by_type(from, to): per agent type, the people and hours
--    in use between two times, finished launches, agents running now, and how
--    many of the agents launched earlier were kept for two weeks.
--
-- Additive and idempotent. Service role only.

create table if not exists public.hivra_catalog_claims (
  id           uuid primary key default gen_random_uuid(),
  profile_id   text not null check (profile_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  user_id      text not null,
  repo         text not null check (repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  token        text not null check (token ~ '^[a-f0-9]{32}$'),
  status       text not null default 'pending' check (status in ('pending', 'verified')),
  check_result text check (check_result is null or check_result in ('verified', 'file_missing', 'line_missing', 'unreachable')),
  created_at   timestamptz not null default now(),
  checked_at   timestamptz,
  verified_at  timestamptz,
  constraint hivra_catalog_claims_person_page_key unique (profile_id, user_id),
  constraint hivra_catalog_claims_token_key unique (token),
  constraint hivra_catalog_claims_verified_has_time check (status <> 'verified' or verified_at is not null)
);

create index if not exists hivra_catalog_claims_verified_idx
  on public.hivra_catalog_claims (profile_id)
  where status = 'verified';

alter table public.hivra_catalog_claims enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_catalog_claims from anon, authenticated;

comment on table public.hivra_catalog_claims is
  'A person''s claim to be the maker behind a catalog page. token is the value of the hivra-claim line they add to a file in repo; it is published there, so it is not a secret. status becomes verified once Hivra has read that line from the repository. Deleting a row takes the claim away.';

create or replace function public.hivra_catalog_use_by_type(p_from timestamptz, p_to timestamptz)
returns table (
  agent_type        text,
  people            integer,
  active_hours      integer,
  launches          integer,
  running_now       integer,
  two_week_launches integer,
  two_week_kept     integer
)
language sql
stable
set search_path = public
as $$
  with used as (
    select u.agent_type,
           count(distinct u.user_id)::integer as people,
           coalesce(sum(u.active_hours), 0)::integer as active_hours
      from public.hivra_usage_by_user_and_type(p_from, p_to) u
     where u.active_hours > 0
     group by 1
  ),
  launched as (
    select e.agent_type, count(*)::integer as launches
      from public.hivra_agent_events e
     where e.event = 'provisioned'
       and e.agent_type is not null
       and e.created_at >= p_from
       and e.created_at < p_to
     group by 1
  ),
  running as (
    select a.type as agent_type, count(*)::integer as running_now
      from public.hivra_agents a
     where a.status = 'running'
     group by 1
  ),
  earlier as (
    -- Agents that finished launching in the 30 days that ended two weeks before p_to,
    -- so each has had its two weeks.
    select e.agent_id, max(e.agent_type) as agent_type, min(e.created_at) as launched_at
      from public.hivra_agent_events e
     where e.event = 'provisioned'
       and e.agent_id is not null
       and e.agent_type is not null
       and e.created_at >= p_to - interval '44 days'
       and e.created_at < p_to - interval '14 days'
     group by 1
  ),
  kept as (
    select x.agent_type,
           count(*)::integer as two_week_launches,
           (count(*) filter (where not exists (
              select 1
                from public.hivra_agent_events d
               where d.agent_id = x.agent_id
                 and d.event = 'deleted'
                 and d.created_at < x.launched_at + interval '14 days'
           )))::integer as two_week_kept
      from earlier x
     group by 1
  ),
  types as (
    select u.agent_type from used u
    union select l.agent_type from launched l
    union select r.agent_type from running r
    union select k.agent_type from kept k
  )
  select t.agent_type,
         coalesce(u.people, 0),
         coalesce(u.active_hours, 0),
         coalesce(l.launches, 0),
         coalesce(r.running_now, 0),
         coalesce(k.two_week_launches, 0),
         coalesce(k.two_week_kept, 0)
    from types t
    left join used u on u.agent_type = t.agent_type
    left join launched l on l.agent_type = t.agent_type
    left join running r on r.agent_type = t.agent_type
    left join kept k on k.agent_type = t.agent_type
   order by t.agent_type;
$$;

revoke all on function public.hivra_catalog_use_by_type(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.hivra_catalog_use_by_type(timestamptz, timestamptz) to service_role;

comment on function public.hivra_catalog_use_by_type(timestamptz, timestamptz) is
  'Use per agent type between two times: people and hours in use (from hivra_usage_by_user_and_type), finished launches, agents running now, and of the agents that finished launching in the 30 days ending two weeks before p_to, how many were not deleted within their first two weeks. Read-only; feeds the catalog order and a maker''s numbers.';
