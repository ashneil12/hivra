-- Token-holding refresh cursor: every account with token standing is re-read
-- over time, a bounded page per cron run.
--
-- refresh-token-holdings and refresh-token-tiers used to read the 100 OLDEST
-- verified primary wallets (order by verified_at asc limit 100) on every run,
-- with no cursor. Once more than 100 primaries existed, account 101 onwards
-- was never re-read: a holder who sold kept their Pro/Power tier, and a new
-- holder was never auto-qualified. Accounts whose qualification had no primary
-- wallet at all (or only a Bankr deposit wallet) were never read either.
--
-- claim_token_holding_refresh_batch(lane, limit) returns the next page of
-- candidate accounts in user_id order after the lane's saved position,
-- wrapping to the start, and advances the position in the same transaction.
-- The row lock on the lane serialises overlapping runs of one cron. The two
-- crons keep separate lanes: refresh-token-tiers only refreshes snapshots,
-- so sharing one position would let it consume accounts that
-- refresh-token-holdings (the eligibility evaluator) then skips.
--
-- Candidates are every account whose token standing the crons must judge:
--   - a verified primary EVM wallet (the verification wallet, if eligible);
--   - a verified grandfathered Bankr hermesos_lock wallet (may be non-primary);
--   - a Pro/Power qualification that is eligible or inside its breach grace;
--   - an eligible Venice compute boost.
-- The application decides per account whether a verification wallet backs
-- that standing (getTokenVerificationWallet); an account with standing but no
-- wallet is judged at a zero balance.
--
-- Service-role only: RLS on with no policies, and no API-role grants.

create table if not exists public.token_holding_refresh_cursors (
  lane text primary key check (lane in ('token_holdings', 'token_tiers')),
  -- The last user_id handed out on this lane; the next page starts after it.
  after_user_id text,
  updated_at timestamptz not null default now()
);

alter table public.token_holding_refresh_cursors enable row level security;
revoke all on table public.token_holding_refresh_cursors from public, anon, authenticated;

create or replace function public.claim_token_holding_refresh_batch(
  p_lane text,
  p_limit integer
)
returns table (user_id text)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 100));
  v_after text;
  v_page text[];
begin
  insert into public.token_holding_refresh_cursors as cursor_row (lane)
  values (p_lane)
  on conflict (lane) do nothing;

  select cursor_row.after_user_id
    into v_after
  from public.token_holding_refresh_cursors as cursor_row
  where cursor_row.lane = p_lane
  for update;

  select coalesce(array_agg(page.candidate order by page.wrapped, page.candidate), array[]::text[])
    into v_page
  from (
    select pool.candidate,
           (v_after is not null and pool.candidate <= v_after) as wrapped
    from (
      select wallet.user_id as candidate
      from public.user_wallets as wallet
      where wallet.chain_type = 'evm'
        and wallet.is_primary
        and wallet.verified_at is not null
      union
      select wallet.user_id
      from public.user_wallets as wallet
      where wallet.chain_type = 'evm'
        and wallet.verification_method = 'bankr'
        and wallet.verified_at is not null
        and (wallet.metadata -> 'bankr' ->> 'purpose') = 'hermesos_lock'
      union
      select qualification.user_id
      from public.token_tier_qualifications as qualification
      where qualification.currently_eligible
         or (qualification.last_breach_at is not null and qualification.last_suspend_at is null)
      union
      select boost.user_id
      from public.venice_compute_boost_qualifications as boost
      where boost.currently_eligible
    ) as pool
    order by 2, 1
    limit v_limit
  ) as page;

  if cardinality(v_page) > 0 then
    update public.token_holding_refresh_cursors as cursor_row
    set after_user_id = v_page[cardinality(v_page)],
        updated_at = now()
    where cursor_row.lane = p_lane;
  end if;

  return query select unnest(v_page);
end;
$$;

revoke all on function public.claim_token_holding_refresh_batch(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_token_holding_refresh_batch(text, integer) to service_role;
