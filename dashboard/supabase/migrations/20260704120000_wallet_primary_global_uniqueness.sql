-- Sybil guard: one account per verification wallet.
--
-- user_wallets uniqueness was per (user_id, chain_type, normalized_address),
-- so the SAME self-custody wallet could be signature-verified as primary by
-- multiple accounts, and each account independently qualified for token tiers
-- off the same on-chain balance. This migration:
--
--   1. Demotes existing cross-account duplicate primaries — the EARLIEST
--      verified claim keeps the wallet (metadata breadcrumb on the losers).
--   2. Revokes the demoted accounts' token-tier standing when no other
--      qualifying wallet remains (qualification rows are only re-evaluated
--      for users the holdings cron can sweep, and that sweep enumerates
--      primary wallets — left alone they would stay eligible forever), and
--      writes a zero-balance snapshot so refresh-token-tiers stops honouring
--      the duplicate wallet's old balance (normal 48h grace still applies).
--   3. Adds a partial unique index so a wallet can only ever be primary on
--      one account. The app-level takeover flow (verifyWalletChallenge)
--      relies on this as its race backstop.
--
-- Rerun-safe: after the first run there are no rn > 1 primaries, both
-- updates match nothing, and the index create is IF NOT EXISTS.

with ranked as (
  select
    id,
    user_id,
    normalized_address,
    row_number() over (
      partition by chain_type, normalized_address
      order by verified_at asc nulls last, created_at asc, id asc
    ) as rn
  from public.user_wallets
  where is_primary
),
losers as (
  select id, user_id, normalized_address
  from ranked
  where rn > 1
),
demoted as (
  update public.user_wallets w
  set is_primary = false,
      verified_at = null,
      metadata = w.metadata || jsonb_build_object(
        'wallet_takeover', jsonb_build_object(
          'reason', 'duplicate_primary_wallet_migration',
          'was_primary', true,
          'demoted_at', now()
        )
      )
  from losers l
  where w.id = l.id
  returning w.user_id
),
-- Demoted users with no OTHER qualifying wallet left (their own primary on a
-- different address, or a grandfathered Bankr hermesos_lock wallet). The
-- data-modifying CTE above is not visible here, so exclude the loser rows
-- explicitly when checking what remains.
displaced as (
  select distinct l.user_id, l.normalized_address
  from losers l
  where not exists (
    select 1
    from public.user_wallets w2
    where w2.user_id = l.user_id
      and w2.verified_at is not null
      and (
        w2.is_primary
        or (w2.metadata -> 'bankr' ->> 'purpose') = 'hermesos_lock'
      )
      and w2.id not in (select id from losers)
  )
),
breached as (
  update public.token_tier_qualifications q
  set currently_eligible = false,
      last_breach_at = now()
  from displaced d
  where q.user_id = d.user_id
    and q.currently_eligible
  returning q.user_id
),
boost_dropped as (
  update public.venice_compute_boost_qualifications b
  set currently_eligible = false,
      last_breach_at = null
  from displaced d
  where b.user_id = d.user_id
    and b.currently_eligible
  returning b.user_id
)
insert into public.token_holding_snapshots (
  user_id,
  wallet_id,
  wallet_address,
  normalized_wallet_address,
  chain_id,
  token_address,
  token_symbol,
  token_decimals,
  balance_raw,
  balance_display,
  qualifies_base_tier,
  source,
  metadata
)
select
  d.user_id,
  null,
  d.normalized_address,
  d.normalized_address,
  8453,
  '0x95ccfd2b81a9667b0cc979992632f98fc853eba3',
  'Hivra',
  18,
  0,
  '0',
  false,
  'admin',
  jsonb_build_object('reason', 'duplicate_primary_wallet_migration')
from displaced d;

-- Mirror the takeover flow for lingering NON-primary verified claims of an
-- address whose primary now lives on a different account (e.g. a user
-- verified wallet X, later verified wallet Y, and X was then verified by
-- someone else pre-fix). These rows don't drive tier eligibility (that
-- requires is_primary) but still read as "verified" to fallback lookups.
update public.user_wallets w
set verified_at = null,
    metadata = w.metadata || jsonb_build_object(
      'wallet_takeover', jsonb_build_object(
        'reason', 'duplicate_primary_wallet_migration',
        'was_primary', false,
        'demoted_at', now()
      )
    )
where w.verified_at is not null
  and not w.is_primary
  and exists (
    select 1
    from public.user_wallets p
    where p.is_primary
      and p.chain_type = w.chain_type
      and p.normalized_address = w.normalized_address
      and p.user_id <> w.user_id
  );

create unique index if not exists user_wallets_primary_address_uniq
  on public.user_wallets(chain_type, normalized_address)
  where is_primary;
