/** @jest-environment node */
/**
 * getPendingYearlyTokenQuotes drives the "don't pay again" banner. It must not
 * depend on whether a concurrent read has flipped an expired quote yet, and it
 * must clear once a newer quote or the operator resolves the situation.
 */

import {
  createYearlyTokenMemoryDb,
  yearlyQuoteRow,
  type YearlyTokenMemoryDb,
} from "@/test-utils/yearly-token-memory-db";

const mockState: { memory: YearlyTokenMemoryDb | null } = { memory: null };

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockState.memory?.db ?? null;
  },
}));

import { getPendingYearlyTokenQuotes } from "@/lib/billing/yearly-token-quotes";

const MINUTE_MS = 60_000;
const NOW = new Date("2026-09-22T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function setup(quotes: Array<Record<string, unknown>>, items: Array<Record<string, unknown>> = []) {
  mockState.memory = createYearlyTokenMemoryDb({
    yearly_token_quotes: quotes.map((overrides) => yearlyQuoteRow(overrides)),
    yearly_token_reconciliation_items: items,
  });
}

async function pending() {
  return (await getPendingYearlyTokenQuotes("user_1", NOW)).map((quote) => [quote.id, quote.tier, quote.status]);
}

it("reports a quote whose countdown ended even before anything flipped it to 'expired'", async () => {
  setup([{ id: "yq_1", status: "active", quoted_at: at(-21 * MINUTE_MS), expires_at: at(-1 * MINUTE_MS) }]);

  expect(await pending()).toEqual([["yq_1", "pro", "expired"]]);
});

it("does not report a quote that can still be paid, or one past its late-payment grace", async () => {
  setup([
    { id: "yq_live", tier: "pro", status: "active", quoted_at: at(-5 * MINUTE_MS), expires_at: at(15 * MINUTE_MS) },
    { id: "yq_old", tier: "power", status: "expired", quoted_at: at(-200 * MINUTE_MS), expires_at: at(-180 * MINUTE_MS) },
  ]);

  expect(await pending()).toEqual([]);
});

it("reports a payment under review only while its review item is open", async () => {
  const review = { id: "yq_review", status: "manual_review", quoted_at: at(-60 * MINUTE_MS), expires_at: at(-40 * MINUTE_MS) };
  setup([review], [{ user_id: "user_1", quote_id: "yq_review", status: "open", reason: "underpaid" }]);
  expect(await pending()).toEqual([["yq_review", "pro", "manual_review"]]);

  setup([review], [{ user_id: "user_1", quote_id: "yq_review", status: "resolved", reason: "underpaid" }]);
  expect(await pending()).toEqual([]);
});

it("drops a quote once a newer quote for the same tier exists", async () => {
  setup(
    [
      { id: "yq_review", status: "manual_review", quoted_at: at(-60 * MINUTE_MS), expires_at: at(-40 * MINUTE_MS) },
      {
        id: "yq_paid",
        status: "consumed",
        consumed_tx_hash: "0xabc",
        quoted_at: at(-30 * MINUTE_MS),
        expires_at: at(-10 * MINUTE_MS),
      },
    ],
    [{ user_id: "user_1", quote_id: "yq_review", status: "open", reason: "underpaid" }]
  );

  expect(await pending()).toEqual([]);
});

it("keeps each tier's own newest quote", async () => {
  setup([
    { id: "yq_pro", tier: "pro", status: "expired", quoted_at: at(-30 * MINUTE_MS), expires_at: at(-10 * MINUTE_MS) },
    { id: "yq_power", tier: "power", status: "active", quoted_at: at(-5 * MINUTE_MS), expires_at: at(15 * MINUTE_MS) },
  ]);

  expect(await pending()).toEqual([["yq_pro", "pro", "expired"]]);
});

it("keeps an open review visible when a newer quote for the tier was abandoned", async () => {
  setup(
    [
      { id: "yq_review", status: "manual_review", quoted_at: at(-300 * MINUTE_MS), expires_at: at(-280 * MINUTE_MS) },
      { id: "yq_abandoned", status: "cancelled", quoted_at: at(-200 * MINUTE_MS), expires_at: at(-180 * MINUTE_MS) },
      { id: "yq_lapsed", status: "expired", quoted_at: at(-190 * MINUTE_MS), expires_at: at(-170 * MINUTE_MS) },
    ],
    [{ user_id: "user_1", quote_id: "yq_review", status: "open", reason: "late_payment" }]
  );

  expect(await pending()).toEqual([["yq_review", "pro", "manual_review"]]);
});
