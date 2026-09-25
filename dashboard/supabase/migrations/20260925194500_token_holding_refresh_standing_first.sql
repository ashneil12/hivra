-- Token-holding refresh: accounts with token standing are re-read first, on
-- every run, and an account only moves back once it has been judged.
--
-- 20260925181500 paged both holdings crons through ONE candidate pool in
-- user_id order: every verified primary wallet plus every account with
-- standing, 100 accounts per run per lane (about 400 a day). Anyone can grow
-- that pool with sign-ups that each verify one fresh wallet, so an account
-- with a Pro/Power qualification waited pool/400 days to be re-read while it
-- kept its fleet entitlement: with 4,000 such sign-ups, 41 runs (about 10
-- days). The cursor also moved past a page when the page was handed out, so an
-- account whose read failed, or a page whose evaluation threw, waited a whole
-- cycle rather than one run.
--
-- Now:
--   - token_holding_refresh_candidates() lists every account the crons read,
--     and whether it has standing: a Pro/Power qualification that is eligible
--     or inside its breach grace, an eligible Venice compute boost, or a
--     grandfathered Bankr hermesos_lock wallet whose latest $HermesOS read is
--     positive (getTokenVerificationWallet reads that wallet). The others are
--     verified primary wallets (and lock wallets) read only to auto-qualify a
--     new holder; a holder can also qualify through /wallet/unlock.
--   - claim_token_holding_refresh_page(lane, standing, limit) hands out one
--     page of one class, least recently judged first (never judged first).
--     Every run claims standing pages until none is left, then plain pages
--     with the capacity that remains, so no number of accounts without
--     standing can delay an account with standing. A claim is a ten-minute
--     lease: later pages of the same run, and an overlapping run, skip it.
--   - record_token_holding_refresh_judgments(lane, user_ids) marks the claimed
--     accounts a run actually judged. An account whose read failed, or whose
--     evaluation never ran, keeps its old judged_at, so the next run claims it
--     ahead of every account judged since.
--   - close_token_holding_refresh_run(lane) ends a run. When every account with
--     standing has been judged since the lane's current cycle began, the cycle
--     is complete and the next one starts. It returns how long the cycle has
--     run, so the app raises an ops event when accounts with standing go longer
--     than the breach grace without a complete re-read.
--
-- claim_token_holding_refresh_batch (20260925181500) is left in place so the
-- code deployed before this release keeps working until it is replaced; the
-- app no longer calls it.
--
-- The $HermesOS address and Base chain id below are the platform token
-- registry's (token-registry.ts); a jest test fails if they drift.
--
-- Service-role only: RLS on with no policies, and no API-role grants.

create table if not exists public.token_holding_refresh_accounts (
  lane text not null check (lane in ('token_holdings', 'token_tiers')),
  user_id text not null,
  -- The last time a run claimed this account on this lane (a lease).
  claimed_at timestamptz not null,
  -- The last time a run judged it: read its holdings and evaluated its standing.
  judged_at timestamptz,
  primary key (lane, user_id)
);

alter table public.token_holding_refresh_accounts enable row level security;
revoke all on table public.token_holding_refresh_accounts from public, anon, authenticated;
-- The functions run as their caller, so grant service_role what they need here
-- instead of relying on the project's default privileges.
grant select, insert, update on table public.token_holding_refresh_accounts to service_role;

-- When the lane's current cycle over accounts with standing began. Set on the
-- lane's first claim; moved to now() each time a cycle completes.
alter table public.token_holding_refresh_cursors
  add column if not exists standing_cycle_started_at timestamptz;

create or replace function public.token_holding_refresh_candidates()
returns table (user_id text, has_standing boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select pool.candidate, bool_or(pool.standing)
  from (
    select qualification.user_id as candidate, true as standing
    from public.token_tier_qualifications as qualification
    where qualification.currently_eligible
       or (qualification.last_breach_at is not null and qualification.last_suspend_at is null)
    union all
    select boost.user_id, true
    from public.venice_compute_boost_qualifications as boost
    where boost.currently_eligible
    union all
    select lock_wallet.user_id,
           (
             select latest.balance_raw > 0
             from public.token_holding_snapshots as latest
             where latest.user_id = lock_wallet.user_id
               and latest.chain_id = 8453
               and latest.token_address = '0x95ccfd2b81a9667b0cc979992632f98fc853eba3'
               and latest.normalized_wallet_address = lock_wallet.normalized_address
             order by latest.checked_at desc
             limit 1
           ) is true
    from public.user_wallets as lock_wallet
    where lock_wallet.chain_type = 'evm'
      and lock_wallet.verification_method = 'bankr'
      and lock_wallet.verified_at is not null
      and (lock_wallet.metadata -> 'bankr' ->> 'purpose') = 'hermesos_lock'
    union all
    select wallet.user_id, false
    from public.user_wallets as wallet
    where wallet.chain_type = 'evm'
      and wallet.is_primary
      and wallet.verified_at is not null
  ) as pool
  group by pool.candidate
$$;

create or replace function public.claim_token_holding_refresh_page(
  p_lane text,
  p_standing boolean,
  p_limit integer
)
returns table (user_id text)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_page text[];
begin
  if p_lane is null or p_lane not in ('token_holdings', 'token_tiers') then
    raise exception 'unknown token holding refresh lane: %', coalesce(p_lane, '<null>')
      using errcode = '22023';
  end if;
  if p_standing is null then
    raise exception 'p_standing must name the class to claim' using errcode = '22004';
  end if;

  insert into public.token_holding_refresh_cursors as lane_row (lane)
  values (p_lane)
  on conflict (lane) do nothing;

  -- The lane row lock serialises claims on one lane, so overlapping runs never
  -- claim the same account. The lane's first claim starts its first cycle.
  update public.token_holding_refresh_cursors as lane_row
  set standing_cycle_started_at = coalesce(lane_row.standing_cycle_started_at, now()),
      updated_at = now()
  where lane_row.lane = p_lane;

  select coalesce(
           array_agg(page.candidate order by page.judged_at asc nulls first, page.candidate),
           array[]::text[]
         )
    into v_page
  from (
    select candidate.user_id as candidate, account.judged_at
    from public.token_holding_refresh_candidates() as candidate
    left join public.token_holding_refresh_accounts as account
      on account.lane = p_lane
     and account.user_id = candidate.user_id
    where candidate.has_standing = p_standing
      and (account.claimed_at is null or account.claimed_at < now() - interval '10 minutes')
    order by account.judged_at asc nulls first, candidate.user_id
    limit v_limit
  ) as page;

  insert into public.token_holding_refresh_accounts as account (lane, user_id, claimed_at)
  select p_lane, claimed.candidate, now()
  from unnest(v_page) as claimed(candidate)
  on conflict (lane, user_id) do update
    set claimed_at = excluded.claimed_at;

  return query
  select claimed.candidate
  from unnest(v_page) with ordinality as claimed(candidate, position)
  order by claimed.position;
end;
$$;

create or replace function public.record_token_holding_refresh_judgments(
  p_lane text,
  p_user_ids text[]
)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_recorded integer;
begin
  if p_lane is null or p_lane not in ('token_holdings', 'token_tiers') then
    raise exception 'unknown token holding refresh lane: %', coalesce(p_lane, '<null>')
      using errcode = '22023';
  end if;

  -- Only an account a run claimed has a row, so nothing unclaimed is marked.
  update public.token_holding_refresh_accounts as account
  set judged_at = now()
  where account.lane = p_lane
    and account.user_id = any (coalesce(p_user_ids, array[]::text[]));
  get diagnostics v_recorded = row_count;
  return v_recorded;
end;
$$;

create or replace function public.close_token_holding_refresh_run(p_lane text)
returns table (
  standing integer,
  unjudged integer,
  cycle_started_at timestamptz,
  cycle_seconds bigint,
  cycle_completed boolean
)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_started timestamptz;
  v_standing integer;
  v_unjudged integer;
begin
  if p_lane is null or p_lane not in ('token_holdings', 'token_tiers') then
    raise exception 'unknown token holding refresh lane: %', coalesce(p_lane, '<null>')
      using errcode = '22023';
  end if;

  insert into public.token_holding_refresh_cursors as lane_row (lane)
  values (p_lane)
  on conflict (lane) do nothing;

  select lane_row.standing_cycle_started_at
    into v_started
  from public.token_holding_refresh_cursors as lane_row
  where lane_row.lane = p_lane
  for update;
  v_started := coalesce(v_started, now());

  -- Accounts with standing now, and those not judged since the cycle began.
  select count(*)::integer,
         (count(*) filter (where account.judged_at is null or account.judged_at < v_started))::integer
    into v_standing, v_unjudged
  from public.token_holding_refresh_candidates() as candidate
  left join public.token_holding_refresh_accounts as account
    on account.lane = p_lane
   and account.user_id = candidate.user_id
  where candidate.has_standing;

  update public.token_holding_refresh_cursors as lane_row
  set standing_cycle_started_at = case when v_unjudged = 0 then now() else v_started end,
      updated_at = now()
  where lane_row.lane = p_lane;

  return query
  select v_standing,
         v_unjudged,
         v_started,
         floor(extract(epoch from (now() - v_started)))::bigint,
         v_unjudged = 0;
end;
$$;

revoke all on function public.token_holding_refresh_candidates()
  from public, anon, authenticated;
revoke all on function public.claim_token_holding_refresh_page(text, boolean, integer)
  from public, anon, authenticated;
revoke all on function public.record_token_holding_refresh_judgments(text, text[])
  from public, anon, authenticated;
revoke all on function public.close_token_holding_refresh_run(text)
  from public, anon, authenticated;
grant execute on function public.token_holding_refresh_candidates() to service_role;
grant execute on function public.claim_token_holding_refresh_page(text, boolean, integer) to service_role;
grant execute on function public.record_token_holding_refresh_judgments(text, text[]) to service_role;
grant execute on function public.close_token_holding_refresh_run(text) to service_role;
