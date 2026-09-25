/**
 * Security review 2026-09 (#166/#167): Responses holds after a 200 were filed
 * for an operator and captured at a flat estimate a day later (or, for a
 * client cancel or a broken stream, never settled at all), and a refused
 * request whose release failed was charged once its hold expired.
 *
 * Runs the real route, authorize, reservation, settlement and sweep code
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

const responsesBody = { model: "claude-opus-4-8", input: "write a long story", stream: true, max_output_tokens: 60_000 };

function makeReq(body: Record<string, unknown> = responsesBody, signal?: AbortSignal) {
  return new Request("http://localhost/api/managed-venice/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer hven_live_fixture" },
    body: JSON.stringify(body),
    signal,
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

const delta = (text: string) =>
  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`;

// A Venice stream that sends one chunk every couple of milliseconds, so
// events keep arriving after the client has gone, then ends. (Well inside the
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

async function settleMicrotasks() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
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

function lotValue() {
  return mockMemory.tables.managed_venice_token_lots[0].remaining_value_micro_usd;
}

describe("managed Venice Responses: every hold after a 200 is settled in the request", () => {
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

  it("charges the output read when the client cancels and Venice never sends the terminal event", async () => {
    const FRAMES = 200;
    const upstream = openUpstreamStream(Array.from({ length: FRAMES }, () => delta("abcd")));
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq());
    expect(response.status).toBe(200);
    const meta = reservation().metadata as Record<string, number>;
    const client = response.body!.getReader();
    for (let read = 0; read < FRAMES; read += 1) await client.read();
    await client.cancel();
    // Venice is still read after the client leaves, up to the route deadline.
    expect(upstream.wasCancelled()).toBe(false);
    await waitFor(() => reservation().status !== "active");

    const expected = meta.inputEstimateMicroUsd + FRAMES * OUTPUT_MICRO_USD_PER_TOKEN;
    expect(reservation()).toMatchObject({ status: "captured", captured_micro_usd: expected });
    expect(lotValue()).toBe(BALANCE - expected);
    expect(mockMemory.tables.managed_venice_usage_events).toEqual([
      expect.objectContaining({
        endpoint: "/api/v1/responses",
        charged_micro_usd: expected,
        metadata: expect.objectContaining({ pricingPolicy: "managed_venice_observed_output_capture" }),
      }),
    ]);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
    expect(upstream.wasCancelled()).toBe(true);
  });

  // A request abort is the client leaving: Venice is still read, here to the
  // route's deadline, since its terminal event never comes.
  it("keeps reading after the request aborts and charges the output read at the deadline", async () => {
    const upstream = openUpstreamStream([delta("abcd"), delta("abcd"), delta("abcd")]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );
    const abort = new AbortController();

    const response = await POST(makeReq(responsesBody, abort.signal));
    const meta = reservation().metadata as Record<string, number>;
    const client = response.body!.getReader();
    for (let read = 0; read < 3; read += 1) await client.read();
    abort.abort();
    expect(upstream.wasCancelled()).toBe(false);
    await waitFor(() => reservation().status !== "active");

    expect(reservation()).toMatchObject({
      status: "captured",
      captured_micro_usd: meta.inputEstimateMicroUsd + 3 * OUTPUT_MICRO_USD_PER_TOKEN,
    });
    expect(mockMemory.tables.managed_venice_usage_events[0].metadata).toMatchObject({
      observedOutput: expect.objectContaining({ cause: "client_cancelled", observedOutputTokens: 3 }),
    });
    expect(upstream.wasCancelled()).toBe(true);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  // #167 second review (HIGH): Responses reasoning is encrypted, never
  // streamed as text. A client that closed the socket after the first line
  // paid for that line; Venice billed every reasoning token.
  it("keeps reading Venice after the client cancels and charges the terminal usage, reasoning included", async () => {
    const usage = { input_tokens: 40, output_tokens: 20_010, output_tokens_details: { reasoning_tokens: 20_000 } };
    const upstream = pacedUpstreamStream([
      delta("42"),
      ...Array.from({ length: 10 }, () => delta(" filler")),
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage } })}\n\n`,
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq());
    const client = response.body!.getReader();
    await client.read();
    await client.cancel();
    await waitFor(() => reservation().status !== "active");

    const exact = calculateActualChatCost({ model: "claude-opus-4-8", promptTokens: 40, completionTokens: 20_010 }).actualCostMicroUsd;
    expect(reservation()).toMatchObject({ status: "captured", captured_micro_usd: exact });
    expect(lotValue()).toBe(BALANCE - exact);
    expect(upstream.sent()).toBe(12);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("charges the output streamed when the stream breaks mid-generation", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          // Two deltas reach the route, then the socket drops.
          pull(controller) {
            pulls += 1;
            if (pulls <= 2) controller.enqueue(encoder.encode(delta("abcd")));
            else controller.error(new Error("socket reset"));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const response = await POST(makeReq());
    const meta = reservation().metadata as Record<string, number>;
    await response.text().catch(() => undefined);
    await settleMicrotasks();

    expect(reservation()).toMatchObject({
      status: "captured",
      captured_micro_usd: meta.inputEstimateMicroUsd + 2 * OUTPUT_MICRO_USD_PER_TOKEN,
    });
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("files a failed release of a refused request for the sweep, which releases it", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow down" }), { status: 429 }));
    mockMemory.failNext({ table: "managed_venice_reservations", op: "update" });

    const response = await POST(makeReq());

    expect(response.status).toBe(429);
    const items = mockMemory.tables.managed_venice_reconciliation_items;
    expect(items).toEqual([
      expect.objectContaining({
        reason: "managed_venice_chat_release_failed",
        metadata: expect.objectContaining({ upstreamStatus: 429 }),
      }),
    ]);
    reservation().expires_at = new Date(Date.now() - 60_000).toISOString();
    items[0].created_at = new Date(Date.now() - 60 * 60_000).toISOString();

    await sweepStaleManagedVeniceReservations({}, mockMemory.db);

    expect(reservation().status).toBe("released");
    expect(lotValue()).toBe(BALANCE);
  });

  // #167 second review (MEDIUM): a 5xx left the hold active for a day, while
  // the chat route and the Worker released it; Codex retries a 5xx.
  it("releases the hold of a Venice 5xx at once", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));

    const response = await POST(makeReq());

    expect(response.status).toBe(502);
    expect(reservation().status).toBe("released");
    expect(lotValue()).toBe(BALANCE);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("leaves a dispatch whose outcome is unknown to an operator for an hour, then releases it", async () => {
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));

    const response = await POST(makeReq());

    expect(response.status).toBe(502);
    const items = mockMemory.tables.managed_venice_reconciliation_items;
    expect(items).toEqual([
      expect.objectContaining({
        reason: "managed_venice_responses_ambiguous_usage",
        metadata: expect.objectContaining({ cause: "dispatch_outcome_unknown" }),
      }),
    ]);
    items[0].created_at = new Date(Date.now() - 30 * 60_000).toISOString();
    await sweepStaleManagedVeniceReservations({}, mockMemory.db);
    expect(reservation().status).toBe("active");

    items[0].created_at = new Date(Date.now() - 61 * 60_000).toISOString();
    await sweepStaleManagedVeniceReservations({}, mockMemory.db);

    expect(reservation().status).toBe("released");
    expect(items[0].status).toBe("resolved");
    expect(lotValue()).toBe(BALANCE);
  });
});
