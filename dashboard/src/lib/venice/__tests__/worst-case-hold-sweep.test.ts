/**
 * @jest-environment node
 *
 * #166 + #167: a chat hold covers the request's worst case (the model's whole
 * output maximum when no cap is sent, 128,000 tokens on claude-opus-4-8, or
 * the context window for an older Worker while pricing is the catalog's).
 * The stale-hold sweep must never charge that worst case. It charges what
 * the request path recorded (Venice's reported usage, or the input estimate
 * plus the output observed), and a hold nothing settled at all its input
 * estimate plus at most MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE output
 * tokens per choice.
 *
 * The holds here are made by the real #166 reservation path
 * (reserveManagedVeniceChatWithinBalance), so this proves the metadata the
 * sweep reads is recorded on the larger holds, not on a hand-built row.
 */

import type { ManagedVeniceSpendWorld } from "@/test-utils/managed-venice-spend-world";

let mockWorld: ManagedVeniceSpendWorld;

jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockWorld.db;
  },
}));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

import { reserveManagedVeniceChatWithinBalance, type ManagedVeniceChatProtocol } from "../chat-output-budget";
import { MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE } from "../hold-lifecycle";
import { VENICE_CHAT_MODEL_PRICES, type VeniceChatModelPrice } from "../pricing";
import { markManagedVeniceReconciliationRequired } from "../proxy-settlement";
import { sweepStaleManagedVeniceReservations } from "../reservation-sweep";
import { RESPONSES_RECONCILIATION_REASON } from "../responses-protocol";
import { createManagedVeniceSpendWorld } from "@/test-utils/managed-venice-spend-world";

const USER = "user_worst_case_sweep";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const OPUS = "claude-opus-4-8";
// claude-opus-4-8: $30 per million output tokens, 128,000 output maximum.
const OPUS_OUTPUT_MICRO_USD_PER_TOKEN = 30;
const USD = 1_000_000;
const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();

const livePricing = new Map<string, VeniceChatModelPrice>(
  VENICE_CHAT_MODEL_PRICES.map((entry) => [entry.model, { ...entry, maxOutputTokensSource: "venice_live" }])
);
const catalogPricing = new Map<string, VeniceChatModelPrice>(
  VENICE_CHAT_MODEL_PRICES.map((entry) => [entry.model, entry])
);

beforeEach(() => {
  mockWorld = createManagedVeniceSpendWorld();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function worstCaseHold(
  referenceId: string,
  options: {
    protocol?: ManagedVeniceChatProtocol;
    extra?: Record<string, unknown>;
    allowBodyRewrite?: boolean;
    pricingMap?: ReadonlyMap<string, VeniceChatModelPrice>;
  } = {}
) {
  const protocol = options.protocol ?? "chat";
  const body =
    protocol === "responses"
      ? { model: OPUS, input: "Write the word 'again' forever.", ...options.extra }
      : { model: OPUS, messages: [{ role: "user", content: "Write the word 'again' forever." }], ...options.extra };
  const budgeted = await reserveManagedVeniceChatWithinBalance({
    userId: USER,
    proxyKeyId: KEY_ID,
    walletType: "card",
    referenceId,
    protocol,
    body,
    pricingMap: options.pricingMap ?? livePricing,
    allowBodyRewrite: options.allowBodyRewrite ?? true,
    route: "/api/managed-venice/v1/chat/completions",
  });
  const row = mockWorld.reservations().find((reservation) => reservation.reference_id === referenceId);
  if (!row) throw new Error(`no hold ${referenceId}`);
  const meta = row.metadata as Record<string, number>;
  return { budgeted, row, held: Number(row.reserved_micro_usd), input: meta.inputEstimateMicroUsd };
}

async function fileItem(referenceId: string, reason: string, metadata: Record<string, unknown>) {
  await markManagedVeniceReconciliationRequired({
    userId: USER,
    proxyKeyId: KEY_ID,
    referenceId,
    reason,
    pauseKey: false,
    metadata: { model: OPUS, upstreamStatus: 200, ...metadata },
  });
  const items = mockWorld.tables.managed_venice_reconciliation_items;
  const item = items[items.length - 1];
  item.created_at = hoursAgo(0.5);
  return item;
}

describe("the stale-hold sweep on #166 worst-case holds", () => {
  it.each([
    ["one choice", {}, 1],
    ["n: 2", { n: 2 }, 2],
  ])(
    "an expired hold nothing settled (%s) is charged the input plus 4,096 output tokens per choice, not its worst case",
    async (_label, extra, choices) => {
      mockWorld.fundCard(USER, 20 * USD);
      const { budgeted, row, held, input } = await worstCaseHold("ref_orphan", { extra });
      expect(budgeted.outputCap).toBe(128_000);
      expect(held).toBeGreaterThanOrEqual(128_000 * choices * OPUS_OUTPUT_MICRO_USD_PER_TOKEN);
      row.expires_at = hoursAgo(1);

      const summary = await sweepStaleManagedVeniceReservations({});

      const charged = input + MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE * choices * OPUS_OUTPUT_MICRO_USD_PER_TOKEN;
      expect(charged * 20).toBeLessThan(held);
      expect(row).toMatchObject({ status: "captured", captured_micro_usd: charged });
      expect(summary.results).toEqual([
        expect.objectContaining({ disposition: "captured_expired_hold", basis: "pre_request_estimate", capturedMicroUsd: charged }),
      ]);
      expect(mockWorld.cardBalanceMicroUsd(USER)).toBe(20 * USD - charged);
    }
  );

  // An older Worker cannot be given a cap, so with a catalog maximum its hold
  // is bounded by the context window: about $33 on claude-opus-4-8.
  it("the largest hold, an older Worker's on catalog pricing, is still charged only the bounded estimate", async () => {
    mockWorld.fundCard(USER, 50 * USD);
    const { budgeted, row, held, input } = await worstCaseHold("ref_old_worker", {
      allowBodyRewrite: false,
      pricingMap: catalogPricing,
    });
    expect(budgeted.bodyPatch).toEqual({});
    expect(held).toBeGreaterThan(30 * USD);
    row.expires_at = hoursAgo(1);

    await sweepStaleManagedVeniceReservations({});

    const charged = input + MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE * OPUS_OUTPUT_MICRO_USD_PER_TOKEN;
    expect(row).toMatchObject({ status: "captured", captured_micro_usd: charged });
    expect(mockWorld.cardBalanceMicroUsd(USER)).toBe(50 * USD - charged);
  });

  it("a cancelled stream's item is charged the input plus the output it observed", async () => {
    mockWorld.fundCard(USER, 20 * USD);
    const { row, held, input } = await worstCaseHold("ref_cancelled");
    const item = await fileItem("ref_cancelled", "managed_venice_chat_stream_cancelled", {
      cause: "client_cancelled",
      observedOutputTokens: 10_000,
    });

    const summary = await sweepStaleManagedVeniceReservations({});

    const charged = input + 10_000 * OPUS_OUTPUT_MICRO_USD_PER_TOKEN;
    expect(charged).toBeLessThan(held);
    expect(row).toMatchObject({ status: "captured", captured_micro_usd: charged });
    expect(summary.results).toEqual([
      expect.objectContaining({ disposition: "captured_hold", basis: "observed_output", capturedMicroUsd: charged }),
    ]);
    expect(item.status).toBe("resolved");
    expect(mockWorld.cardBalanceMicroUsd(USER)).toBe(20 * USD - charged);
  });

  it("a settlement that failed after Venice reported usage is charged that usage", async () => {
    mockWorld.fundCard(USER, 20 * USD);
    const { row } = await worstCaseHold("ref_reported");
    await fileItem("ref_reported", "managed_venice_stream_settlement_failed", {
      cause: "settlement_failed",
      usageCostMicroUsd: 1_234_567,
      observedOutputTokens: 10,
    });

    await sweepStaleManagedVeniceReservations({});

    expect(row).toMatchObject({ status: "captured", captured_micro_usd: 1_234_567 });
    expect(mockWorld.cardBalanceMicroUsd(USER)).toBe(20 * USD - 1_234_567);
  });

  it("a Responses hold whose outcome is unknown is released after an hour, never charged its worst case", async () => {
    mockWorld.fundCard(USER, 20 * USD);
    const { row, held } = await worstCaseHold("ref_responses_unknown", { protocol: "responses" });
    expect(held).toBeGreaterThanOrEqual(128_000 * OPUS_OUTPUT_MICRO_USD_PER_TOKEN);
    const item = await fileItem("ref_responses_unknown", RESPONSES_RECONCILIATION_REASON, {
      cause: "dispatch_outcome_unknown",
    });
    item.created_at = hoursAgo(1.1);

    await sweepStaleManagedVeniceReservations({});

    expect(row.status).toBe("released");
    expect(mockWorld.cardBalanceMicroUsd(USER)).toBe(20 * USD);
    expect(mockWorld.usageEvents()).toHaveLength(0);
  });
});
