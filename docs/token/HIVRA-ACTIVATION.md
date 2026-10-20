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
3. **Market:** $HIVRA launches on Doppler into a Uniswap v4 pool quoted in
   **native ETH** (currency0 = `address(0)`, the Doppler hook sets the fee),
   not a HIVRA/WETH pair. The price feed accepts a pool quoted in native ETH
   or WETH and nothing else. The pool must pass the price gates, or every
   $HIVRA quote and every new $HIVRA tier qualification fails closed (see
   section 5):
   - DEXScreener lists the canonical pool with at least
     `HIVRA_MIN_PRICE_LIQUIDITY_USD` of total liquidity ($25,000) **and** at
     least `HIVRA_MIN_QUOTE_LIQUIDITY_USD` of ETH on its ETH side ($12,500;
     both in `dashboard/src/lib/billing/token-registry.ts`). A Doppler pool
     starts almost entirely $HIVRA, and DEXScreener values that side at the
     pool's own price, so the total alone can look healthy while the pool
     holds next to no ETH. The ETH-side floor is the one a fresh pool fails.
   - GeckoTerminal has indexed the pool, its first completed five-minute
     candle is at least four hours old, it has traded in at least 24
     five-minute periods, and the price has not risen more than 10% in the
     last two hours. Until then the median check refuses quotes (section 5).
4. **Token surfaces are switched on.** The wallet, token-holding, token-access
   and token quote routes answer 404 unless crypto billing is enabled on the
   target (`CRYPTO_BILLING_ENABLED=true` or
   `NEXT_PUBLIC_CRYPTO_BILLING_ENABLED=true`, plus billing v2). On 2026-09-23
   it was off on Canary. Turning it on is an environment change for Ash, not
   part of the activation PR. Tier crons, settlement and sweeps run either way.
5. **Decision:** agree the activation instant. Every account with $HermesOS
   history before that instant is grandfathered (section 4). It must be in
   the future when the PR merges, and later than the moment the code is
   live on each target (the Canary build; for production, the Promote).
   Otherwise a user who arrives between the instant and the deploy sees a
   $HermesOS-only site but is not grandfathered.
6. **Holder airdrop (separate from activation):** there is no claim and no
   swap. $HermesOS holders at a snapshot block are sent $HIVRA directly, one
   for one, by a push airdrop after the launch (section 9). The
   /dashboard/convert page reads the $HIVRA contract from the same registry,
   so it needs no address of its own, and it stays on its pre-launch copy
   until the launch block is filled in. The airdrop facts (sender wallet,
   snapshot block, snapshot list, sent time) live in
   `dashboard/src/lib/claim/hivra-airdrop-config.ts` and each goes in by its
   own reviewed PR. The page and the launched /token, /tokenomics,
   /why-hivra/evolution and /llms.txt copy need the UK financial-promotion /
   legal review before any Promote. Activation does not depend on them.

## 2. The one file to edit

`dashboard/src/lib/billing/hivra-token-launch.ts`:

```ts
export const HIVRA_TOKEN_LAUNCH: HivraTokenLaunchConfig = {
  contractAddress: "0x…",                 // $HIVRA on Base, EIP-55 checksummed as BaseScan shows it
  decimals: 18,                           // read on-chain, see below
  poolId: "0x…",                          // the Doppler Uniswap v4 pool id (0x + 64 hex)
  activatesAt: "2026-10-01T16:00:00Z",    // UTC, to the second
};
```

Nothing else changes for activation. No environment variable, no migration,
no other file (the conversion links in precondition 6 are a separate PR).
Everything else (balances, tiers, quotes, settlement, sweeps, the price feed,
the /token page, emails and wallet links) reads this block through
`token-registry.ts`. That includes the public token copy: /token, /tokenomics,
/why-hivra/evolution and /llms.txt switch from their dormant wording to their
launched wording (`dashboard/src/lib/token-phase-copy.ts`) when the block is
filled in, and again at `activatesAt`. The launched wording needs the UK
financial-promotion / legal review before any Promote.

### The activation helper

`dashboard/scripts/token/prepare-hivra-activation.mjs` checks a launch and
fills in the block. It is **read-only**: it reads Base on the public RPC
`https://mainnet.base.org` (`eth_getCode`, and `eth_call` to `name()`,
`symbol()`, `decimals()`, `totalSupply()`, `yearlyMintRate()` and Doppler's
`DopplerHookInitializer.getState(token)`), DEXScreener and GeckoTerminal. It
signs nothing, sends no transaction and posts to no service.

```sh
cd dashboard
node scripts/token/prepare-hivra-activation.mjs \
  --address 0x… --activates-at 2026-10-01T16:00:00Z          # report only
node scripts/token/prepare-hivra-activation.mjs \
  --address 0x… --activates-at 2026-10-01T16:00:00Z --write  # also fill in the block
```

Options: `--pool-id 0x…` uses that ETH-quoted pool instead of the one Doppler
recorded (or the deepest); `--json` prints the result as JSON. Exit code 0 means every check passed,
1 means one failed, 2 means bad usage.

It checks, and `--write` refuses unless every FAIL-level check passes:

| Check | Passes when |
|---|---|
| `address.format`, `address.not_hermesos` | a non-zero 20-byte address that is not the $HermesOS contract |
| `address.checksum` | a mixed-case address has a valid EIP-55 checksum (a lowercase one is written in its EIP-55 form) |
| `activatesAt.format`, `activatesAt.future` | a real UTC instant to the second, in the future |
| `chain.code`, `chain.name`, `chain.symbol`, `chain.decimals`, `chain.total_supply` | contract code on Base, `name()` is `Hivra`, `symbol()` is `HIVRA`, `decimals()` is 18, `totalSupply()` is 100,000,000,000 whole tokens |
| `chain.implementation` | the token is an EIP-1167 clone of the DopplerERC20V1 implementation on Base: a clone cannot be upgraded, and DopplerERC20V1 mints only at launch |
| `chain.no_mint` | the code that runs has no mint entry point (`mint(address,uint256)`, `mint(uint256)`, `mintTo(address,uint256)`, `mintInflation()`) |
| `chain.inflation` | there is no `yearlyMintRate()`, or it is 0 |
| `doppler.state` | Doppler's `DopplerHookInitializer` holds a pool for this token that is `Initialized` or `Locked` (not missing, not `Graduated` or `Exited`) |
| `doppler.numeraire` | the pool's numeraire is native ETH; WETH is a WARN (the price feed accepts it), anything else fails |
| `pool.found`, `pool.id_format` | DEXScreener lists an ETH-quoted (native ETH or WETH) $HIVRA pool on Base (the Doppler pool, or `--pool-id`), with an id `token-registry.ts` accepts |
| `pool.doppler_key` | that pool is the one Doppler recorded: its id is the hash of Doppler's pool key, with this token on one side and the Doppler hook |
| `pool.liquidity` | the pool holds at least `HIVRA_MIN_PRICE_LIQUIDITY_USD` in total ($25,000) |
| `pool.eth_liquidity` | the pool's ETH side holds at least `HIVRA_MIN_QUOTE_LIQUIDITY_USD` ($12,500) |
| `candles.pool_token`, `candles.quote`, `candles.present` | GeckoTerminal prices the pool for this address, in ETH, and has at least one five-minute candle |

Both liquidity floors are read from `token-registry.ts`, so the helper and the
price feed use the same numbers.

It also warns (WARN, does not block) when `activatesAt` is less than two hours
away (`activatesAt.lead`), when there is more than one ETH-quoted $HIVRA pool
(`pool.single`), when the pool has less than four hours of candle history
(`candles.history`: quotes stay closed with `insufficient_history` until it
has; section 5), and when the spot is more than 10% above the four-hour median
(`candles.deviation`: quotes pause until the median catches up; section 5).

`--write` fills in only the four fields, with the checksummed address, the
on-chain decimals and the lowercase pool id, and changes nothing else in the
file. It refuses to overwrite a block that already names a launch (see
section 7 before changing one). The edit is only in your checkout: it ships
through the reviewed PR like any other change, and a failed check means waiting
(for liquidity, or for GeckoTerminal to index the pool) and running it again.
Its fixture tests run without network in the dashboard suite
(`__tests__/prepare-hivra-activation.test.ts`), which also fails if the helper
drifts from the registry's pool id and instant formats or its liquidity floor.

How to get each value by hand (the helper does these checks for you):

| Field | Source | Check |
|---|---|---|
| `contractAddress` | the launch (Doppler) | Open `https://basescan.org/token/<address>`: name, symbol and total supply match the launch. Paste the checksummed form. |
| `decimals` | on-chain `decimals()` | `curl -s https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<address>","data":"0x313ce567"},"latest"]}'`. `0x…12` = 18. |
| `poolId` | Doppler's `DopplerHookInitializer.getState(<address>)` on Base, and DEXScreener `https://api.dexscreener.com/latest/dex/tokens/<address>` | The Uniswap v4 pool id (0x + 64 hex) of the Doppler pool, quoted in native ETH (DEXScreener shows the quote token as ETH at `0x000…000`). The price feed accepts only this pool. |
| `activatesAt` | Ash's decision | A future instant, later than the deploy on every target (precondition 5). Until then /token shows $HIVRA as "launching soon". Never paste a past instant. |

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
  Before anything is sent it writes a breach hold for exactly the amount
  moving, for 30 minutes. While it lasts, a breach is not recorded as long as
  the balance read plus the amount in flight still qualifies; the tier is
  then evaluated on the verified wallet once the moved tokens are visible.
  It does not start a breach, and moving dust cannot shield an emptied
  wallet.

## 5. Price gates (both tokens, all the time)

Every price used for a quote or a new tier threshold passes these gates, or the
quote fails closed with a 503 "try again later":

1. **Liquidity floor:** the canonical pool holds at least the token's
   `minPriceLiquidityUsd` ($HermesOS $10,000, $HIVRA $25,000). For $HIVRA
   the pool's ETH side must also hold at least `minQuoteLiquidityUsd`
   (`HIVRA_MIN_QUOTE_LIQUIDITY_USD`, $12,500), valued at ETH's USD rate.
   $HermesOS has no ETH-side floor. Until the Doppler pool holds that much
   ETH, these fail closed for $HIVRA: hold-for-tier, yearly and
   managed-Venice $HIVRA quotes, and any new $HIVRA tier qualification (it
   needs a live threshold). These do not depend on it: receiving the
   airdrop, holding $HIVRA, and keeping a tier already qualified (breach and
   grace compare balances, not prices).
2. **Median cross-check:** the reference is the median price over the last
   `PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES` (4 hours) of five-minute buckets
   from GeckoTerminal, compared with the DEXScreener spot in the pool's
   paired token (WETH), so an ETH move is not read as a token move. A bucket
   with no trades carries the last close forward, so a quiet pool is still
   quotable at its last price. Only completed candles count (the one still
   forming is just the latest trade). The check fails closed when the pool
   has no candle at all or a source is down.
3. **Minimum history:** the median is trusted only once the pool's first
   completed candle is at least `PLATFORM_PRICE_MIN_HISTORY_MINUTES` old (the
   whole four-hour window) and the pool has traded in at least
   `PLATFORM_PRICE_MIN_TRADED_CANDLES` (24) five-minute periods. A young
   pool's median is only its last few candles, which a pump sets, so until
   then every quote fails closed with the reason `insufficient_history`. This
   is a market condition, not an outage: no cached price is served instead.
4. **Pricing:** a quote is priced at the lower of spot and the median, so a
   pump never buys a cheaper quote. A spot more than
   `PLATFORM_PRICE_MAX_DEVIATION_BPS` (10%) above the median is refused
   outright until the median catches up (about two hours); a spot below it
   is used as is. Managed-Venice deposits also refuse a spot more than 5%
   from the median, in either direction.

**Watching the gates.** Each quote a gate refuses (the 503s from
`/api/billing/wallet/quote`, `/api/billing/yearly-token-quote` and
`/api/billing/managed-venice/hermesos/quote`) is reported by
`dashboard/src/lib/billing/price-gate-alerts.ts`:

- a warn log line, `Price gate refused a token quote`, with the route
  (`source`), the token (`asset`, `assetKey`), the reason (`gateReason`:
  `liquidity_floor`, `median_deviation`, `insufficient_history`, `no_candle`
  or `feed_error`), the
  underlying `gate` and the `observed` values (for example `liquidityUsd` and
  `minLiquidityUsd`, `aboveMedianBps` and `maxDeviationBps`, or the price
  source's `httpStatus`: a pool GeckoTerminal has not indexed yet answers 404
  and is reported as `no_candle`, while a 429 rate limit or a 5xx outage is
  `feed_error`). At most one line per token and reason per minute per server
  process; the next line's
  `refusalsSinceLastLog` counts the refusals folded into it. The per-request
  503 line is logged at info, so it does not flood production logs.
- an ops alert: a `warn` row in `ops_events` with source `billing/price-gate`,
  on /dashboard/ops and in the `/api/ops/events/feed` alert feed. At most one
  per token per 30 minutes from each server process, and the row is keyed to
  the 30-minute window, so other processes in the same window add to its
  count rather than opening another row. Each report overwrites the row's
  metadata, so the gate, reason and observed values on it are from the most
  recently reported refusal in the window, not the first. It does not page
  anyone: email and Telegram paging is only for fatal ops events. There is no
  Discord or Slack alert path in the code base.

On launch day, filter the logs for `price_gate_refused` or watch
/dashboard/ops for `billing/price-gate`.

Live tier thresholds reuse the last good price through a price-source
outage (up to an hour), but fail closed at once when a liquidity, pool or
deviation gate trips. A real rally of more than 10% pauses new quotes for up
to about two hours; for a young $HIVRA pool that may be frequent, and the
band is one constant in `price-feed.ts` if Ash wants it wider.

Breach, grace, recovery and suspension never need a live price. They compare
balances with each row's fixed qualifying quantity.

**$HIVRA readiness (what Billing offers).** Launching does not switch $HIVRA
payments and holder tiers on by itself. `dashboard/src/lib/billing/hivra-readiness.ts`
treats $HIVRA as usable only while it is live in the registry and its pool
passes the same gate as a quote (`fetchPlatformTokenPriceUsd`: both liquidity
floors, candle history and the 10% band), reusing the live-thresholds price
cache (a pass for 5 minutes, a failure for 1 minute) and failing closed if the
check cannot run. Until then, accounts outside the $HermesOS grandfather
cohort see card (and USDC credit) payments only; `/api/billing/token-payments`
reports `available: false`; new yearly, hold-for-tier and managed-Venice
$HIVRA quotes, `/api/billing/token-holding` and a no-tier
`/api/billing/wallet/eligibility` answer 503 "Token payments aren't available
yet." (`reason: hivra_not_ready`), and /dashboard/wallet says so and offers no
price lock; the tier evaluator records no new $HIVRA tier, as in a price
outage; and neither the token-tier cron nor wallet unlock grants the 1-token
base tier to an account not already on a token tier. Grandfathered accounts,
quotes already issued and their settlement, tiers and holdings already held
(still shown and refreshable in Billing), breach and grace, and withdrawals
are not affected.

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

**Before `activatesAt`:** nothing has been recorded yet. A revert PR that
empties the block returns everything to dormant. Merge it on every target
before the instant passes.

**After `activatesAt`:** do **not** empty the block. The activation record,
the cohort and the $HIVRA `token_base` row already exist, and $HIVRA quotes,
tier rows or payments may too. Rows in a token the registry no longer knows
cannot be read, and money paths stop on them. To pause $HIVRA, stop new
quotes through the price gates (for example by raising
`HIVRA_MIN_PRICE_LIQUIDITY_USD` in a reviewed PR). A full rollback needs its
own reviewed plan: settle or refund open $HIVRA quotes and payments, then an
operator deletes the `platform_token_activations` row and deactivates the
$HIVRA `token_base` config. Those are production database writes and need
Ash's explicit approval.

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

## 9. Holder airdrop ($HermesOS to $HIVRA)

The earlier plan (a Bankr launch, then an active claim that sold $HermesOS
into its pool and bought $HIVRA with the ETH, run by Bankr) is replaced. The
launch runs on Doppler, and holders get $HIVRA by a **push airdrop**: one
$HIVRA for each $HermesOS held at a snapshot block, sent to the same wallet.
The published list excludes pools, launch contracts, burn addresses and Ash's
own wallet, and lists wallets Hivra manages for users separately (their
$HIVRA goes to the user's own wallet). Holders do nothing. Hivra never asks anyone to connect a wallet, sign or pay
to receive it. What changed in this runbook:

- Precondition 6 no longer waits on a `termsUrl` and a `bankr.bot`
  `conversionUrl`. `conversion-links-config.ts` is gone; the page reads
  `hivra-airdrop-config.ts` and links to no claim or swap site at all.
- The `contractAddress` source is the Doppler launch, checked on BaseScan as
  before. The helper expects name `Hivra`, symbol `HIVRA`, 18 decimals, a
  total supply of exactly 100,000,000,000, a fixed supply (a DopplerERC20V1
  clone with no mint entry point and no inflation), and the Doppler v4 pool
  quoted in native ETH (section 2). If the launch differs on any of these, the
  helper fails and `--write` refuses; change the expectation in a reviewed PR
  first, never by hand.
- $HermesOS is different: it is an older Doppler DERC20 with `mintInflation()`
  and `yearlyMintRate()`. On Base its `yearlyMintRate()` reads 2% a year
  (0.02 in WAD) and `currentYearStart()` reads 0 (read on 2026-10-19), so its
  supply can grow by up to 2% a year once inflation starts. $HIVRA's
  `chain.no_mint` and `chain.inflation` checks exist to refuse a token like
  that.
- Doppler may move liquidity to another pool after its sale (migration). The
  price feed accepts only `poolId`. If the liquidity moves, the old pool
  falls under the floor and every $HIVRA quote fails closed until a reviewed
  PR names the new pool. Changing `poolId` after `activatesAt` is allowed
  (the activation record pins only the address and the instant).
- The $HIVRA floors are $25,000 total (`HIVRA_MIN_PRICE_LIQUIDITY_USD`) and
  $12,500 of ETH (`HIVRA_MIN_QUOTE_LIQUIDITY_USD`). Until the pool holds both,
  $HIVRA quotes and new $HIVRA tier qualification fail closed (section 5),
  while receiving the airdrop, holding $HIVRA and keeping an existing tier
  are unaffected.
- The conversion rule in section 4 (switch access, 72-hour grace) still
  applies. The convert page offers the switch to a grandfathered holder only
  once `sentAt` is set, because after the grace only $HIVRA counts.

### The airdrop config

`dashboard/src/lib/claim/hivra-airdrop-config.ts`:

```ts
export const HIVRA_AIRDROP: HivraAirdropConfig = {
  senderAddress: "0x3B95…",          // the wallet every airdrop transfer comes from (EIP-55)
  snapshotBlock: null,               // the Base block whose $HermesOS balances decide the airdrop
  snapshotUrl: null,                 // the published list: every wallet and the $HIVRA it is sent
  sentAt: null,                      // UTC instant by which every transfer was confirmed
};
```

Nothing in it shows anywhere until the launch block in section 2 is filled
in. Then, in order, each by its own reviewed PR:

1. **With the activation PR (or after):** the sender wallet is already set.
   The page shows it so holders can check an incoming transfer.
2. **When the snapshot is taken and published:** `snapshotBlock` and
   `snapshotUrl` together. The list must be public at that URL first, on
   `hivra.cloud`, `canary.hermesos.cloud` or under
   `github.com/ashneil12/hivra/`; anything else is rejected and logged
   (`HIVRA airdrop config rejected`). The snapshot shows only when both are
   set and valid.
3. **When the last transfer is confirmed on Base:** `sentAt`. A future
   instant, or one without a published snapshot, is rejected. Setting it
   opens the optional "switch your access" step for grandfathered holders.

Decide and publish, with the snapshot, which wallets it leaves out (for
example pools, launch contracts and Ash's own wallet). Wallets Hivra manages
(the legacy `hermesos_lock` wallets) are included but flagged: the generator
below sends their $HIVRA to the owner's own wallet when a private remap names
one. A lock wallet that still receives $HIVRA can withdraw it from Wallet once
$HIVRA is live; one that holds only $HIVRA shows just that withdraw. The page
tells holders that the published snapshot says whether a Hivra-managed wallet
is included.

### Building the airdrop list and the Disperse batches

`dashboard/scripts/token/build-hivra-airdrop.mjs` turns the snapshot into the
public list and the send batches. It is offline: it reads and writes local
files only, signs nothing and sends nothing. The airdrop wallet sends each
batch by hand on disperse.app. Every amount is whole wei (BigInt, no float).

1. **Snapshot CSV.** One row per $HermesOS holder at `snapshotBlock`, with an
   `address` and a `balance_wei` column. Keep it outside the repository.
2. **Exclusions** (optional, `--exclusions`): `{"0xaddress": "public reason"}`.
   The reason is published, so it must not name a person, an email or a user
   id (the generator refuses ones that look like either).
3. **Remap** (optional, `--remap`, PRIVATE): `{"0xaddress": {"send_to":
   "0x…", "kind": "…"}}` for Hivra-managed wallets whose $HIVRA goes to the
   owner's own wallet. It must sit outside the repository (the generator
   refuses a path inside it) and is never committed.
4. **Allocation guard** (`--max-total-wei` or `--max-total-tokens`, give one):
   the airdrop wallet's $HIVRA allocation. The run refuses, writing nothing,
   when the included total is larger.
5. **Run it:**
   ```sh
   cd dashboard
   node scripts/token/build-hivra-airdrop.mjs --snapshot ~/airdrop/snapshot.csv \
     --snapshot-block <block> --exclusions ~/airdrop/exclusions.json \
     --remap ~/airdrop/remap.json --max-total-tokens <allocation> \
     --public-json src/data/token/hivra-airdrop.json --batches-dir ~/airdrop/batches
   ```
   It writes the public list to `src/data/token/hivra-airdrop.json` (holders
   and exact amounts, excluded wallets with their reason, managed wallets
   flagged with no destination and no batch) and one disperse.app text file
   per batch to `--batches-dir`, which must also be outside the repository
   (the batches carry the private destinations). Each destination gets one
   line: when a remap's `send_to` is another holder, or two managed wallets
   share an owner, their amounts are added together exactly. It then reads
   the batch files back and exits 1 unless they add up to the included total
   to the wei, with one line per destination.
6. **Publish** the snapshot list (precondition for `snapshotUrl`), then commit
   `hivra-airdrop.json` and set `snapshotBlock` and `snapshotUrl` in reviewed
   PRs. The /token/airdrop lookup opens only when `HIVRA_NEW_TOKEN_SURFACES` is
   on, the launch block is filled in, the snapshot is published, and the
   committed list passes its checks and is for the same block. /token and
   /dashboard/convert link to it only under that same check, and never for a
   viewer the token geo-policy blocks.
7. **After each batch confirms on Base**, add its transaction to a sent file
   (`{"1": "0x<tx hash>", ...}`) and re-run with `--sent-txs <file>`. The
   public list then shows that batch as sent; commit it by a reviewed PR.
   After the last batch, set `sentAt`.

### The migration page (/token/migration)

A public page that explains the move: what changed, the contracts, where the
$HIVRA pool's trading fees go, the founder's legacy $HermesOS and the planned
rules for them, on-chain receipts, and how to stay safe. It reads
`dashboard/src/lib/claim/hivra-migration-config.ts`, plus the $HIVRA contract
from the registry and the snapshot block from the airdrop config (it keeps no
copy of either).

It is a 404, and /token and /dashboard/convert do not link to it, until
`HIVRA_NEW_TOKEN_SURFACES` is on, the launch block is filled in, and
`published` is `true` (one check, `getServedHivraMigration` in
`hivra-migration.ts`). A viewer the token geo-policy blocks gets the notice
and no details, and no link.

Filled in already: `treasurySafe`, `fee`, and the founder's `wallet`,
`heldTokens`, `migrated: false`, `headStartDays`, `weeklyCapTokens`,
`maxPriceImpactPct`, `weeks` and `burnAddress`. Filled in at launch, each by a
reviewed PR: `announcedAt` (UTC instant), the founder's `saleStart`,
`saleDay` (the weekday, matching `saleStart`) and `burnDate`, `receipts` as
transactions confirm, and `published: true` last. Every value is checked
(EIP-55 addresses, 0x + 64 hex transaction hashes, real UTC dates in order:
`saleStart` after the no-sale period, `burnDate` after the last sale week, no
receipt in the future, no founder sale or burn before `saleStart`). A bad
value is dropped and logged (`HIVRA migration config rejected`), and the page
leaves out the section that needed it. The page copy needs the UK
financial-promotion / legal review before release.

### Still Bankr-era (not changed here)

- `LITEPAPER.md`, `docs/litepaper/index.html` and `TOKENOMICS.md` still
  describe the Bankr launch and the active claim. They are Ash's text and
  need his rewrite and the legal review.
- The dormant copy (before the launch block is filled in) still describes
  the old proposal on purpose, so nothing visible changes before the launch.

