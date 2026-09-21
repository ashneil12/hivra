# Managed Venice Inference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build managed Venice inference with two visible wallets, $HermesOS FIFO lots, pre-call reservations, proxy keys, subsidy caps, and launch observability.

**Architecture:** Add a separate managed-Venice accounting surface instead of mutating the existing compute credit ledger. The backend owns wallet lots, card balances, proxy keys, reservations, usage events, discount policy, and immutable financial events; the proxy only forwards Venice requests after a successful reservation and fails closed when cost cannot be estimated. V1 enables Venice chat completions first and blocks unpriced media endpoints until endpoint-specific quote/cost handlers exist.

**Tech Stack:** Next.js App Router API routes, Supabase/Postgres migrations with RLS, Clerk auth, existing `apiSuccess`/`apiError` helpers, existing DEXScreener HermesOS price feed, Bankr wallet/deposit primitives, Jest/ts-jest tests, React dashboard components.

---

## References

- Spec: `docs/superpowers/specs/2026-05-12-managed-venice-inference-design.md`
- Venice chat completions: https://docs.venice.ai/api-reference/endpoint/chat/completions
- Venice pricing: https://docs.venice.ai/overview/pricing
- Venice rate limits: https://docs.venice.ai/api-reference/rate-limiting

## Scope Check

The approved spec spans accounting, proxy infrastructure, wallet UX, observability, and operations. Implement it in phases with a commit after each task:

1. Accounting foundation and pure domain tests.
2. Deposit quote and FIFO lot settlement.
3. Discount policy, subsidy caps, and financial events.
4. Proxy key issuance and auth.
5. Venice pricing/reservation engine.
6. Non-streaming chat-completions proxy.
7. Streaming proxy support.
8. Dashboard wallet/key UI.
9. Observability and ops runbooks.

Do not add image, audio, video, embeddings, or arbitrary Venice endpoint proxying until those endpoints have their own price estimators and settlement tests.

## File Structure

Create:

- `dashboard/supabase/migrations/20260512180000_managed_venice_wallets.sql` - managed Venice schema, indexes, RLS, immutable event protections.
- `dashboard/src/lib/billing/microdollars.ts` - integer USD micro-unit helpers.
- `dashboard/src/lib/billing/managed-venice-wallets.ts` - wallet accounts, token lots, card balance reads, FIFO spend, reservations.
- `dashboard/src/lib/billing/managed-venice-discounts.ts` - launch/standard discount policy, cap math, kill-switch checks.
- `dashboard/src/lib/billing/managed-venice-financial-events.ts` - append-only accounting event writer.
- `dashboard/src/lib/billing/managed-venice-token-quotes.ts` - 60-second $HermesOS quote and settlement helpers.
- `dashboard/src/lib/venice/pricing.ts` - checked-in chat model price catalog and microdollar cost math.
- `dashboard/src/lib/venice/cost-estimator.ts` - conservative request estimator and usage cost calculator.
- `dashboard/src/lib/venice/proxy-keys.ts` - proxy key generation, hashing, lookup, revocation.
- `dashboard/src/lib/venice/proxy-settlement.ts` - reserve, capture, release, reconciliation helpers.
- `dashboard/src/app/api/billing/managed-venice/summary/route.ts` - wallet balances, discount state, key summary.
- `dashboard/src/app/api/billing/managed-venice/hermesos/quote/route.ts` - $HermesOS inference-credit deposit quotes.
- `dashboard/src/app/api/billing/managed-venice/hermesos/settle/route.ts` - internal quote settlement endpoint.
- `dashboard/src/app/api/billing/managed-venice/card/top-up/route.ts` - card wallet top-up checkout/session entry point.
- `dashboard/src/app/api/managed-venice/keys/route.ts` - create/list/revoke proxy keys.
- `dashboard/src/app/api/managed-venice/v1/chat/completions/route.ts` - Venice-compatible chat-completions proxy.
- `dashboard/src/components/billing/ManagedVeniceWalletPanel.tsx` - side-by-side wallet UI.
- `dashboard/src/components/billing/ManagedVeniceKeysPanel.tsx` - proxy key UI.
- `dashboard/src/components/billing/ManagedVeniceSubsidyBanner.tsx` - cap/kill-switch UX messaging.
- `dashboard/docs/managed-venice-runbook.md` - rotation, kill switch, reconciliation, legal launch checklist.

Modify:

- `dashboard/src/app/dashboard/billing/page.tsx` - render managed Venice wallet/key panels without bloating page internals.
- `dashboard/src/lib/billing/activity.ts` - include managed Venice activity once backend records exist.
- `dashboard/src/app/api/billing/usage/route.ts` - include managed Venice summary if needed by existing dashboard data load.
- `dashboard/src/lib/billing/price-feed.ts` - expose reusable freshness checks if token quotes need them.
- `dashboard/src/lib/ops/account-deletion.ts` - include managed Venice tables in account deletion order.
- `dashboard/README.md` - document new env vars.

Test:

- `dashboard/src/lib/billing/__tests__/microdollars.test.ts`
- `dashboard/src/lib/billing/__tests__/managed-venice-wallets.test.ts`
- `dashboard/src/lib/billing/__tests__/managed-venice-discounts.test.ts`
- `dashboard/src/lib/billing/__tests__/managed-venice-token-quotes.test.ts`
- `dashboard/src/lib/venice/__tests__/pricing.test.ts`
- `dashboard/src/lib/venice/__tests__/cost-estimator.test.ts`
- `dashboard/src/lib/venice/__tests__/proxy-keys.test.ts`
- `dashboard/src/lib/venice/__tests__/proxy-settlement.test.ts`
- `dashboard/src/app/api/managed-venice/keys/__tests__/route.test.ts`
- `dashboard/src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts`
- `dashboard/src/app/api/billing/managed-venice/hermesos/quote/__tests__/route.test.ts`
- `dashboard/src/components/billing/__tests__/ManagedVeniceWalletPanel.test.tsx`
- `dashboard/src/components/billing/__tests__/ManagedVeniceKeysPanel.test.tsx`
- `dashboard/__tests__/managed-venice-schema.test.ts`

---

### Task 1: Schema And Microdollar Foundation

**Files:**
- Create: `dashboard/supabase/migrations/20260512180000_managed_venice_wallets.sql`
- Create: `dashboard/src/lib/billing/microdollars.ts`
- Create: `dashboard/src/lib/billing/__tests__/microdollars.test.ts`
- Create: `dashboard/__tests__/managed-venice-schema.test.ts`

- [ ] **Step 1: Write failing microdollar tests**

```ts
import {
  MICRODOLLARS_PER_USD,
  centsToMicrodollars,
  microdollarsToDisplayDollars,
  multiplyMicrodollarsByRatio,
} from "@/lib/billing/microdollars";

it("uses microdollars as the internal USD unit", () => {
  expect(MICRODOLLARS_PER_USD).toBe(1_000_000);
  expect(centsToMicrodollars(123)).toBe(1_230_000);
  expect(microdollarsToDisplayDollars(123_456)).toBe("$0.1235");
});

it("rounds monetary ratios conservatively", () => {
  expect(multiplyMicrodollarsByRatio(1_000_001, 20, 100)).toBe(200_001);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- --runTestsByPath src/lib/billing/__tests__/microdollars.test.ts --runInBand`

Expected: FAIL because `microdollars.ts` does not exist.

- [ ] **Step 3: Implement microdollar helpers**

```ts
export const MICRODOLLARS_PER_USD = 1_000_000;
export const MICRODOLLARS_PER_CENT = 10_000;

export function centsToMicrodollars(cents: number): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error("cents must be a non-negative integer");
  }
  return cents * MICRODOLLARS_PER_CENT;
}

export function multiplyMicrodollarsByRatio(
  amountMicroUsd: number,
  numerator: number,
  denominator: number
): number {
  if (!Number.isInteger(amountMicroUsd) || amountMicroUsd < 0) {
    throw new Error("amountMicroUsd must be a non-negative integer");
  }
  return Math.ceil((amountMicroUsd * numerator) / denominator);
}
```

- [ ] **Step 4: Write schema migration**

Create these tables, all service-role writable and user-readable where safe:

- `managed_venice_wallet_accounts`
- `managed_venice_token_lots`
- `managed_venice_card_ledger_entries`
- `managed_venice_proxy_keys`
- `managed_venice_reservations`
- `managed_venice_usage_events`
- `managed_venice_financial_events`
- `managed_venice_reconciliation_items`
- `managed_venice_platform_state`

Key constraints:

```sql
remaining_value_micro_usd bigint not null check (remaining_value_micro_usd >= 0)
```

```sql
create unique index managed_venice_financial_events_idempotency_idx
  on public.managed_venice_financial_events(idempotency_key);
```

```sql
create or replace function public.prevent_managed_venice_financial_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'managed_venice_financial_events is append-only';
end;
$$;
```

- [ ] **Step 5: Write schema hygiene test**

Assert migration includes:

- RLS enabled for every new table.
- service role full access policies.
- user select policies for wallet/lot/key/usage rows.
- financial event mutation-prevention triggers.
- unique idempotency index.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/billing/__tests__/microdollars.test.ts __tests__/managed-venice-schema.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/supabase/migrations/20260512180000_managed_venice_wallets.sql dashboard/src/lib/billing/microdollars.ts dashboard/src/lib/billing/__tests__/microdollars.test.ts dashboard/__tests__/managed-venice-schema.test.ts
git commit -m "feat: add managed venice accounting schema"
```

---

### Task 2: FIFO Wallet Lots And Reservations

**Files:**
- Create: `dashboard/src/lib/billing/managed-venice-wallets.ts`
- Create: `dashboard/src/lib/billing/__tests__/managed-venice-wallets.test.ts`

- [ ] **Step 1: Write failing FIFO lot tests**

Cover:

- `ensureManagedVeniceWalletAccount` creates one account per user.
- token lots are consumed oldest first.
- card wallet balance uses microdollars.
- reservations reduce available balance before capture.
- release returns unused balance.
- capture cannot create negative lot/card balance.

Test sketch:

```ts
it("spends HermesOS lots FIFO and updates token display proportionally", async () => {
  const { db } = createMemoryDb();
  await insertTokenLot(db, { userId: "user_1", value: 1_000_000, tokenRaw: 1000n });
  await insertTokenLot(db, { userId: "user_1", value: 2_000_000, tokenRaw: 2000n });

  const result = await debitManagedVeniceWallet(
    { userId: "user_1", walletType: "hermesos", amountMicroUsd: 1_500_000, referenceId: "usage_1" },
    db
  );

  expect(result.lots).toEqual([
    expect.objectContaining({ remainingValueMicroUsd: 0 }),
    expect.objectContaining({ remainingValueMicroUsd: 1_500_000 }),
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- --runTestsByPath src/lib/billing/__tests__/managed-venice-wallets.test.ts --runInBand`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement wallet account and balance reads**

Export:

- `ensureManagedVeniceWalletAccount`
- `getManagedVeniceWalletSummary`
- `getAvailableManagedVeniceBalance`
- `createManagedVeniceReservation`
- `releaseManagedVeniceReservation`
- `captureManagedVeniceReservation`
- `debitManagedVeniceWallet`

Keep Supabase access behind a small `SupabaseLike` interface like `credits.ts`.

- [ ] **Step 4: Implement FIFO token lot debit**

Rules:

- sort active lots by `created_at asc, id asc`,
- consume `remaining_value_micro_usd`,
- reduce `remaining_token_amount_raw` proportionally,
- write reservation/capture metadata with affected lot IDs,
- throw `InsufficientManagedVeniceBalanceError` before any partial mutation if the available total is too low.

- [ ] **Step 5: Implement reservation states**

Use states:

- `active`
- `captured`
- `released`
- `expired`
- `reconciliation_required`

Reservations must be idempotent by `reference_id`.

- [ ] **Step 6: Run focused tests**

Run: `cd dashboard && npm test -- --runTestsByPath src/lib/billing/__tests__/managed-venice-wallets.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/billing/managed-venice-wallets.ts dashboard/src/lib/billing/__tests__/managed-venice-wallets.test.ts
git commit -m "feat: add managed venice wallet accounting"
```

---

### Task 3: Token Deposit Quotes And Oracle Freshness

**Files:**
- Create: `dashboard/src/lib/billing/managed-venice-token-quotes.ts`
- Create: `dashboard/src/lib/billing/__tests__/managed-venice-token-quotes.test.ts`
- Modify: `dashboard/src/lib/billing/price-feed.ts`
- Create: `dashboard/src/app/api/billing/managed-venice/hermesos/quote/route.ts`
- Create: `dashboard/src/app/api/billing/managed-venice/hermesos/quote/__tests__/route.test.ts`
- Create: `dashboard/src/app/api/billing/managed-venice/hermesos/settle/route.ts`

- [ ] **Step 1: Write failing quote service tests**

Cover:

- quote expires in 60 seconds,
- quote refuses stale oracle older than 5 minutes,
- DEXScreener/Uniswap V4 disagreement above 5% refuses quote,
- quote by token amount creates locked microdollar value,
- late confirmation is marked `manual_review_required`,
- confirmed quote creates a token lot and financial event.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- --runTestsByPath src/lib/billing/__tests__/managed-venice-token-quotes.test.ts --runInBand`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Expose price freshness helpers**

Extend `price-feed.ts` without changing existing tier quote behavior:

```ts
export function isHermesPriceFresh(quote: HermesPriceQuote, now = new Date(), maxAgeMs = 5 * 60 * 1000): boolean {
  return now.getTime() - quote.lastUpdatedAt * 1000 <= maxAgeMs;
}
```

Add a cross-check seam:

```ts
export type HermesPriceCrossCheck = {
  source: "uniswap_v4_base_quoter";
  priceUsd: string;
  lastUpdatedAt: number;
};
```

- [ ] **Step 4: Implement quote creation**

API input:

```ts
const QuoteRequestSchema = z.object({
  tokenAmountRaw: z.string().regex(/^\d+$/),
});
```

Response includes:

- quote ID,
- token amount,
- snapshot price,
- locked value in microdollars,
- deposit address,
- expires at,
- source/cross-check metadata.

- [ ] **Step 5: Implement settlement route**

This is internal/cron-facing, protected by a bearer secret. It accepts:

```ts
{
  quoteId: string;
  transactionHash: string;
  tokenAmountRaw: string;
  observedAt: string;
  blockTimestamp?: string;
}
```

It creates a token lot only when the quote can be proven in-window. Otherwise it writes a reconciliation item.

- [ ] **Step 6: Run quote and route tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/billing/__tests__/managed-venice-token-quotes.test.ts src/app/api/billing/managed-venice/hermesos/quote/__tests__/route.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/billing/managed-venice-token-quotes.ts dashboard/src/lib/billing/price-feed.ts dashboard/src/lib/billing/__tests__/managed-venice-token-quotes.test.ts dashboard/src/app/api/billing/managed-venice/hermesos/quote dashboard/src/app/api/billing/managed-venice/hermesos/settle
git commit -m "feat: add managed venice hermesos deposit quotes"
```

---

### Task 4: Discounts, Caps, Financial Events

**Files:**
- Create: `dashboard/src/lib/billing/managed-venice-discounts.ts`
- Create: `dashboard/src/lib/billing/managed-venice-financial-events.ts`
- Create: `dashboard/src/lib/billing/__tests__/managed-venice-discounts.test.ts`

- [ ] **Step 1: Write failing discount tests**

Cover:

- 20% launch rate for eligible $HermesOS spend,
- user hits $250 launch cap and only that user steps down to 10%,
- weekly $1000 kill switch steps all new launch-wave spend to 10%,
- kill switch and user cap never chain to 0%,
- card wallet gets no discount,
- standard 10% has no per-user cap.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- --runTestsByPath src/lib/billing/__tests__/managed-venice-discounts.test.ts --runInBand`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement discount policy**

Export:

```ts
export type ManagedVeniceDiscountRate = "launch_20" | "standard_10" | "none";
export function resolveManagedVeniceDiscount(params: {
  walletType: "hermesos" | "card";
  userLaunchSubsidyUsedMicroUsd: number;
  weeklySubsidyUsedMicroUsd: number;
  killSwitchActive?: boolean;
}): { rate: ManagedVeniceDiscountRate; discountBps: number; reason: string };
```

Use:

- `20% = 2000 bps`,
- `10% = 1000 bps`,
- per-user launch cap = `250_000_000` microdollars,
- weekly kill switch = `1_000_000_000` microdollars.

- [ ] **Step 4: Implement financial event writer**

Append-only, idempotent by key:

```ts
await appendManagedVeniceFinancialEvent({
  userId,
  eventType: "usage_capture",
  walletType,
  amountMicroUsd,
  veniceCostMicroUsd,
  discountMicroUsd,
  referenceId,
  idempotencyKey,
});
```

- [ ] **Step 5: Run focused tests**

Run: `cd dashboard && npm test -- --runTestsByPath src/lib/billing/__tests__/managed-venice-discounts.test.ts --runInBand`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/billing/managed-venice-discounts.ts dashboard/src/lib/billing/managed-venice-financial-events.ts dashboard/src/lib/billing/__tests__/managed-venice-discounts.test.ts
git commit -m "feat: add managed venice discount policy"
```

---

### Task 5: Proxy Keys

**Files:**
- Create: `dashboard/src/lib/venice/proxy-keys.ts`
- Create: `dashboard/src/lib/venice/__tests__/proxy-keys.test.ts`
- Create: `dashboard/src/app/api/managed-venice/keys/route.ts`
- Create: `dashboard/src/app/api/managed-venice/keys/__tests__/route.test.ts`

- [ ] **Step 1: Write failing proxy key tests**

Cover:

- creates one-time plaintext key,
- stores only hash and prefix,
- verifies valid key,
- rejects revoked key,
- updates `last_used_at`,
- list endpoint never returns plaintext.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/venice/__tests__/proxy-keys.test.ts src/app/api/managed-venice/keys/__tests__/route.test.ts --runInBand
```

Expected: FAIL.

- [ ] **Step 3: Implement key format**

Format:

```txt
hven_live_<base64url-random-32-bytes>
```

Storage:

- `key_hash = sha256(fullKey + MANAGED_VENICE_PROXY_KEY_PEPPER)`,
- `key_prefix = first 14 chars`,
- plaintext shown once only.

- [ ] **Step 4: Implement route**

Methods:

- `GET /api/managed-venice/keys` lists active/revoked keys.
- `POST /api/managed-venice/keys` creates a key.
- `DELETE /api/managed-venice/keys?id=...` revokes a key.

Use `enforceAuthenticatedRouteRateLimit` with `RATE_LIMIT_PRESETS.secretWrite` for POST/DELETE.

- [ ] **Step 5: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/venice/__tests__/proxy-keys.test.ts src/app/api/managed-venice/keys/__tests__/route.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/lib/venice/proxy-keys.ts dashboard/src/lib/venice/__tests__/proxy-keys.test.ts dashboard/src/app/api/managed-venice/keys
git commit -m "feat: add managed venice proxy keys"
```

---

### Task 6: Venice Pricing And Cost Estimation

**Files:**
- Create: `dashboard/src/lib/venice/pricing.ts`
- Create: `dashboard/src/lib/venice/cost-estimator.ts`
- Create: `dashboard/src/lib/venice/__tests__/pricing.test.ts`
- Create: `dashboard/src/lib/venice/__tests__/cost-estimator.test.ts`

- [ ] **Step 1: Write failing pricing tests**

Cover:

- prices are represented in microdollars per 1M tokens,
- unknown model fails closed,
- `max_completion_tokens` wins over deprecated `max_tokens`,
- omitted output cap uses configured model max output ceiling,
- `n > 1` multiplies output reservation,
- 10% safety buffer is applied to reservation only, not final actual usage cost.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/venice/__tests__/pricing.test.ts src/lib/venice/__tests__/cost-estimator.test.ts --runInBand
```

Expected: FAIL.

- [ ] **Step 3: Implement checked-in pricing catalog**

Start with chat-completion text models only. Use official Venice pricing docs during implementation and pin `catalogUpdatedAt`.

Shape:

```ts
export interface VeniceChatModelPrice {
  model: string;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  contextWindow: number;
  maxOutputTokens: number;
}
```

Unknown models must throw `UnsupportedVeniceModelError`.

- [ ] **Step 4: Implement conservative token estimator**

V1 estimator:

- use explicit `max_completion_tokens` or `max_tokens` if present,
- if absent, model `maxOutputTokens`,
- estimate input tokens from message text as `ceil(characters / 3)`,
- include tool/function JSON size in character count,
- reject requests with `n > 1` unless reservation multiplies by `n`,
- add 10% safety buffer to reservation.

- [ ] **Step 5: Implement actual usage cost calculator**

Accept Venice `usage` object and calculate actual cost without safety buffer:

```ts
calculateActualChatCost({
  model,
  promptTokens,
  completionTokens,
  cacheReadTokens,
  cacheWriteTokens,
});
```

If final usage is missing, return a typed error so settlement can move to reconciliation instead of guessing.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/venice/__tests__/pricing.test.ts src/lib/venice/__tests__/cost-estimator.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/venice/pricing.ts dashboard/src/lib/venice/cost-estimator.ts dashboard/src/lib/venice/__tests__/pricing.test.ts dashboard/src/lib/venice/__tests__/cost-estimator.test.ts
git commit -m "feat: add venice pricing estimator"
```

---

### Task 7: Non-Streaming Chat Proxy And Settlement

**Files:**
- Create: `dashboard/src/lib/venice/proxy-settlement.ts`
- Create: `dashboard/src/lib/venice/__tests__/proxy-settlement.test.ts`
- Create: `dashboard/src/app/api/managed-venice/v1/chat/completions/route.ts`
- Create: `dashboard/src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts`

- [ ] **Step 1: Write failing settlement tests**

Cover:

- no proxy key -> 401,
- revoked proxy key -> 401,
- unknown model -> 400 before reservation,
- insufficient balance -> 402 before upstream call,
- successful non-streaming call reserves, forwards, captures actual usage, releases unused reservation,
- upstream 500 with no usage releases full reservation,
- upstream response with billable usage captures charged portion,
- missing usage creates reconciliation item and pauses key.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/venice/__tests__/proxy-settlement.test.ts src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts --runInBand
```

Expected: FAIL.

- [ ] **Step 3: Implement settlement orchestrator**

Export:

```ts
export async function reserveManagedVeniceChatRequest(input): Promise<ReservationResult>;
export async function captureManagedVeniceChatUsage(input): Promise<CaptureResult>;
export async function releaseManagedVeniceChatReservation(input): Promise<void>;
export async function markManagedVeniceReconciliationRequired(input): Promise<void>;
```

Every state transition writes a financial event.

- [ ] **Step 4: Implement route**

Route behavior:

- accepts OpenAI/Venice-compatible chat-completion JSON,
- requires `Authorization: Bearer hven_live_...`,
- rejects `stream: true` with a clear error until Task 8,
- injects server-side Venice key,
- sets `stream_options.include_usage = true` only when streaming is supported,
- forwards to `https://api.venice.ai/api/v1/chat/completions`,
- returns Venice response body/status after settlement.

- [ ] **Step 5: Add structured logging**

Use existing logger style. Include safe fields:

- request ID,
- proxy key ID,
- user ID,
- wallet type,
- model,
- estimated/reserved/actual microdollars,
- discount microdollars,
- reservation ID,
- settlement status,
- upstream status.

Never log prompts, API keys, or full response bodies.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/venice/__tests__/proxy-settlement.test.ts src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/venice/proxy-settlement.ts dashboard/src/lib/venice/__tests__/proxy-settlement.test.ts dashboard/src/app/api/managed-venice/v1/chat/completions
git commit -m "feat: proxy managed venice chat completions"
```

---

### Task 8: Streaming Chat Proxy

**Files:**
- Modify: `dashboard/src/app/api/managed-venice/v1/chat/completions/route.ts`
- Modify: `dashboard/src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts`
- Modify: `dashboard/src/lib/venice/proxy-settlement.ts`
- Modify: `dashboard/src/lib/venice/__tests__/proxy-settlement.test.ts`

- [ ] **Step 1: Write failing streaming tests**

Cover:

- request with `stream: true` forwards as stream,
- route forces `stream_options.include_usage = true`,
- final usage chunk captures actual cost,
- upstream stream error releases or reconciles based on billable usage presence,
- client disconnect marks reservation released if Venice was not charged or reconciliation-required if status unknown.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts src/lib/venice/__tests__/proxy-settlement.test.ts --runInBand
```

Expected: FAIL.

- [ ] **Step 3: Implement streaming transform**

Use `TransformStream` to pass chunks through while parsing SSE frames for final `usage`. Keep parsing defensive and never buffer full prompt/response bodies.

- [ ] **Step 4: Implement unknown-final-usage reconciliation**

If the stream ends without usage:

- pause proxy key for spend,
- write reconciliation item,
- return stream to client as received,
- alert via structured log.

- [ ] **Step 5: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts src/lib/venice/__tests__/proxy-settlement.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/app/api/managed-venice/v1/chat/completions dashboard/src/lib/venice/proxy-settlement.ts dashboard/src/lib/venice/__tests__/proxy-settlement.test.ts
git commit -m "feat: support managed venice streaming settlement"
```

---

### Task 9: Wallet Summary API And Dashboard UI

**Files:**
- Create: `dashboard/src/app/api/billing/managed-venice/summary/route.ts`
- Create: `dashboard/src/components/billing/ManagedVeniceWalletPanel.tsx`
- Create: `dashboard/src/components/billing/ManagedVeniceKeysPanel.tsx`
- Create: `dashboard/src/components/billing/ManagedVeniceSubsidyBanner.tsx`
- Create: `dashboard/src/components/billing/__tests__/ManagedVeniceWalletPanel.test.tsx`
- Create: `dashboard/src/components/billing/__tests__/ManagedVeniceKeysPanel.test.tsx`
- Modify: `dashboard/src/app/dashboard/billing/page.tsx`

- [ ] **Step 1: Write failing component tests**

Cover:

- renders $HermesOS token balance and locked Venice value side by side with card credits,
- shows cap usage like `Launch wave subsidy: $187 of $250 used`,
- shows 20% nudge when eligible,
- shows 10% text after cap/kill-switch step-down,
- key panel shows prefix only and never plaintext except creation response.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/billing/__tests__/ManagedVeniceWalletPanel.test.tsx src/components/billing/__tests__/ManagedVeniceKeysPanel.test.tsx --runInBand
```

Expected: FAIL.

- [ ] **Step 3: Implement summary route**

Return:

```ts
{
  wallets: {
    hermesos: { tokenDisplay, lockedValueMicroUsd, lots },
    card: { balanceMicroUsd }
  },
  discount: { rate, discountBps, launchSubsidyUsedMicroUsd, launchSubsidyCapMicroUsd },
  killSwitch: { active, weeklySubsidyUsedMicroUsd, thresholdMicroUsd },
  keys: [{ id, prefix, status, createdAt, lastUsedAt }]
}
```

- [ ] **Step 4: Implement focused components**

Keep new UI in components and pass data from `BillingPageContent`. Do not add another large inline panel directly inside `page.tsx`.

- [ ] **Step 5: Wire billing page**

Load `/api/billing/managed-venice/summary` alongside existing billing data. Render below current credit/top-up controls.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/billing/__tests__/ManagedVeniceWalletPanel.test.tsx src/components/billing/__tests__/ManagedVeniceKeysPanel.test.tsx --runInBand
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/app/api/billing/managed-venice/summary dashboard/src/components/billing/ManagedVeniceWalletPanel.tsx dashboard/src/components/billing/ManagedVeniceKeysPanel.tsx dashboard/src/components/billing/ManagedVeniceSubsidyBanner.tsx dashboard/src/components/billing/__tests__/ManagedVeniceWalletPanel.test.tsx dashboard/src/components/billing/__tests__/ManagedVeniceKeysPanel.test.tsx dashboard/src/app/dashboard/billing/page.tsx
git commit -m "feat: add managed venice wallet dashboard"
```

---

### Task 10: Observability, Activity, And Ops Runbook

**Files:**
- Modify: `dashboard/src/lib/billing/activity.ts`
- Modify: `dashboard/src/lib/ops/account-deletion.ts`
- Create: `dashboard/src/app/api/ops/managed-venice/subsidy/route.ts`
- Create: `dashboard/src/app/api/ops/managed-venice/subsidy/__tests__/route.test.ts`
- Create: `dashboard/docs/managed-venice-runbook.md`
- Modify: `dashboard/README.md`

- [ ] **Step 1: Write failing observability tests**

Cover:

- aggregate daily subsidy burn,
- top 10 users by subsidy received,
- weekly kill-switch 50%/80% threshold flags,
- per-user `$150` weekly subsidy alert,
- account deletion removes managed Venice rows in safe order.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/app/api/ops/managed-venice/subsidy/__tests__/route.test.ts src/lib/ops/__tests__/account-deletion.test.ts --runInBand
```

Expected: FAIL.

- [ ] **Step 3: Implement ops subsidy route**

Protect with `CRON_SECRET` or existing ops auth pattern. Return:

- daily burn,
- weekly burn,
- top spenders,
- users over $150/week,
- kill switch alert state,
- model spend distribution.

- [ ] **Step 4: Extend billing activity**

Add managed Venice usage and financial events to `getBillingActivity` without removing existing credit/compute/LLM sections.

- [ ] **Step 5: Extend account deletion**

Delete or anonymize in safe order:

1. reservations,
2. usage events,
3. reconciliation items,
4. proxy keys,
5. token lots,
6. card ledger entries,
7. wallet accounts,
8. financial events only if legal policy allows deletion; otherwise anonymize `user_id`.

- [ ] **Step 6: Write runbook**

Include:

- Venice server key rotation,
- proxy key compromise response,
- weekly kill-switch action,
- reconciliation queue handling,
- treasury reserve check,
- legal review checklist before public launch.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/app/api/ops/managed-venice/subsidy/__tests__/route.test.ts src/lib/ops/__tests__/account-deletion.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/lib/billing/activity.ts dashboard/src/lib/ops/account-deletion.ts dashboard/src/app/api/ops/managed-venice/subsidy dashboard/docs/managed-venice-runbook.md dashboard/README.md
git commit -m "feat: add managed venice observability"
```

---

### Task 11: Final Verification

**Files:**
- Review all files changed by Tasks 1-10.

- [ ] **Step 1: Run managed Venice test set**

Run:

```bash
cd dashboard
npm test -- --runTestsByPath \
  src/lib/billing/__tests__/microdollars.test.ts \
  src/lib/billing/__tests__/managed-venice-wallets.test.ts \
  src/lib/billing/__tests__/managed-venice-discounts.test.ts \
  src/lib/billing/__tests__/managed-venice-token-quotes.test.ts \
  src/lib/venice/__tests__/pricing.test.ts \
  src/lib/venice/__tests__/cost-estimator.test.ts \
  src/lib/venice/__tests__/proxy-keys.test.ts \
  src/lib/venice/__tests__/proxy-settlement.test.ts \
  src/app/api/managed-venice/keys/__tests__/route.test.ts \
  src/app/api/managed-venice/v1/chat/completions/__tests__/route.test.ts \
  src/app/api/billing/managed-venice/hermesos/quote/__tests__/route.test.ts \
  src/components/billing/__tests__/ManagedVeniceWalletPanel.test.tsx \
  src/components/billing/__tests__/ManagedVeniceKeysPanel.test.tsx \
  --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `cd dashboard && npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Run lint**

Run: `cd dashboard && npm run lint`

Expected: PASS.

- [ ] **Step 4: Run build**

Run: `cd dashboard && npm run build`

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

With safe test env vars:

1. Create a managed Venice proxy key.
2. Create a $HermesOS quote with fake/injected test price in non-prod.
3. Settle quote into a token lot.
4. Send non-streaming chat completion through the proxy with mocked Venice upstream.
5. Confirm reservation captured actual usage and released unused balance.
6. Confirm wallet UI shows deduction and subsidy cap usage.

- [ ] **Step 6: Commit final verification docs if changed**

```bash
git add <only-files-changed-during-verification>
git commit -m "docs: update managed venice verification notes"
```

---

## Implementation Notes

- Fail closed whenever price, model, wallet, reservation, or usage state is unknown.
- Do not reuse the existing `credit_ledger_entries` table for $HermesOS lots; it is cent/credit-oriented and would blur the token/card boundary.
- Do not proxy endpoints without a tested cost estimator.
- Do not log prompts, completions, user files, API keys, or full upstream bodies.
- Keep every task small enough to commit independently.
- Public launch remains blocked until legal/accounting review and runbook review are complete.

## Plain English Summary

Build the money machinery first, then the proxy, then the dashboard. The safest path is to make HermesOS reserve a little more than the worst-case Venice cost before every managed request, then settle the exact cost afterward. If anything about pricing, balance, or usage accounting is unclear, the proxy should stop instead of guessing.
