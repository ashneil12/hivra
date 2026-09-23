# $HIVRA activation runbook

$HIVRA support is built and **dormant**. Activating it is one reviewed PR that
fills in one file. This runbook covers what to paste, what must already be
true, what runs after the merge, and how to verify it.

Source of the design: the dual-token PRs (registry and schema, access and
grandfathering, payments, price feed, UI and emails) into `canary`.

## 1. Preconditions (check every one before opening the PR)

1. **Code:** all five dual-token PRs are merged and serving on the target.
   - Canary: the Canary domain serves a Git deployment that contains them.
   - Production: they are in `main` and Ash has **Promoted** a deployment that
     contains them. Never paste the address into a tree that lacks the payment
     PR: without it, $HermesOS payments are not refused for new users.
2. **Database:** these migrations are applied on the target database, in order:
   - `20260923150000_dual_platform_token_foundation.sql`
   - `20260923203000_reconcile_token_base_any_allowed_token.sql`
   - `20260923204000_managed_venice_token_lots_unique_quote_any_token.sql`

   The code reads their columns and functions even while $HIVRA is dormant.
   For production they go in the Promote packet (hivra-supabase-ops), applied
   before the Promote. Verify by objects, not only the ledger:
   ```sql
   select to_regclass('public.platform_token_activations') is not null as activations,
          to_regclass('public.token_grandfather_cohort') is not null as cohort,
          exists (select 1 from pg_proc where proname = 'settle_yearly_platform_token_payment') as settle_fn,
          exists (select 1 from pg_indexes where indexname = 'uq_managed_venice_token_lots_token_deposit_quote') as lot_index;
   ```
   All four must be `true`.
3. **Market:** the $HIVRA pool must pass the price gates from day one, or
   every $HIVRA quote fails closed (see section 5):
   - DEXScreener lists the canonical pool with at least
     `HIVRA_MIN_PRICE_LIQUIDITY_USD` of liquidity (default $25,000; see
     `dashboard/src/lib/billing/token-registry.ts`).
   - GeckoTerminal has at least 3 five-minute candles for the pool in the
     last 24 hours.
4. **Token surfaces are switched on.** The wallet, token-holding, token-access
   and token quote routes answer 404 unless crypto billing is enabled on the
   target (`CRYPTO_BILLING_ENABLED=true` or
   `NEXT_PUBLIC_CRYPTO_BILLING_ENABLED=true`, plus billing v2). On 2026-09-23
   it was off on Canary. Turning it on is an environment change for Ash, not
   part of the activation PR. Tier crons, settlement and sweeps run either way.
5. **Decision:** agree the activation instant. Every account with $HermesOS
   history before that instant is grandfathered (section 4).

## 2. The one file to edit

`dashboard/src/lib/billing/hivra-token-launch.ts`:

```ts
export const HIVRA_TOKEN_LAUNCH: HivraTokenLaunchConfig = {
  contractAddress: "0x…",                 // $HIVRA on Base, EIP-55 checksummed as BaseScan shows it
  decimals: 18,                           // read on-chain, see below
  poolId: "0x…",                          // canonical Uniswap v4 pool id (64 hex) or pair address (40 hex)
  activatesAt: "2026-10-01T16:00:00Z",    // UTC, to the second
};
```

Nothing else changes. No environment variable, no migration, no other file.
Everything else (balances, tiers, quotes, settlement, sweeps, the price feed,
the /token page, emails and wallet links) reads this block through
`token-registry.ts`.

How to get each value:

| Field | Source | Check |
|---|---|---|
| `contractAddress` | the Bankr launch | Open `https://basescan.org/token/<address>`: name, symbol and total supply match the launch. Paste the checksummed form. |
| `decimals` | on-chain `decimals()` | `curl -s https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<address>","data":"0x313ce567"},"latest"]}'`. `0x…12` = 18. |
| `poolId` | DEXScreener `https://api.dexscreener.com/latest/dex/tokens/<address>` | Use the `pairAddress` of the $HIVRA/WETH Uniswap v4 pool with the most liquidity. The price feed accepts only this pool. |
| `activatesAt` | Ash's decision | A future instant schedules activation ("launching soon" on /token). A past instant activates at deploy. |

The build fails on a bad paste: `token-registry.test.ts` rejects a partial or
malformed block (bad address, the $HermesOS address, bad pool id, impossible
date, non-UTC time, bad decimals), and `hivra-token-launch.checksum.test.ts`
rejects a mixed-case address whose EIP-55 checksum is wrong. At runtime a
malformed block keeps $HIVRA dormant.

## 3. After the merge

**Canary:** merge the PR into `canary`. The Vercel Git build deploys it, and
nothing else is needed.

**Production:** this PR goes to `main` and goes live only through Ash's Promote.
The preconditions in section 1 apply to the production database.

Nothing has to be run by hand. At the first request or cron tick after
`activatesAt`, the platform calls `record_platform_token_activation` once. That
call:

- records the activation (address and instant) in `platform_token_activations`;
- records the grandfather cohort in `token_grandfather_cohort` from
  pre-activation evidence (section 4);
- creates the $HIVRA `token_base` row in `token_entitlement_configs`.

It is idempotent, and it refuses a different address or instant later
(`address_conflict`, `activation_instant_conflict`). A conflict raises a fatal
ops event, and $HIVRA money paths stop until an operator reconciles it.

To record it immediately instead of waiting for the next tick, trigger the
tier cron once (`/api/cron/refresh-token-tiers` with the cron secret).

## 4. The rules that switch on

**Grandfather cohort.** Every user with, strictly before `activatesAt`:

- a $HermesOS tier qualification row;
- a yearly token subscription;
- a managed-Venice $HermesOS deposit lot; or
- a $HermesOS balance snapshot that met the base tier (at least 1 token).

Members keep $HermesOS tiers and payments with **no deadline**, and may also
pay and hold in $HIVRA. A member the bulk pass missed is added the first time
they are checked (`ensure_token_grandfather_membership`). No one who starts
after activation can join.

**Everyone else** holds and pays in $HIVRA only. $HermesOS quotes are refused
server-side (HTTP 403 `token_not_allowed`) for hold-for-tier, yearly and
managed-Venice deposits. $HermesOS balances do not count toward their tiers
or the token base tier.

**Conversion rule** (`POST /api/billing/token-access {"action":"convert"}`,
used by the /dashboard/convert page):

1. At conversion, the current $HIVRA thresholds for Pro and Power are locked,
   and a grace of `TOKEN_CONVERSION_GRACE_HOURS` (72 hours) starts. Conversion
   fails closed without a live $HIVRA price.
2. During the grace, holding **either** token keeps the tier: the $HermesOS
   row's own quantity, or the locked $HIVRA amount.
3. After the grace, each $HermesOS tier row moves to $HIVRA. The new
   qualifying quantity is the then-current $HIVRA threshold, capped at the
   amount locked at conversion. A user who holds the locked amount keeps the
   tier even if $HIVRA got pricier to hold, so there is no access gap.
   Holding less opens the normal breach grace (`REQUALIFICATION_GRACE_HOURS`,
   24h) and the normal suspension rules.
4. If no live $HIVRA price is available at the end of the grace, the row stays
   on the either-token rule and moves on a later tick.

Users should convert before (or as) they swap tokens. The grace protects a
converted user, and a swap made before converting drops the $HermesOS balance
without it.

**Discounts carry over.** The USD targets are the same in both tokens: Pro and
Power hold thresholds, yearly $49/$99, and the managed-Venice launch and
standard bonus with its hidden lifetime cap.

**Quotes already issued** before activation settle in their own token within
their normal window plus late grace, whoever holds them.

**Settlement credits only the quote's token.**
- Yearly settlement goes through `settle_yearly_platform_token_payment`, which
  refuses any other token.
- Managed-Venice deposits scan and credit only the quote's token.
- Lots, subscriptions and financial events record the token (`token_key`,
  `token_address`, `wallet_type`). Sweeps move the token each payment was made
  in.

**Wrong-token deposits.** A transfer of the other platform token into a
quote's range is never credited. It is recorded for operator recovery:

- yearly: `yearly_token_reconciliation_items` with `reason = 'wrong_token'`;
- managed Venice: `managed_venice_reconciliation_items` with
  `reason = 'managed_venice_token_deposit_wrong_token'`.

Both carry the sent token's `token_address` and raise an ops event.

```sql
select created_at, user_id, reason, token_address, transaction_hash, log_index, token_amount_raw, deposit_address
  from yearly_token_reconciliation_items where reason = 'wrong_token' and status = 'open';
select created_at, user_id, reason, token_address, metadata
  from managed_venice_reconciliation_items where reason = 'managed_venice_token_deposit_wrong_token' and status = 'open';
```

The operator returns the tokens from the deposit wallet, or credits the user
by hand, and then resolves the item.

**Legacy lock wallets** (`hermesos_lock`):
- No app path provisions one (regression test `legacy-lock-wallets.test.ts`).
- Holders can withdraw to their saved address. That is an exit and starts
  the breach clock.
- Or they can move to their own verified wallet (`POST
  /api/billing/bankr/wallet/withdraw {"destination":"verified_wallet"}`).
  That holds new breaches for 30 minutes while the move lands, and evaluates
  the tier on the verified wallet once the moved tokens are visible. It does
  not start a breach.

## 5. Price gates (both tokens, all the time)

Every price used for a quote or a new tier threshold passes two gates, or the
quote fails closed with a 503 "try again later":

1. **Liquidity floor:** the canonical pool holds at least the token's
   `minPriceLiquidityUsd` ($HermesOS $10,000, $HIVRA $25,000).
2. **Median cross-check:** the DEXScreener spot is within
   `PLATFORM_PRICE_MAX_DEVIATION_BPS` (10%) of the median close of the pool's
   last 12 five-minute candles on GeckoTerminal. At least 3 candles are
   needed in the last 24 hours. Managed-Venice deposits apply the stricter 5%.

Breach, grace, recovery and suspension never need a live price. They compare
balances with each row's fixed qualifying quantity.

## 6. Verify

Run on the target database (read-only) after `activatesAt`:

```sql
select token_key, token_address, activated_at, cohort_recorded_at, cohort_size from platform_token_activations;
select count(*) as cohort from token_grandfather_cohort;
select tier_key, token_key, token_address, token_symbol, min_balance_raw::text, active
  from token_entitlement_configs order by token_key;
```

Expect:
- one `hivra` activation row with your address (lower-cased) and instant;
- a cohort of about the size estimated at the time: on 2026-09-23 prod had
  56 users with qualifying $HermesOS history;
- a `token_base` / `hivra` row with `min_balance_raw` = 10^decimals.

Then on the served site:

1. `/token` lists $HIVRA first (LIVE, with your contract and a BaseScan link)
   and $HermesOS as LEGACY.
2. As a **new** disposable fixture account, `GET /api/billing/token-access`
   returns `paymentToken: "hivra"` and `allowedTokens: ["hivra"]`. A yearly
   quote request without a token returns a $HIVRA quote whose "Send exactly"
   step shows the $HIVRA contract. The same request with
   `{"tier":"pro","token":"hermesos"}` returns 403 `token_not_allowed`.
3. As a grandfathered account (read-only check), the token-access response
   shows `grandfathered: true` and `paymentToken: "hermesos"`.
4. Clean up the fixtures (live-environment-verification ledger).

## 7. Rolling back

Before any $HIVRA payment or tier row exists, emptying the block (a revert PR)
returns everything to dormant.

After $HIVRA rows exist, **do not** empty the block. Rows in a token the
registry no longer knows cannot be read, and money paths stop on them.
Instead, stop new $HIVRA quotes with the price gates (for example by raising
`HIVRA_MIN_PRICE_LIQUIDITY_USD`) and plan a proper follow-up.

The activation record and the cohort are durable and are never removed by a
rollback.

## 8. Existing users at activation

When prod gets the dual-token code (a Promote) and later the address, the
existing holders are **grandfathered automatically**. They need to do nothing
and keep $HermesOS with no deadline. On 2026-09-23 (read-only counts):

- 21 users with a currently eligible $HermesOS Pro/Power tier;
- 2 live yearly token subscriptions;
- 10 users with managed-Venice $HermesOS deposits;
- 56 users with any qualifying $HermesOS history, which is the cohort if
  activated that day.

Their yearly subscriptions run to expiry and renew in $HermesOS if they
choose.
