# Token receipts page (/token/receipts)

The public page where holders check four promises against Base:

1. **Fee claims.** Hivra's share of the $HIVRA pool's trading fees arriving in the treasury Safe.
2. **Liquidity added and locked.** The Safe putting a share of those fees back into the pool and locking the position.
3. **The founder's weekly $HermesOS sell-down.** At most the weekly cap, over the planned weeks, from the sale start.
4. **The final burn.** The founder's unsold $HermesOS sent to the burn address.

It is read-only. The server fetches transaction receipts, blocks and balances over JSON-RPC. It holds no key and signs nothing.

## Where the data comes from

- **The ledger:** `dashboard/src/lib/token-receipts/token-receipts-config.ts` (`TOKEN_RECEIPTS`). One entry per transaction: `date`, `kind`, `txHash`, `note`, and for a lock the `lock` details. No amounts.
- **The addresses and the plan:** `HIVRA_MIGRATION` in `dashboard/src/lib/claim/hivra-migration-config.ts` (treasury Safe, fee split, founder wallet, held tokens, head start, weekly cap, weeks, sale start, burn date, burn address). Checked by the same validator as /token/migration, whether or not that page is published.
- **Amounts and balances:** read from Base when the page renders. Each amount is taken from the transaction's own logs. The Safe's ETH and $HIVRA and the founder wallet's $HermesOS are read live.

RPC: `HERMES_BASE_RPC_URL`, then `BASE_RPC_URL`, then `https://mainnet.base.org`. A transaction is fetched at most once a day per server and balances at most every five minutes (`unstable_cache`). A failed read is never cached.

## When it is served

Only when `HIVRA_NEW_TOKEN_SURFACES` is on and the $HIVRA launch block is filled in (phase scheduled or active). Otherwise it is a 404, and the proxy redirects everything under `/token` while the switch is off. A viewer the token geo-policy blocks gets the notice, no receipts, and Base is not read for them. /token links to it ("Check the on-chain receipts") under the same conditions.

## Adding a receipt

Add one entry per transaction by a reviewed PR as it confirms:

```ts
export const TOKEN_RECEIPTS: readonly TokenReceiptEntry[] = [
  { date: "2026-11-06", kind: "fee-claim", txHash: "0x…", note: null },
  { date: "2026-11-13", kind: "liquidity-add", txHash: "0x…", note: "Week 1 liquidity." },
  { date: "2026-11-13", kind: "liquidity-lock", txHash: "0x…", note: null,
    lock: { locker: "UNCX", lockerAddress: "0x…", url: "https://…", unlocksAt: "2027-11-13" } },
  { date: "2026-11-06", kind: "founder-sale", txHash: "0x…", note: null },
  { date: "2027-01-22", kind: "founder-burn", txHash: "0x…", note: null },
];
```

`date` is the UTC day (or instant) the transaction confirmed. `unlocksAt` is a UTC date or instant, or `"never"`. The same transaction can be listed under two kinds (an addition and a lock in one call).

Liquidity and founder transactions go here only. /token/migration adds them to its "Liquidity added and locked" and "Founder sales and burn" groups from this ledger, so do not also put them in `HIVRA_MIGRATION.receipts` (a duplicate is logged). Claim receipts stay in `HIVRA_MIGRATION.receipts`.

## What each kind must show on chain

An entry is shown only when its transaction succeeded, its block falls on the entry's UTC day, and:

| Kind | Must show | Amount shown |
| --- | --- | --- |
| `fee-claim` | ETH (`SafeReceived` from the Safe) or a named token (`Transfer` to the Safe) reaching the Safe | What reached the Safe |
| `liquidity-add` | `ExecutionSuccess` from the Safe, and something leaving it | Tokens leaving the Safe, plus the ETH `value` of a plain `execTransaction` |
| `liquidity-lock` | `ExecutionSuccess` from the Safe, and a log from the named locker or a transfer from the Safe to it | Positions (ERC-721 ids) and named tokens leaving the Safe |
| `founder-sale` | $HermesOS leaving the founder wallet (not to the burn or zero address) | That $HermesOS |
| `founder-burn` | $HermesOS going from the founder wallet to the burn address or the zero address | That $HermesOS |

Named tokens are ETH, WETH, $HIVRA, $HermesOS and USDC. Any other token moved is counted ("1 other token transfer"), not named. A founder sale dated before the sale start is refused, as on /token/migration.

An entry that fails is left off the page and logged as `Token receipts rejected` (config errors as `Token receipts config rejected`), with the reason. It is never shown as done. When Base cannot be reached, the page still lists every entry as "Not checked", leaves those lines out of the totals, and says so at the top.

## The founder weeks table

Once `founder.saleStart` and `founder.weeks` are set, the page shows one row per planned week, counted in whole weeks from the sale start's UTC day, with what the verified sales sold that week and whether it is within `weeklyCapTokens`. A week over the cap is shown as "No, over the limit". Sales after the last planned week are summed separately.

## What it does not check

- **Price impact.** The 5% per-sale price-impact limit is stated on /token/migration but not measured here.
- **Native ETH sent through MultiSend.** ETH the Safe sends inside a delegatecall batch is not visible in logs, so a `liquidity-add` made that way shows only its token transfers. Link the lock and add a `note` if that matters.
- **Fees that reach the Safe through another wallet.** A `fee-claim` must deliver straight to the Safe. If Doppler pays an intermediate wallet that later forwards to the Safe, list the forwarding transaction.
- **Completeness.** The page shows what the ledger lists. The live founder balance is there so anyone can compare it with the sales and burn listed.

Token-facing copy: like the other token pages, it needs the UK financial-promotion / legal review before release.
