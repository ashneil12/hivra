/**
 * Security review 2026-09 (HIGH): a streamed chat completion must not become
 * free when the client disconnects.
 *
 * Runs the real route, reservation, settlement and stale-hold sweep code
 * against the in-memory ledger. Only the proxy-key lookup, live pricing and
 * Venice itself are faked. Once Venice has answered 200 the request is being
 * generated (and billed to Hivra), so a disconnect must leave the wallet hold
 * in place, or charge the observed usage, and the nightly sweep must not
 * release it afterwards.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceMemoryDb,
  type ManagedVeniceMemoryDb,
} from "@/test-utils/managed-venice-memory-db";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const STARTING_BALANCE_MICRO_USD = 5_000_000;

let mockMemory: ManagedVeniceMemoryDb;
const mockFetch = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: null,
  get supabaseAdmin() {
    return mockMemory.db;
  },
}));

jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: jest.fn(async () => ({
    id: "22222222-2222-4222-8222-222222222222",
    userId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    defaultWalletType: "hermesos",
  })),
}));

jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: jest.fn(async () => ({
    map: new Map(),
    source: "fallback",
    fetchedAt: Date.now(),
    liveModelCount: 0,
  })),
}));

import { POST } from "../route";
import { getManagedVeniceWalletSummary } from "@/lib/billing/managed-venice-wallets";
import { sweepStaleManagedVeniceReservations } from "@/lib/venice/reservation-sweep";

const requestBody = {
  model: "venice-uncensored-1-2",
  messages: [{ role: "user", content: "write a long story" }],
  max_completion_tokens: 2_000,
  stream: true,
};

function makeReq() {
  return new Request("http://localhost/api/managed-venice/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer hven_live_fixture" },
    body: JSON.stringify(requestBody),
  }) as unknown as NextRequest;
}

function openUpstreamStream(chunks: string[]) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

async function settleMicrotasks() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function reservation() {
  const rows = mockMemory.tables.managed_venice_reservations;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("managed Venice chat stream: client disconnect after upstream 200", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.VENICE_API_KEY = "venice_fixture_upstream_key";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    global.fetch = mockFetch as unknown as typeof fetch;
    mockMemory = createManagedVeniceMemoryDb({
      managed_venice_reservations: [],
      managed_venice_card_ledger_entries: [],
      managed_venice_usage_events: [],
      managed_venice_proxy_keys: [{ id: KEY_ID, user_id: USER_ID, status: "active" }],
      managed_venice_token_lots: [
        {
          id: "lot_1",
          user_id: USER_ID,
          status: "active",
          source: "hermesos_deposit",
          remaining_value_micro_usd: STARTING_BALANCE_MICRO_USD,
          remaining_token_amount_raw: "5000000000000000000",
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.VENICE_API_KEY;
    jest.restoreAllMocks();
  });

  it("keeps the hold, files an item the sweep will not release, and never refunds", async () => {
    const upstream = openUpstreamStream(['data: {"choices":[{"delta":{"content":"Once"}}]}\n\n']);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq());
    expect(response.status).toBe(200);
    const held = Number(reservation().reserved_micro_usd);
    expect(held).toBeGreaterThan(0);

    const client = response.body!.getReader();
    await client.read();
    await client.cancel();
    await settleMicrotasks();

    expect(reservation()).toMatchObject({ status: "active", reserved_micro_usd: held });
    const summary = await getManagedVeniceWalletSummary(USER_ID, mockMemory.db);
    expect(summary.hermesos.availableMicroUsd).toBe(STARTING_BALANCE_MICRO_USD - held);

    const items = mockMemory.tables.managed_venice_reconciliation_items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      user_id: USER_ID,
      proxy_key_id: KEY_ID,
      status: "open",
      reason: "managed_venice_chat_stream_cancelled",
      metadata: expect.objectContaining({
        referenceId: reservation().reference_id,
        cause: "client_cancelled",
      }),
    });
    // The key is not paused: an interrupted turn is not unpaid usage.
    expect(mockMemory.tables.managed_venice_proxy_keys[0].status).toBe("active");
    expect(upstream.wasCancelled()).toBe(true);

    // The stale-hold sweep releases holds for telemetry gaps. It must leave
    // this one for an operator, or the refund just arrives six hours later.
    const swept = await sweepStaleManagedVeniceReservations({ ageHours: 0 }, mockMemory.db);
    expect(swept.releasedReservations).toBe(0);
    expect(reservation().status).toBe("active");
    expect(items[0].status).toBe("open");
  });

  it("charges the observed usage when the client disconnects after the usage frame", async () => {
    const upstream = openUpstreamStream([
      'data: {"choices":[{"delta":{"content":"Once"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":900}}\n\n',
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq());
    const client = response.body!.getReader();
    let seen = "";
    while (!seen.includes('"usage"')) {
      const next = await client.read();
      if (next.done) break;
      seen += new TextDecoder().decode(next.value);
    }
    await client.cancel();
    await settleMicrotasks();

    const row = reservation();
    expect(row.status).toBe("captured");
    const captured = Number(row.captured_micro_usd);
    expect(captured).toBeGreaterThan(0);
    const summary = await getManagedVeniceWalletSummary(USER_ID, mockMemory.db);
    expect(summary.hermesos.totalValueMicroUsd).toBe(STARTING_BALANCE_MICRO_USD - captured);
    expect(mockMemory.tables.managed_venice_usage_events).toHaveLength(1);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });
});
