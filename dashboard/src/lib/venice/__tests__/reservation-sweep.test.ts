/**
 * @jest-environment node
 *
 * The stale-hold sweep runs the real wallet, reservation and media-gate code
 * against the in-memory ledger (security review 2026-09 follow-ups to #150 and
 * #160). A hold is captured when Venice answered 2xx, released only when the
 * request provably failed upstream, and never left to sit forever.
 */

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

import {
  createManagedVeniceReservation,
  getManagedVeniceWalletSummary,
} from "@/lib/billing/managed-venice-wallets";
import { holdManagedVeniceMediaSpend } from "@/lib/venice/media-spend-gate";
import { markManagedVeniceReconciliationRequired } from "@/lib/venice/proxy-settlement";
import {
  createManagedVeniceSpendWorld,
  type ManagedVeniceSpendWorld,
} from "@/test-utils/managed-venice-spend-world";
import {
  SWEEP_CAPTURE_REASONS,
  SWEEP_RELEASE_REASONS,
  pruneTerminalManagedVeniceReservations,
  sweepStaleManagedVeniceReservations,
} from "../reservation-sweep";

const USER = "user_sweep";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();
// The output price a chat hold records ($30 per million tokens).
const OUTPUT_MICRO_USD_PER_MILLION = 30_000_000;

let world: ManagedVeniceSpendWorld;

beforeEach(() => {
  world = createManagedVeniceSpendWorld();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MANAGED_VENICE_MULTIMODAL_MARKUP;
});

// A chat hold as reserveManagedVeniceChatRequest makes it: the estimate plus a
// 10% buffer is reserved, the bare estimate is recorded.
async function chatHold(
  referenceId: string,
  walletType: "card" | "hermesos",
  options: {
    estimate?: number;
    sweepEstimate?: number;
    expiresAt?: string | null;
    endpoint?: string;
    inputEstimate?: number;
  } = {}
) {
  const estimate = options.estimate ?? 100_000;
  await createManagedVeniceReservation(
    {
      userId: USER,
      walletType,
      amountMicroUsd: (estimate * 11) / 10,
      estimatedCostMicroUsd: estimate,
      referenceId,
      model: "deepseek-v4-flash",
      endpoint: options.endpoint ?? "/api/v1/chat/completions",
      metadata: {
        proxyKeyId: KEY_ID,
        ...(options.sweepEstimate === undefined ? {} : { sweepEstimateMicroUsd: options.sweepEstimate }),
        // What reserveManagedVeniceChatRequest records for pricing observed output.
        ...(options.inputEstimate === undefined
          ? {}
          : { inputEstimateMicroUsd: options.inputEstimate, outputMicroUsdPerMillion: OUTPUT_MICRO_USD_PER_MILLION }),
      },
      expiresAt: options.expiresAt ?? null,
    },
    world.db
  );
}

async function fileItem(
  referenceId: string,
  reason: string,
  options: { createdAt?: string; metadata?: Record<string, unknown> } = {}
) {
  await markManagedVeniceReconciliationRequired(
    {
      userId: USER,
      proxyKeyId: KEY_ID,
      referenceId,
      reason,
      pauseKey: false,
      metadata: { model: "deepseek-v4-flash", upstreamStatus: 200, ...options.metadata },
    },
    world.db
  );
  const items = world.tables.managed_venice_reconciliation_items;
  const item = items[items.length - 1];
  if (options.createdAt) item.created_at = options.createdAt;
  return item;
}

function hold(referenceId: string) {
  const row = world.reservations().find((reservation) => reservation.reference_id === referenceId);
  if (!row) throw new Error(`no hold ${referenceId}`);
  return row;
}

function captureEvents() {
  return world.tables.managed_venice_financial_events.filter((event) => event.event_type === "usage_capture");
}

describe("sweepStaleManagedVeniceReservations: holds after Venice answered 200", () => {
  // #150 review: a 200 stream that finished without a usage frame had its hold
  // released six hours later, so a client that could make Venice leave out the
  // usage frame got free inference.
  it.each([
    "managed_venice_missing_stream_usage",
    "managed_venice_stream_settlement_failed",
    "managed_venice_missing_usage",
    "managed_venice_anthropic_missing_usage",
    "managed_venice_anthropic_capture_failed",
    "managed_venice_anthropic_stream_capture_failed",
  ])("captures the pre-request estimate for %s instead of releasing the hold", async (reason) => {
    world.fundCard(USER, 1_000_000);
    await chatHold("ref_chat", "card");
    const item = await fileItem("ref_chat", reason, { metadata: { forwardedBytes: 4_096 } });

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold("ref_chat")).toMatchObject({ status: "captured", captured_micro_usd: 100_000, released_micro_usd: 10_000 });
    expect(world.cardBalanceMicroUsd(USER)).toBe(900_000);
    expect(summary).toMatchObject({ capturedReservations: 1, totalCapturedMicroUsd: 100_000, releasedReservations: 0 });
    expect(item).toMatchObject({ status: "resolved" });
    expect(item.metadata).toMatchObject({
      referenceId: "ref_chat",
      sweep: expect.objectContaining({ disposition: "captured_hold", basis: "pre_request_estimate", capturedMicroUsd: 100_000 }),
    });
    // The capture is on the books: a usage row and an immutable financial event.
    expect(world.usageEvents()).toEqual([
      expect.objectContaining({
        reference_id: "ref_chat",
        status: "recorded",
        endpoint: "/api/v1/chat/completions",
        model: "deepseek-v4-flash",
        wallet_type: "card",
        proxy_key_id: KEY_ID,
        charged_micro_usd: 100_000,
        actual_cost_micro_usd: 100_000,
        upstream_status: 200,
        metadata: expect.objectContaining({ pricingPolicy: "managed_venice_hold_sweep_capture" }),
      }),
    ]);
    expect(captureEvents()).toEqual([
      expect.objectContaining({
        reference_id: "ref_chat",
        amount_micro_usd: 100_000,
        idempotency_key: "managed_venice_hold_sweep_capture:ref_chat",
      }),
    ]);
  });

  // #167 review: a cancelled stream's hold sat until it expired (up to 48
  // hours with a daily sweep) and was then charged a flat estimate.
  it("captures a cancelled stream's hold at the output it observed, 15 minutes after the item", async () => {
    world.fundCard(USER, 10_000_000);
    await chatHold("ref_kept", "card", {
      estimate: 5_000_000,
      sweepEstimate: 120_000,
      inputEstimate: 2_000,
      expiresAt: new Date(Date.now() + 20 * HOUR_MS).toISOString(),
    });
    const item = await fileItem("ref_kept", "managed_venice_chat_stream_cancelled", {
      createdAt: hoursAgo(0.1),
      metadata: { cause: "client_cancelled", observedOutputTokens: 10_000 },
    });

    const early = await sweepStaleManagedVeniceReservations({}, world.db);
    expect(early.scanned).toBe(0);
    expect(hold("ref_kept").status).toBe("active");

    item.created_at = hoursAgo(0.3);
    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    // 2,000 input + 10,000 tokens at $30 per million: not the $0.12 estimate.
    expect(hold("ref_kept")).toMatchObject({ status: "captured", captured_micro_usd: 302_000 });
    expect(world.cardBalanceMicroUsd(USER)).toBe(9_698_000);
    expect(summary.results).toEqual([
      expect.objectContaining({ disposition: "captured_hold", basis: "observed_output", capturedMicroUsd: 302_000 }),
    ]);
    expect(item.status).toBe("resolved");
  });

  it("charges Venice's reported usage when only writing the charge failed", async () => {
    world.fundCard(USER, 10_000_000);
    await chatHold("ref_usage", "card", { estimate: 5_000_000, sweepEstimate: 120_000, inputEstimate: 2_000 });
    await fileItem("ref_usage", "managed_venice_stream_settlement_failed", {
      metadata: { cause: "settlement_failed", usageCostMicroUsd: 1_234_567, observedOutputTokens: 10 },
    });

    await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold("ref_usage")).toMatchObject({ status: "captured", captured_micro_usd: 1_234_567 });
    expect(world.cardBalanceMicroUsd(USER)).toBe(10_000_000 - 1_234_567);
  });

  it("charges a hold that recorded no output price its estimate, and a legacy cancelled stream without a day's wait", async () => {
    world.fundHermesos(USER, 1_000_000);
    await chatHold("ref_cancel", "hermesos");
    const item = await fileItem("ref_cancel", "managed_venice_chat_stream_cancelled", {
      createdAt: hoursAgo(2),
      metadata: { cause: "client_cancelled", forwardedBytes: 12 },
    });

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold("ref_cancel")).toMatchObject({ status: "captured", captured_micro_usd: 100_000 });
    expect(world.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(900_000);
    expect(summary.results).toEqual([expect.objectContaining({ basis: "pre_request_estimate" })]);
    expect(item.status).toBe("resolved");
  });

  // #167 review: Responses items filed after a 200 for any cause the sweep
  // did not list (client_cancelled, invalid_or_interrupted_stream) stayed
  // active for good.
  it.each([
    "client_cancelled",
    "invalid_or_interrupted_stream",
    "stream_aborted",
    "missing_terminal_usage",
    "invalid_response",
    "invalid_stream",
    "settlement_failed",
    "a_cause_added_later",
  ])("captures a Responses hold filed after a 200 (%s) at the output observed", async (cause) => {
    world.fundCard(USER, 10_000_000);
    await chatHold("ref_responses", "card", {
      endpoint: "/api/v1/responses",
      estimate: 5_000_000,
      inputEstimate: 1_000,
      expiresAt: new Date(Date.now() + 20 * HOUR_MS).toISOString(),
    });
    const item = await fileItem("ref_responses", "managed_venice_responses_ambiguous_usage", {
      createdAt: hoursAgo(0.5),
      metadata: { cause, observedOutputTokens: 100 },
    });

    await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold("ref_responses")).toMatchObject({ status: "captured", captured_micro_usd: 1_000 + 3_000 });
    expect(item.status).toBe("resolved");
  });

  it.each(["upstream_outcome_unknown", "dispatch_outcome_unknown"])(
    "leaves a Responses hold whose outcome is unknown (%s) until it expires, then releases it",
    async (cause) => {
      world.fundCard(USER, 1_000_000);
      await chatHold("ref_unknown", "card", {
        endpoint: "/api/v1/responses",
        expiresAt: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      });
      const item = await fileItem("ref_unknown", "managed_venice_responses_ambiguous_usage", {
        createdAt: hoursAgo(22),
        metadata: { cause },
      });

      await sweepStaleManagedVeniceReservations({}, world.db);
      expect(hold("ref_unknown").status).toBe("active");
      expect(item.status).toBe("open");

      hold("ref_unknown").expires_at = hoursAgo(0.1);
      item.created_at = hoursAgo(24.2);
      const summary = await sweepStaleManagedVeniceReservations({}, world.db);

      expect(hold("ref_unknown").status).toBe("released");
      expect(summary.results).toEqual([expect.objectContaining({ disposition: "released_unknown_outcome" })]);
      expect(item.status).toBe("resolved");
      expect(world.cardBalanceMicroUsd(USER)).toBe(1_000_000);
      expect(world.usageEvents()).toHaveLength(0);
    }
  );

  // #167 review: a chat request Venice refused whose in-request release
  // failed was captured once its hold expired.
  it("releases, never captures, a refused chat request whose release failed, even after the hold expired", async () => {
    world.fundHermesos(USER, 1_000_000);
    await chatHold("ref_refused", "hermesos", { expiresAt: hoursAgo(1) });
    const item = await fileItem("ref_refused", "managed_venice_chat_release_failed", {
      createdAt: hoursAgo(0.5),
      metadata: { cause: "upstream_non_2xx", upstreamStatus: 429 },
    });

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold("ref_refused").status).toBe("released");
    expect(summary).toMatchObject({ releasedReservations: 1, capturedReservations: 0 });
    expect(world.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(1_000_000);
    expect(item.status).toBe("resolved");
  });

  // #167 review: items filling the per-run budget left an expired orphan hold
  // unswept.
  it("sweeps expired holds on their own budget, whatever the items use", async () => {
    world.fundCard(USER, 10_000_000);
    for (const ref of ["ref_a", "ref_b", "ref_c"]) {
      await chatHold(ref, "card", { expiresAt: new Date(Date.now() + 20 * HOUR_MS).toISOString() });
      await fileItem(ref, "managed_venice_chat_stream_cancelled", { createdAt: hoursAgo(2) });
    }
    await chatHold("ref_orphan", "card", { expiresAt: hoursAgo(1) });

    await sweepStaleManagedVeniceReservations({ limit: 3 }, world.db);

    expect(hold("ref_orphan")).toMatchObject({ status: "captured", captured_micro_usd: 100_000 });
  });

  it("charges a sweep retry once, even when two sweeps run at the same time", async () => {
    world.fundCard(USER, 1_000_000);
    await chatHold("ref_twice", "card");
    await fileItem("ref_twice", "managed_venice_missing_stream_usage");

    const [first, second] = await Promise.all([
      sweepStaleManagedVeniceReservations({}, world.db),
      sweepStaleManagedVeniceReservations({}, world.db),
    ]);
    await sweepStaleManagedVeniceReservations({}, world.db);

    expect(first.capturedReservations + second.capturedReservations).toBe(1);
    expect(world.cardBalanceMicroUsd(USER)).toBe(900_000);
    expect(world.usageEvents()).toHaveLength(1);
    expect(captureEvents()).toHaveLength(1);
  });

  it("leaves the item open when the wallet can no longer cover the capture", async () => {
    world.fundHermesos(USER, 1_000_000);
    await chatHold("ref_void", "hermesos");
    const item = await fileItem("ref_void", "managed_venice_missing_stream_usage");
    world.tables.managed_venice_token_lots[0].status = "voided";

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(summary).toMatchObject({ capturedReservations: 0, failed: 1 });
    expect(hold("ref_void").status).toBe("active");
    expect(item.status).toBe("open");
    expect(world.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(1_000_000);
  });
});

describe("sweepStaleManagedVeniceReservations: media holds", () => {
  const NANO = { endpoint: "/api/v1/image/generate", model: "nano-banana-2", metadata: {} };
  const key = (walletType: "card" | "hermesos") => ({ id: KEY_ID, userId: USER, defaultWalletType: walletType });

  // #160 review: holds kept after a failed capture were never swept.
  it("captures a hold whose in-request capture failed, at the price Venice charged", async () => {
    world.fundCard(USER, 1_000_000);
    const gate = await holdManagedVeniceMediaSpend({ key: key("card"), operation: NANO, source: "test" }, world.db);
    if (!gate.ok) throw new Error("expected a hold");
    world.failNext({ table: "managed_venice_card_ledger_entries", op: "insert" });
    await gate.hold.complete({ ok: true, upstreamStatus: 200, upstreamRequestId: "req_img" });
    expect(hold(gate.hold.referenceId).status).toBe("active");

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    // Held at the 4K ceiling ($0.19), charged Venice's 1K default ($0.10).
    expect(hold(gate.hold.referenceId)).toMatchObject({ status: "captured", captured_micro_usd: 100_000 });
    expect(world.cardBalanceMicroUsd(USER)).toBe(900_000);
    expect(summary.capturedReservations).toBe(1);
    expect(world.usageEvents()).toEqual([
      expect.objectContaining({
        endpoint: "/api/v1/image/generate",
        model: "nano-banana-2",
        charged_micro_usd: 100_000,
        upstream_status: 200,
        status: "recorded",
      }),
    ]);
    expect(world.tables.managed_venice_reconciliation_items[0]).toMatchObject({
      reason: "managed_venice_media_capture_failed",
      status: "resolved",
    });
  });

  it("releases a hold whose in-request release failed after Venice refused the request", async () => {
    world.fundCard(USER, 1_000_000);
    const gate = await holdManagedVeniceMediaSpend({ key: key("card"), operation: NANO, source: "test" }, world.db);
    if (!gate.ok) throw new Error("expected a hold");
    world.failNext({ table: "managed_venice_reservations", op: "update" });
    await gate.hold.complete({ ok: false, upstreamStatus: 429 });
    expect(hold(gate.hold.referenceId).status).toBe("active");

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold(gate.hold.referenceId).status).toBe("released");
    expect(summary).toMatchObject({ releasedReservations: 1, capturedReservations: 0 });
    expect(world.cardBalanceMicroUsd(USER)).toBe(1_000_000);
    expect(world.usageEvents()).toHaveLength(0);
    expect(world.tables.managed_venice_reconciliation_items[0]).toMatchObject({
      reason: "managed_venice_media_release_failed",
      status: "resolved",
      metadata: expect.objectContaining({ upstreamStatus: 429 }),
    });
  });

  // #160 review: media holds had no expiry, so a function killed between the
  // hold and Venice's answer left the hold active for good.
  it("captures an expired media hold that has no outcome on record, at the price of the tier sent", async () => {
    world.fundHermesos(USER, 1_000_000);
    const gate = await holdManagedVeniceMediaSpend({ key: key("hermesos"), operation: NANO, source: "test" }, world.db);
    if (!gate.ok) throw new Error("expected a hold");
    expect(hold(gate.hold.referenceId).reserved_micro_usd).toBe(190_000);
    hold(gate.hold.referenceId).expires_at = hoursAgo(1);

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold(gate.hold.referenceId)).toMatchObject({ status: "captured", captured_micro_usd: 100_000 });
    expect(world.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(900_000);
    expect(summary.results).toEqual([
      expect.objectContaining({ disposition: "captured_expired_hold", basis: "catalog_price", capturedMicroUsd: 100_000 }),
    ]);
    const summaryAfter = await getManagedVeniceWalletSummary(USER, world.db);
    expect(summaryAfter.hermesos).toMatchObject({ totalValueMicroUsd: 900_000, reservedMicroUsd: 0 });
  });

  it("never captures an expired hold that an open item says to release or leave, nor a hold without an expiry", async () => {
    world.fundCard(USER, 1_000_000);
    // Venice refused this image and the in-request release failed; the item
    // is younger than the 15-minute window, and the one-hour hold has expired.
    const gate = await holdManagedVeniceMediaSpend({ key: key("card"), operation: NANO, source: "test" }, world.db);
    if (!gate.ok) throw new Error("expected a hold");
    world.failNext({ table: "managed_venice_reservations", op: "update" });
    await gate.hold.complete({ ok: false, upstreamStatus: 400 });
    world.tables.managed_venice_reconciliation_items[0].created_at = new Date().toISOString();
    hold(gate.hold.referenceId).expires_at = hoursAgo(0.5);
    // A Responses hold whose upstream outcome only an operator can judge,
    // with its item not yet a day old.
    await chatHold("ref_unknown", "card", { endpoint: "/api/v1/responses", expiresAt: hoursAgo(1) });
    await fileItem("ref_unknown", "managed_venice_responses_ambiguous_usage", {
      createdAt: hoursAgo(2),
      metadata: { cause: "dispatch_outcome_unknown" },
    });
    // A hold from before holds expired.
    await chatHold("ref_legacy", "card", { expiresAt: null });
    hold("ref_legacy").created_at = hoursAgo(24 * 90);

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold(gate.hold.referenceId).status).toBe("active");
    expect(hold("ref_unknown").status).toBe("active");
    expect(hold("ref_legacy").status).toBe("active");
    expect(summary).toMatchObject({ capturedReservations: 0, releasedReservations: 0, heldForOpenItem: 2 });
    expect(world.cardBalanceMicroUsd(USER)).toBe(1_000_000);
  });
});

describe("sweep scope", () => {
  it("captures after a 200, releases after a refusal, and never touches an overage item", () => {
    expect([...SWEEP_CAPTURE_REASONS]).toEqual([
      "managed_venice_missing_stream_usage",
      "managed_venice_stream_settlement_failed",
      "managed_venice_missing_usage",
      "managed_venice_anthropic_missing_usage",
      "managed_venice_anthropic_capture_failed",
      "managed_venice_anthropic_stream_capture_failed",
      "managed_venice_chat_stream_cancelled",
      "managed_venice_media_capture_failed",
    ]);
    expect([...SWEEP_RELEASE_REASONS]).toEqual([
      "managed_venice_media_release_failed",
      "managed_venice_chat_release_failed",
    ]);
    const all: string[] = [...SWEEP_CAPTURE_REASONS, ...SWEEP_RELEASE_REASONS];
    expect(all).not.toContain("managed_venice_overage_uncovered");
    // Responses items are decided by their cause (see the tests above).
    expect(all).not.toContain("managed_venice_responses_ambiguous_usage");
  });

  it("closes an item whose hold is gone or already settled without moving money", async () => {
    world.fundCard(USER, 1_000_000);
    await fileItem("ref_missing", "managed_venice_missing_stream_usage");
    const noReference = await fileItem("", "managed_venice_missing_usage");
    noReference.metadata = { model: "deepseek-v4-flash" };

    const summary = await sweepStaleManagedVeniceReservations({}, world.db);

    expect(summary.results.map((result) => result.disposition).sort()).toEqual([
      "missing_reference_id",
      "reservation_not_found",
    ]);
    expect(world.tables.managed_venice_reconciliation_items.map((item) => item.status)).toEqual(["ignored", "ignored"]);
    expect(world.cardBalanceMicroUsd(USER)).toBe(1_000_000);
  });
});

function createPruneDb(
  rows: Array<{ id: string; status: string; updated_at: string }>
) {
  const deleted: string[] = [];
  const db = {
    from: () => ({
      select: () => {
        const preds: Array<(r: { [k: string]: unknown }) => boolean> = [];
        const chain = {
          in: (col: string, vals: readonly string[]) => {
            preds.push((r) => vals.includes(r[col] as string));
            return chain;
          },
          lt: (col: string, val: string) => {
            preds.push((r) => String(r[col]) < val);
            return chain;
          },
          limit: async (n: number) => ({
            data: rows.filter((r) => preds.every((p) => p(r))).slice(0, n),
            error: null,
          }),
        };
        return chain;
      },
      delete: () => ({
        in: async (_col: string, ids: string[]) => {
          deleted.push(...ids);
          return { error: null };
        },
      }),
    }),
  };
  return { db, deleted };
}

describe("pruneTerminalManagedVeniceReservations", () => {
  it("deletes only terminal rows older than the retention window, never active holds", async () => {
    const old = "2026-01-01T00:00:00.000Z";
    const recent = new Date().toISOString();
    const rows = [
      { id: "r1", status: "released", updated_at: old },
      { id: "r2", status: "captured", updated_at: old },
      { id: "r3", status: "active", updated_at: old }, // active is never pruned
      { id: "r4", status: "released", updated_at: recent }, // inside retention window
    ];
    const { db, deleted } = createPruneDb(rows);

    const summary = await pruneTerminalManagedVeniceReservations(
      { retentionDays: 30, limit: 100 },
      db as unknown as Parameters<typeof pruneTerminalManagedVeniceReservations>[1]
    );

    expect(summary.pruned).toBe(2);
    expect(deleted.sort()).toEqual(["r1", "r2"]);
  });

  it("returns pruned:0 and issues no delete when nothing is old enough", async () => {
    const { db, deleted } = createPruneDb([
      { id: "r1", status: "released", updated_at: new Date().toISOString() },
    ]);
    const summary = await pruneTerminalManagedVeniceReservations(
      {},
      db as unknown as Parameters<typeof pruneTerminalManagedVeniceReservations>[1]
    );
    expect(summary.pruned).toBe(0);
    expect(deleted).toEqual([]);
  });
});
