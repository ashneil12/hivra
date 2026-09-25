/**
 * @jest-environment node
 *
 * Settling a hold without Venice's usage, and settling one twice (security
 * review 2026-09, #167). Runs the real reservation, capture, release,
 * reconciliation and sweep code against the in-memory ledger.
 */

let mockDb: unknown = null;
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));
jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: jest.fn(async () => ({ map: new Map(), source: "fallback", liveModelCount: 0 })),
}));

import {
  captureManagedVeniceChatUsage,
  captureManagedVeniceObservedOutput,
  releaseManagedVeniceChatReservationOrFile,
  reserveManagedVeniceChatRequest,
} from "@/lib/venice/proxy-settlement";
import { settleManagedVeniceChatUsage } from "@/lib/venice/proxy-chat-core";
import { sweepStaleManagedVeniceReservations } from "@/lib/venice/reservation-sweep";
import {
  createManagedVeniceSpendWorld,
  type ManagedVeniceSpendWorld,
} from "@/test-utils/managed-venice-spend-world";

const USER = "user_observed";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const MODEL = "claude-opus-4-8"; // $6 / $30 per million tokens

let world: ManagedVeniceSpendWorld;

beforeEach(() => {
  world = createManagedVeniceSpendWorld();
  mockDb = null;
  world.insertRow("managed_venice_proxy_keys", { id: KEY_ID, user_id: USER, status: "active" });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function reserve(referenceId: string, walletType: "card" | "hermesos", maxTokens = 10_000) {
  return reserveManagedVeniceChatRequest(
    {
      userId: USER,
      proxyKeyId: KEY_ID,
      walletType,
      referenceId,
      requestBody: { model: MODEL, messages: [{ role: "user", content: "x".repeat(300) }], max_completion_tokens: maxTokens },
    },
    world.db
  );
}

function hold(referenceId: string) {
  const row = world.reservations().find((reservation) => reservation.reference_id === referenceId);
  if (!row) throw new Error(`no hold ${referenceId}`);
  return row;
}

function lotValue() {
  return world.tables.managed_venice_token_lots.reduce((sum, lot) => sum + Number(lot.remaining_value_micro_usd), 0);
}

describe("a chat hold records what prices its observed output", () => {
  it("records the input estimate and the output price with the hold", async () => {
    world.fundCard(USER, 1_000_000);
    await reserve("ref_meta", "card");

    // 300 characters of input: 100 tokens at $6 per million.
    expect(hold("ref_meta").metadata).toMatchObject({
      inputEstimateMicroUsd: 600,
      outputMicroUsdPerMillion: 30_000_000,
    });
  });
});

describe("captureManagedVeniceObservedOutput", () => {
  const observed = (referenceId: string, tokens: number) =>
    captureManagedVeniceObservedOutput(
      {
        userId: USER,
        proxyKeyId: KEY_ID,
        referenceId,
        model: MODEL,
        upstreamStatus: 200,
        observedOutputTokens: tokens,
        cause: "client_cancelled",
        reconciliationReason: "managed_venice_chat_stream_cancelled",
        source: "test",
      },
      world.db
    );

  it("charges input estimate plus observed output once, and a repeat moves nothing", async () => {
    world.fundHermesos(USER, 1_000_000);
    await reserve("ref_obs", "hermesos");

    const first = await observed("ref_obs", 2_000);
    const again = await observed("ref_obs", 2_000);

    expect(first).toEqual({ outcome: "captured", chargedMicroUsd: 600 + 60_000 });
    expect(again).toEqual({ outcome: "already_settled", chargedMicroUsd: 0 });
    expect(hold("ref_obs")).toMatchObject({ status: "captured", captured_micro_usd: 60_600 });
    expect(lotValue()).toBe(1_000_000 - 60_600);
    expect(world.usageEvents()).toHaveLength(1);
  });

  it("never charges more than the hold", async () => {
    world.fundCard(USER, 1_000_000);
    await reserve("ref_cap", "card", 1_000);

    const result = await observed("ref_cap", 50_000);

    expect(result.chargedMicroUsd).toBe(Number(hold("ref_cap").reserved_micro_usd));
  });

  it("files the observed output when the charge cannot be written, and the sweep charges the same amount", async () => {
    world.fundCard(USER, 1_000_000);
    await reserve("ref_filed", "card");
    world.failNext({ table: "capture_managed_venice_reservation", op: "rpc" });

    const result = await observed("ref_filed", 2_000);

    expect(result.outcome).toBe("filed_for_sweep");
    expect(hold("ref_filed").status).toBe("active");
    const [item] = world.tables.managed_venice_reconciliation_items;
    expect(item).toMatchObject({
      reason: "managed_venice_chat_stream_cancelled",
      metadata: expect.objectContaining({ referenceId: "ref_filed", observedOutputTokens: 2_000 }),
    });

    item.created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    await sweepStaleManagedVeniceReservations({}, world.db);

    expect(hold("ref_filed")).toMatchObject({ status: "captured", captured_micro_usd: 60_600 });
    expect(world.cardBalanceMicroUsd(USER)).toBe(1_000_000 - 60_600);
  });
});

describe("captureManagedVeniceChatUsage on a hold that is already settled", () => {
  // #167 review: a retried settle captured nothing but still debited the
  // overage again from a token wallet (a card wallet raised a duplicate-key
  // error instead). The Worker now retries settles until it gets a 2xx.
  it("debits the overage once when the same usage is settled twice", async () => {
    world.fundHermesos(USER, 5_000_000);
    await reserve("ref_retry", "hermesos", 1_000);
    const held = Number(hold("ref_retry").reserved_micro_usd);
    const settle = () =>
      captureManagedVeniceChatUsage(
        {
          userId: USER,
          proxyKeyId: KEY_ID,
          walletType: "hermesos",
          referenceId: "ref_retry",
          model: MODEL,
          upstreamStatus: 200,
          // 10,000 output tokens is $0.30, well past the 1,000-token hold.
          usage: { prompt_tokens: 100, completion_tokens: 10_000 },
        },
        world.db
      );

    const first = await settle();
    const second = await settle();

    // The wallet paid Venice's cost once: the hold, plus the overage once.
    const actual = 600 + 300_000;
    expect(lotValue()).toBe(5_000_000 - actual);
    expect(world.usageEvents()).toHaveLength(1);
    expect(first).toMatchObject({ overageStatus: "captured", overageMicroUsd: actual - held });
    expect(second).toMatchObject({ alreadySettled: true, chargedMicroUsd: 0 });
  });
});

describe("releaseManagedVeniceChatReservationOrFile", () => {
  const release = () =>
    releaseManagedVeniceChatReservationOrFile(
      { userId: USER, proxyKeyId: KEY_ID, referenceId: "ref_rel", cause: "upstream_non_2xx", upstreamStatus: 429, source: "test" },
      world.db
    );

  it("files a failed release for the sweep", async () => {
    world.fundCard(USER, 1_000_000);
    await reserve("ref_rel", "card");
    world.failNext({ table: "managed_venice_reservations", op: "update" });

    expect(await release()).toEqual({ released: false, filed: true, failed: false });
    expect(world.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({
        reason: "managed_venice_chat_release_failed",
        metadata: expect.objectContaining({ referenceId: "ref_rel", upstreamStatus: 429 }),
      }),
    ]);
  });

  it("reports failure when neither the release nor the item could be written", async () => {
    world.fundCard(USER, 1_000_000);
    await reserve("ref_rel", "card");
    world.failNext({ table: "managed_venice_reservations", op: "update" });
    world.failNext({ table: "managed_venice_reconciliation_items", op: "insert" });

    expect(await release()).toEqual({ released: false, filed: false, failed: true });
    expect(hold("ref_rel").status).toBe("active");
  });
});

describe("settleManagedVeniceChatUsage (the Worker's settle)", () => {
  it("charges the output the Worker forwarded when the stream had no usage frame", async () => {
    world.fundCard(USER, 1_000_000);
    await reserve("ref_worker", "card");
    // The settle route passes no client: it uses the admin one.
    mockDb = world.db;
    {
      const result = await settleManagedVeniceChatUsage({
        userId: USER,
        proxyKeyId: KEY_ID,
        walletType: "card",
        referenceId: "ref_worker",
        model: MODEL,
        upstreamStatus: 200,
        usage: null,
        observedOutputTokens: 1_000,
        cause: "client_cancelled",
      });

      expect(result).toEqual({ settled: true, reconciled: false });
      expect(hold("ref_worker")).toMatchObject({ status: "captured", captured_micro_usd: 600 + 30_000 });
      expect(world.tables.managed_venice_reconciliation_items).toHaveLength(0);
    }
  });

  it("files a usage-less stream for the sweep when an older Worker sends no observed output", async () => {
    world.fundCard(USER, 1_000_000);
    await reserve("ref_old_worker", "card");
    mockDb = world.db;

    const result = await settleManagedVeniceChatUsage({
      userId: USER,
      proxyKeyId: KEY_ID,
      walletType: "card",
      referenceId: "ref_old_worker",
      model: MODEL,
      upstreamStatus: 200,
      usage: null,
    });

    expect(result).toEqual({ settled: false, reconciled: true });
    expect(hold("ref_old_worker").status).toBe("active");
    expect(world.tables.managed_venice_reconciliation_items).toEqual([
      expect.objectContaining({ reason: "managed_venice_missing_stream_usage" }),
    ]);
  });
});
