/**
 * Security review 2026-09 (#166/#167): the Anthropic shim charged a client
 * that disconnected mid-stream a flat estimate a day later (its enqueue threw
 * and it filed a missing-usage item), and a refused request whose release
 * failed was charged once its hold expired.
 *
 * Runs the real route, translator, reservation, settlement and sweep code
 * against the in-memory ledger; only the proxy-key lookup, live pricing and
 * Venice are faked.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceMemoryDb,
  type ManagedVeniceMemoryDb,
} from "@/test-utils/managed-venice-memory-db";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const BALANCE = 5_000_000;
// claude-opus-4-8 output: $30 per million tokens.
const OUTPUT_MICRO_USD_PER_TOKEN = 30;

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

// The route's 270 s deadline, shortened so a test can reach it.
jest.mock("@/lib/venice/hold-lifecycle", () => ({
  ...jest.requireActual("@/lib/venice/hold-lifecycle"),
  MANAGED_VENICE_STREAM_DEADLINE_MS: 400,
}));

import { POST } from "../route";
import { calculateActualChatCost } from "@/lib/venice/cost-estimator";
import { sweepStaleManagedVeniceReservations } from "@/lib/venice/reservation-sweep";

function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/managed-venice/anthropic/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "hven_live_fixture" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const messagesBody = {
  model: "claude-opus-4-8",
  max_tokens: 64_000,
  stream: true,
  messages: [{ role: "user", content: "write a long story" }],
};

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

const contentFrame = (text: string) =>
  `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: text } }] })}\n\n`;

// A Venice stream that sends one chunk every couple of milliseconds, so
// frames keep arriving after the client has gone, then ends. (Well inside the
// route deadline, which these tests shorten to 400 ms.)
function pacedUpstreamStream(chunks: string[]) {
  const encoder = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]));
      else controller.close();
    },
  });
  return { stream, sent: () => sent };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for the settlement");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function reservation() {
  const rows = mockMemory.tables.managed_venice_reservations;
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("managed Venice Anthropic shim: holds are settled in the request", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.VENICE_API_KEY = "venice_fixture_upstream_key";
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
    delete process.env.MANAGED_VENICE_SPEND_CAPS_ENABLED;
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
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
          remaining_value_micro_usd: BALANCE,
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

  it("charges the output read when the client disconnects and Venice never sends the usage frame", async () => {
    const FRAMES = 500;
    const upstream = openUpstreamStream(Array.from({ length: FRAMES }, () => contentFrame("abcd")));
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq(messagesBody));
    expect(response.status).toBe(200);
    const meta = reservation().metadata as Record<string, number>;
    const client = response.body!.getReader();
    let seen = "";
    while ((seen.match(/"type":"content_block_delta"/g) ?? []).length < FRAMES) {
      const next = await client.read();
      if (next.done) break;
      seen += new TextDecoder().decode(next.value);
    }
    await client.cancel();
    // Venice is still read after the client leaves, up to the route deadline.
    expect(upstream.wasCancelled()).toBe(false);
    await waitFor(() => reservation().status !== "active");

    const expected = meta.inputEstimateMicroUsd + FRAMES * OUTPUT_MICRO_USD_PER_TOKEN;
    expect(reservation()).toMatchObject({ status: "captured", captured_micro_usd: expected });
    expect(mockMemory.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(BALANCE - expected);
    expect(mockMemory.tables.managed_venice_usage_events).toEqual([
      expect.objectContaining({
        charged_micro_usd: expected,
        metadata: expect.objectContaining({ pricingPolicy: "managed_venice_observed_output_capture" }),
      }),
    ]);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
    expect(upstream.wasCancelled()).toBe(true);
  });

  // #167 second review (HIGH): a client that closed the socket after the
  // first line of a reasoning answer paid for the line it saw.
  it("keeps reading Venice after the client disconnects and charges the exact usage", async () => {
    const usage = { prompt_tokens: 30, completion_tokens: 20_000 };
    const upstream = pacedUpstreamStream([
      contentFrame("42"),
      ...Array.from({ length: 10 }, () => contentFrame(" filler")),
      `data: ${JSON.stringify({ id: "c1", choices: [], usage })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq(messagesBody));
    const client = response.body!.getReader();
    let seen = "";
    while (!seen.includes('"42"')) {
      const next = await client.read();
      if (next.done) break;
      seen += new TextDecoder().decode(next.value);
    }
    await client.cancel();
    await waitFor(() => reservation().status !== "active");

    const exact = calculateActualChatCost({
      model: "claude-opus-4-8",
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
    }).actualCostMicroUsd;
    expect(reservation()).toMatchObject({ status: "captured", captured_micro_usd: exact });
    expect(mockMemory.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(BALANCE - exact);
    expect(upstream.sent()).toBeGreaterThanOrEqual(12);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("files a failed release for the sweep, which releases the hold of a refused request", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );
    mockMemory.failNext({ table: "managed_venice_reservations", op: "update" });

    const response = await POST(makeReq(messagesBody));

    expect(response.status).toBe(429);
    const items = mockMemory.tables.managed_venice_reconciliation_items;
    expect(items).toEqual([
      expect.objectContaining({ reason: "managed_venice_chat_release_failed", status: "open" }),
    ]);
    reservation().expires_at = new Date(Date.now() - 60_000).toISOString();
    items[0].created_at = new Date(Date.now() - 60 * 60_000).toISOString();

    await sweepStaleManagedVeniceReservations({}, mockMemory.db);

    expect(reservation().status).toBe("released");
    expect(mockMemory.tables.managed_venice_token_lots[0].remaining_value_micro_usd).toBe(BALANCE);
    expect(mockMemory.tables.managed_venice_usage_events).toHaveLength(0);
  });

  it("charges, not releases, a 200 whose body cannot be parsed", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("<html>abcdabcdabcdabcd</html>", { status: 200, headers: { "Content-Type": "text/html" } })
    );

    const response = await POST(makeReq({ ...messagesBody, stream: false }));

    expect(response.status).toBe(502);
    const meta = reservation().metadata as Record<string, number>;
    // 29 bytes of body: 8 tokens.
    expect(reservation()).toMatchObject({
      status: "captured",
      captured_micro_usd: meta.inputEstimateMicroUsd + 8 * OUTPUT_MICRO_USD_PER_TOKEN,
    });
  });
});
