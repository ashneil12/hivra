/**
 * Security review 2026-09 (HIGH, #150, #166/#167): a streamed chat completion
 * must be charged for what Venice streamed, however the stream ends.
 *
 * Runs the real route, reservation, settlement and stale-hold sweep code
 * against the in-memory ledger. Only the proxy-key lookup, live pricing and
 * Venice itself are faked. Once Venice has answered 200 it is generating, and
 * billing Hivra, for the request, so the hold is never released. When the
 * usage frame never arrives the request charges its input estimate plus the
 * output it forwarded, at once, and gives the rest of the hold back.
 */
import { NextRequest } from "next/server";

import {
  createManagedVeniceMemoryDb,
  type ManagedVeniceMemoryDb,
} from "@/test-utils/managed-venice-memory-db";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const STARTING_BALANCE_MICRO_USD = 5_000_000;
// claude-opus-4-8 in the static catalog: $6 / $30 per million tokens.
const OPUS_OUTPUT_MICRO_USD_PER_TOKEN = 30;

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
import { getManagedVeniceWalletSummary } from "@/lib/billing/managed-venice-wallets";
import { calculateActualChatCost } from "@/lib/venice/cost-estimator";
import { sweepStaleManagedVeniceReservations } from "@/lib/venice/reservation-sweep";

const requestBody = {
  model: "venice-uncensored-1-2",
  messages: [{ role: "user", content: "write a long story" }],
  max_completion_tokens: 2_000,
  stream: true,
};

function makeReq(body: Record<string, unknown> = requestBody) {
  return new Request("http://localhost/api/managed-venice/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer hven_live_fixture" },
    body: JSON.stringify(body),
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

// A Venice stream that sends one chunk every couple of milliseconds, so
// frames keep arriving after the client has gone, then ends. (Well inside the
// route deadline, which these tests shorten to 400 ms.)
function pacedUpstreamStream(chunks: string[]) {
  const encoder = new TextEncoder();
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled, sent: () => sent };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for the settlement");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const usageFrame = (usage: Record<string, number>) => `data: ${JSON.stringify({ choices: [], usage })}\n\n`;

// A Venice stream that ends after `chunks`.
function closedUpstreamStream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const contentFrame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

async function settleMicrotasks() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function reservations() {
  return mockMemory.tables.managed_venice_reservations;
}

function reservation() {
  const rows = reservations();
  expect(rows).toHaveLength(1);
  return rows[0];
}

function fundHermesos(valueMicroUsd: number) {
  return {
    id: "lot_1",
    user_id: USER_ID,
    status: "active",
    source: "hermesos_deposit",
    remaining_value_micro_usd: valueMicroUsd,
    remaining_token_amount_raw: "5000000000000000000",
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

describe("managed Venice chat stream: a 200 stream is charged what it streamed", () => {
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
      managed_venice_token_lots: [fundHermesos(STARTING_BALANCE_MICRO_USD)],
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

  // #167 review probe: a client read all 120k tokens of an Opus answer, then
  // closed the socket before the usage frame, and was charged a $0.12
  // estimate for a $3.60 Venice bill. When Venice never sends the usage frame
  // either, the route reads to its deadline and charges every token read.
  it("charges the input estimate plus every token read when the usage frame never arrives after the client leaves", async () => {
    const FRAMES = 10_000;
    const upstream = openUpstreamStream(Array.from({ length: FRAMES }, () => contentFrame("abcd")));
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(
      makeReq({ ...requestBody, model: "claude-opus-4-8", max_completion_tokens: 128_000 })
    );
    expect(response.status).toBe(200);
    const hold = reservation();
    const held = Number(hold.reserved_micro_usd);
    const meta = hold.metadata as Record<string, number>;

    const client = response.body!.getReader();
    let frames = 0;
    while (frames < FRAMES) {
      const next = await client.read();
      if (next.done) break;
      frames += new TextDecoder().decode(next.value).split("\n\n").length - 1;
    }
    expect(frames).toBe(FRAMES);
    await client.cancel();
    // Venice is still read after the client leaves, up to the route deadline.
    expect(upstream.wasCancelled()).toBe(false);
    await waitFor(() => reservation().status !== "active");

    // Settled in the request, not left for a sweep a day later.
    expect(reservation().status).toBe("captured");
    const expected = meta.inputEstimateMicroUsd + FRAMES * OPUS_OUTPUT_MICRO_USD_PER_TOKEN;
    // Not the flat estimate (input + 4,096 tokens) the sweep would charge.
    expect(expected).toBeGreaterThan(2 * meta.sweepEstimateMicroUsd);
    expect(reservation()).toMatchObject({
      status: "captured",
      captured_micro_usd: expected,
      released_micro_usd: held - expected,
    });
    const summary = await getManagedVeniceWalletSummary(USER_ID, mockMemory.db);
    expect(summary.hermesos).toMatchObject({
      totalValueMicroUsd: STARTING_BALANCE_MICRO_USD - expected,
      reservedMicroUsd: 0,
    });
    expect(mockMemory.tables.managed_venice_usage_events).toEqual([
      expect.objectContaining({
        reference_id: hold.reference_id,
        charged_micro_usd: expected,
        metadata: expect.objectContaining({
          pricingPolicy: "managed_venice_observed_output_capture",
          observedOutput: expect.objectContaining({ cause: "client_cancelled", observedOutputTokens: FRAMES }),
        }),
      }),
    ]);
    expect(
      mockMemory.tables.managed_venice_financial_events.filter((event) => event.event_type === "usage_capture")
    ).toEqual([expect.objectContaining({ amount_micro_usd: expected })]);
    // Settled in the request: nothing is left for the sweep, and the key stays live.
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
    expect(mockMemory.tables.managed_venice_proxy_keys[0].status).toBe("active");
    expect(upstream.wasCancelled()).toBe(true);
  });

  // #167 second review probe (HIGH): Opus with no output cap held 4,096
  // output tokens. 10,000 tokens streamed without a usage frame were charged
  // exactly the hold; nothing past it was ever debited. Since #166 an uncapped
  // request holds the model maximum (next test), so the stream here overruns
  // an explicit 2,000-token cap instead: the observed output past the hold is
  // still debited as an overage.
  it("charges output streamed past the hold as an overage when the usage frame never arrives", async () => {
    const FRAMES = 10_000;
    mockFetch.mockResolvedValueOnce(
      new Response(closedUpstreamStream(Array.from({ length: FRAMES }, () => contentFrame("abcd"))), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const response = await POST(makeReq({ ...requestBody, model: "claude-opus-4-8", max_completion_tokens: 2_000 }));
    await response.text();

    const row = reservation();
    const held = Number(row.reserved_micro_usd);
    const meta = row.metadata as Record<string, number>;
    const cost = meta.inputEstimateMicroUsd + FRAMES * OPUS_OUTPUT_MICRO_USD_PER_TOKEN;
    expect(cost).toBeGreaterThan(2 * held);
    expect(row).toMatchObject({ status: "captured", captured_micro_usd: held });
    const summary = await getManagedVeniceWalletSummary(USER_ID, mockMemory.db);
    expect(summary.hermesos).toMatchObject({ totalValueMicroUsd: STARTING_BALANCE_MICRO_USD - cost, reservedMicroUsd: 0 });
    expect(mockMemory.tables.managed_venice_usage_events).toEqual([
      expect.objectContaining({ charged_micro_usd: cost }),
    ]);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  // #167 review probe: $2 wallet on Opus, one Stop press. $1.99997 stayed held
  // until the daily sweep, and the next request got a 402. The hold now goes
  // back as soon as Venice finishes the answer the client left.
  it("gives the rest of the hold back once Venice finishes, so one Stop press does not lock a small wallet", async () => {
    mockMemory.tables.managed_venice_token_lots[0].remaining_value_micro_usd = 2_000_000;
    const bigRequest = { ...requestBody, model: "claude-opus-4-8", max_completion_tokens: 60_000 };
    const first = pacedUpstreamStream([
      contentFrame("Once"),
      contentFrame(" upon"),
      usageFrame({ prompt_tokens: 5, completion_tokens: 20 }),
      "data: [DONE]\n\n",
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(first.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq(bigRequest));
    expect(Number(reservation().reserved_micro_usd)).toBeGreaterThan(1_900_000);
    const client = response.body!.getReader();
    await client.read();
    await client.cancel();
    await waitFor(() => reservation().status !== "active");

    // Venice's exact usage: 5 input tokens at $6 and 20 output tokens at $30 per million.
    expect(reservation()).toMatchObject({ status: "captured", captured_micro_usd: 30 + 600 });

    const second = openUpstreamStream([contentFrame("hi")]);
    mockFetch.mockResolvedValueOnce(
      new Response(second.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );
    const next = await POST(makeReq(bigRequest));
    expect(next.status).toBe(200);
    expect(reservations()).toHaveLength(2);
    await next.body!.cancel();
  });

  it("stops reading Venice at the route deadline and charges what was forwarded", async () => {
    const upstream = openUpstreamStream([contentFrame("Once"), contentFrame(" upon"), contentFrame(" a")]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(makeReq());
    const meta = reservation().metadata as Record<string, number>;
    const drained = (async () => {
      const client = response.body!.getReader();
      for (;;) {
        const next = await client.read();
        if (next.done) return "closed";
      }
    })().catch((error: Error) => error.message);
    const outcome = await Promise.race([
      drained,
      new Promise((resolve) => setTimeout(() => resolve("still open"), 3_000)),
    ]);
    await settleMicrotasks();

    expect(outcome).toBe("Managed Venice stream reached its time limit");
    expect(upstream.wasCancelled()).toBe(true);
    // venice-uncensored-1-2 output: $0.90 per million, three tokens.
    expect(reservation()).toMatchObject({
      status: "captured",
      captured_micro_usd: meta.inputEstimateMicroUsd + Math.ceil((3 * 900_000) / 1_000_000),
    });
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("charges the exact usage when the client disconnects after the usage frame", async () => {
    const upstream = openUpstreamStream([
      contentFrame("Once"),
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
    await waitFor(() => reservation().status !== "active");

    const row = reservation();
    expect(row.status).toBe("captured");
    const captured = Number(row.captured_micro_usd);
    // 40 input tokens at $0.20/M + 900 output tokens at $0.90/M.
    expect(captured).toBe(8 + 810);
    const summary = await getManagedVeniceWalletSummary(USER_ID, mockMemory.db);
    expect(summary.hermesos.totalValueMicroUsd).toBe(STARTING_BALANCE_MICRO_USD - captured);
    expect(mockMemory.tables.managed_venice_usage_events).toHaveLength(1);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  // #167 second review probe (HIGH): GPT-5.5 reasons 20k tokens it never
  // streams. The client asked for the answer on the first line, read it and
  // closed the socket: 213 µUSD was charged against a Venice bill of 750,850,
  // and the hold went straight back, so it repeated. The route now keeps
  // reading Venice to the usage frame and charges exactly what Venice billed.
  it("keeps reading Venice after the client leaves and charges the exact usage, hidden reasoning included", async () => {
    const usage = { prompt_tokens: 16, completion_tokens: 20_003 };
    const upstream = pacedUpstreamStream([
      contentFrame("42\n"),
      ...Array.from({ length: 8 }, () => contentFrame("filler ")),
      usageFrame(usage),
      "data: [DONE]\n\n",
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );

    const response = await POST(
      makeReq({ ...requestBody, model: "openai-gpt-55", max_completion_tokens: 64_000 })
    );
    const client = response.body!.getReader();
    const first = await client.read();
    expect(new TextDecoder().decode(first.value)).toContain("42");
    await client.cancel();
    await waitFor(() => reservation().status !== "active");

    const exact = calculateActualChatCost({
      model: "openai-gpt-55",
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
    }).actualCostMicroUsd;
    expect(exact).toBeGreaterThan(750_000);
    expect(reservation()).toMatchObject({ status: "captured", captured_micro_usd: exact });
    const summary = await getManagedVeniceWalletSummary(USER_ID, mockMemory.db);
    expect(summary.hermesos).toMatchObject({ totalValueMicroUsd: STARTING_BALANCE_MICRO_USD - exact, reservedMicroUsd: 0 });
    // Venice was read to its usage frame, not cut off when the client left.
    expect(upstream.sent()).toBeGreaterThanOrEqual(10);
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
  });

  it("rejects venice_parameters.strip_thinking_response before holding anything", async () => {
    const response = await POST(
      makeReq({ ...requestBody, venice_parameters: { strip_thinking_response: true, character_slug: "x" } })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("strip_thinking_response");
    expect(reservations()).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();

    // Other Venice parameters (Hermes sends character_slug) still pass.
    mockFetch.mockResolvedValueOnce(
      new Response(closedUpstreamStream([contentFrame("hi"), usageFrame({ prompt_tokens: 1, completion_tokens: 1 })]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );
    const allowed = await POST(
      makeReq({ ...requestBody, venice_parameters: { strip_thinking_response: false, character_slug: "x" } })
    );
    expect(allowed.status).toBe(200);
    await allowed.text();
  });

  // #167 review probe: Venice answered 429, the release hit one DB error, the
  // route threw and filed nothing, and after expiry the sweep captured 1,435
  // µUSD for a request Venice refused.
  it("files a failed release for the sweep, which releases the hold and never charges it", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    );
    mockMemory.failNext({ table: "managed_venice_reservations", op: "update" });

    const response = await POST(makeReq());

    expect(response.status).toBe(429);
    expect(reservation().status).toBe("active");
    const items = mockMemory.tables.managed_venice_reconciliation_items;
    expect(items).toEqual([
      expect.objectContaining({
        reason: "managed_venice_chat_release_failed",
        status: "open",
        metadata: expect.objectContaining({ referenceId: reservation().reference_id, upstreamStatus: 429 }),
      }),
    ]);
    expect(mockMemory.tables.managed_venice_proxy_keys[0].status).toBe("active");

    // Even once the hold has expired, the sweep releases it.
    reservation().expires_at = new Date(Date.now() - 60_000).toISOString();
    items[0].created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    const swept = await sweepStaleManagedVeniceReservations({}, mockMemory.db);

    expect(swept).toMatchObject({ releasedReservations: 1, capturedReservations: 0 });
    expect(reservation().status).toBe("released");
    const summary = await getManagedVeniceWalletSummary(USER_ID, mockMemory.db);
    expect(summary.hermesos).toMatchObject({ totalValueMicroUsd: STARTING_BALANCE_MICRO_USD, reservedMicroUsd: 0 });
    expect(mockMemory.tables.managed_venice_usage_events).toHaveLength(0);
  });

  // #167 second review: a non-streamed answer whose capture failed was a 500
  // with no item, and the hold was charged an estimate a day later.
  it("delivers a 200 JSON answer whose capture failed and files its reported cost for the sweep", async () => {
    const answer = {
      id: "chatcmpl_2",
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 40, completion_tokens: 900 },
    };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    mockMemory.failNext({ table: "capture_managed_venice_reservation", op: "rpc" });

    const response = await POST(makeReq({ ...requestBody, stream: false }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    expect(reservation().status).toBe("active");
    const items = mockMemory.tables.managed_venice_reconciliation_items;
    // 40 input tokens at $0.20/M + 900 output tokens at $0.90/M.
    expect(items).toEqual([
      expect.objectContaining({
        reason: "managed_venice_stream_settlement_failed",
        metadata: expect.objectContaining({ referenceId: reservation().reference_id, usageCostMicroUsd: 8 + 810 }),
      }),
    ]);
    expect(mockMemory.tables.managed_venice_proxy_keys[0].status).toBe("active");

    items[0].created_at = new Date(Date.now() - 60 * 60_000).toISOString();
    await sweepStaleManagedVeniceReservations({}, mockMemory.db);
    expect(reservation()).toMatchObject({ status: "captured", captured_micro_usd: 8 + 810 });
  });

  it("delivers a 200 JSON answer that has no usage block and charges its observed output", async () => {
    const answer = { id: "chatcmpl_1", choices: [{ message: { role: "assistant", content: "abcdefgh" } }] };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const response = await POST(makeReq({ ...requestBody, stream: false }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    const meta = reservation().metadata as Record<string, number>;
    // Two tokens ("abcdefgh" is 8 bytes) at $0.90 per million.
    expect(reservation()).toMatchObject({
      status: "captured",
      captured_micro_usd: meta.inputEstimateMicroUsd + Math.ceil((2 * 900_000) / 1_000_000),
    });
    expect(mockMemory.tables.managed_venice_reconciliation_items).toHaveLength(0);
    expect(mockMemory.tables.managed_venice_proxy_keys[0].status).toBe("active");
  });
});
