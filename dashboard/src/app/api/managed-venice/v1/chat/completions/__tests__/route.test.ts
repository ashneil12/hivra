import { NextRequest } from "next/server";

const mockVerifyKey = jest.fn();
const mockEstimate = jest.fn();
const mockReserve = jest.fn();
const mockCapture = jest.fn();
const mockRelease = jest.fn();
const mockReconcile = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: (...args: unknown[]) => mockVerifyKey(...args),
}));

jest.mock("@/lib/venice/cost-estimator", () => ({
  estimateChatCompletionCost: (...args: unknown[]) => mockEstimate(...args),
  MissingVeniceUsageError: class MissingVeniceUsageError extends Error {},
}));

jest.mock("@/lib/venice/pricing", () => ({
  UnsupportedVeniceModelError: class UnsupportedVeniceModelError extends Error {},
  checkVeniceChatPricingCatalogStaleness: jest.fn(() => ({
    updatedAt: "2026-05-17",
    ageDays: 0,
    maxAgeDays: 30,
    stale: false,
  })),
}));

jest.mock("@/lib/venice/proxy-settlement", () => ({
  reserveManagedVeniceChatRequest: (...args: unknown[]) => mockReserve(...args),
  captureManagedVeniceChatUsage: (...args: unknown[]) => mockCapture(...args),
  releaseManagedVeniceChatReservation: (...args: unknown[]) => mockRelease(...args),
  markManagedVeniceReconciliationRequired: (...args: unknown[]) => mockReconcile(...args),
}));

jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: jest.fn(async () => ({
    map: new Map(),
    source: "fallback",
    fetchedAt: Date.now(),
    liveModelCount: 0,
  })),
}));

import { MissingVeniceUsageError } from "@/lib/venice/cost-estimator";
import { UnsupportedVeniceModelError } from "@/lib/venice/pricing";
import { POST } from "../route";
import { authorizeManagedVeniceChat } from "@/lib/venice/proxy-chat-core";
import { SWEEPABLE_RECONCILIATION_REASONS } from "@/lib/venice/reservation-sweep";

function makeReq(body: unknown, key = "hven_live_test") {
  return new Request("http://localhost/api/managed-venice/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// An upstream SSE body that stays open after its chunks, like Venice mid-
// generation, and records whether the proxy cancelled it.
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
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const body = {
  model: "venice-uncensored-1-2",
  messages: [{ role: "user", content: "hello" }],
  max_completion_tokens: 10,
};

describe("/api/managed-venice/v1/chat/completions", () => {
  it("authorizes Responses with its own estimation/endpoint before upstream work", async () => {
    const body = { model: "venice-uncensored-1-2", input: "full history", instructions: "system context", tools: [{ type: "function", name: "shell" }], max_output_tokens: 128 };
    const result = await authorizeManagedVeniceChat({ plaintextKey: "fixture", body, protocol: "responses" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.upstreamUrl).toBe("https://api.venice.ai/api/v1/responses");
    expect(mockReserve).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/api/v1/responses", requestBody: expect.objectContaining({
      messages: [{ content: JSON.stringify({ input: "full history", instructions: "system context" }) }], max_completion_tokens: 128, tools: body.tools,
    }) }));
    expect(mockFetch).not.toHaveBeenCalled();
  });
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    process.env.VENICE_API_KEY = "venice_server_key";
    global.fetch = mockFetch as unknown as typeof fetch;
    mockVerifyKey.mockResolvedValue({
      id: "key_1",
      userId: "user_1",
      status: "active",
    });
    mockEstimate.mockReturnValue({ estimatedCostMicroUsd: 10, reservedCostMicroUsd: 11 });
    mockReserve.mockResolvedValue({
      referenceId: "ref_1",
      reservationId: "reservation_1",
      walletType: "hermesos",
      model: "venice-uncensored-1-2",
    });
    mockCapture.mockResolvedValue({ chargedMicroUsd: 8 });
    mockRelease.mockResolvedValue({ released: true });
    mockReconcile.mockResolvedValue({ status: "open" });
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    global.fetch = originalFetch;
    delete process.env.VENICE_API_KEY;
    delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
  });

  it("requires a proxy key", async () => {
    const request = new Request("http://localhost/api/managed-venice/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    }) as unknown as NextRequest;

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects revoked or unknown proxy keys", async () => {
    mockVerifyKey.mockResolvedValueOnce(null);

    const response = await POST(makeReq(body));

    expect(response.status).toBe(401);
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it("rejects unknown models before reserving wallet balance", async () => {
    mockEstimate.mockImplementationOnce(() => {
      throw new UnsupportedVeniceModelError("unknown");
    });

    const response = await POST(makeReq({ ...body, model: "unknown" }));

    expect(response.status).toBe(400);
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects insufficient wallet balance before upstream calls", async () => {
    const { ManagedVeniceInsufficientBalanceError } = await import(
      "@/lib/billing/managed-venice-wallets"
    );
    mockReserve.mockRejectedValueOnce(new ManagedVeniceInsufficientBalanceError());

    const response = await POST(makeReq(body));
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.error).toMatchObject({
      code: "managed_venice_insufficient_balance",
      type: "billing_error",
    });
    expect(payload.error.message).toContain("Top up LLM credits");
    expect(payload.error.message).toContain(
      "https://hivra.cloud/dashboard/billing?managedVenice=deposit&wallet=hermesos"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("points card-backed proxy keys at the card credits top-up path when balance is empty", async () => {
    const { ManagedVeniceInsufficientBalanceError } = await import(
      "@/lib/billing/managed-venice-wallets"
    );
    mockVerifyKey.mockResolvedValueOnce({
      id: "key_card",
      userId: "user_1",
      status: "active",
      defaultWalletType: "card",
    });
    mockReserve.mockRejectedValueOnce(new ManagedVeniceInsufficientBalanceError());

    const response = await POST(makeReq(body));
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.error.message).toContain(
      "https://hivra.cloud/dashboard/billing?managedVenice=deposit&wallet=card"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reserves, forwards, captures usage, and returns the Venice response", async () => {
    const response = await POST(makeReq(body));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.id).toBe("chatcmpl_1");
    expect(mockReserve).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        proxyKeyId: "key_1",
        walletType: "hermesos",
        requestBody: body,
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer venice_server_key",
        }),
      })
    );
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { prompt_tokens: 4, completion_tokens: 10 },
        upstreamStatus: 200,
      })
    );
  });

  it("uses the managed Venice inference key pool before the legacy server key", async () => {
    process.env.MANAGED_VENICE_INFERENCE_KEYS = JSON.stringify(["pool_key_a", "pool_key_b"]);
    process.env.VENICE_API_KEY = "legacy_server_key";

    const response = await POST(makeReq(body));

    expect(response.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer pool_key_[ab]$/
    );
    expect((init.headers as Record<string, string>).Authorization).not.toBe(
      "Bearer legacy_server_key"
    );
  });

  it("uses the proxy key default wallet when the key was created for card credits", async () => {
    mockVerifyKey.mockResolvedValueOnce({
      id: "key_card",
      userId: "user_1",
      status: "active",
      defaultWalletType: "card",
    });

    const response = await POST(makeReq(body));

    expect(response.status).toBe(200);
    expect(mockReserve).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyKeyId: "key_card",
        walletType: "card",
      })
    );
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyKeyId: "key_card",
        walletType: "card",
      })
    );
  });

  it("releases the reservation when upstream fails without usage", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "upstream failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await POST(makeReq(body));

    expect(response.status).toBe(500);
    expect(mockRelease).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1" })
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("marks reconciliation and pauses the key when usage is missing from a successful response", async () => {
    mockCapture.mockRejectedValueOnce(new MissingVeniceUsageError());
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "chatcmpl_1", choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await POST(makeReq(body));

    expect(response.status).toBe(502);
    expect(mockReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        proxyKeyId: "key_1",
        reason: "managed_venice_missing_usage",
        // Telemetry gap on a successful 200 must NOT brick the key.
        pauseKey: false,
      })
    );
  });

  it("streams through Venice chunks, forces include_usage, and captures the final usage chunk", async () => {
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":10}}\n\n'
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const response = await POST(makeReq({ ...body, stream: true }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('data: {"choices":[{"delta":{"content":"hi"}}]}');
    const upstreamBody = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body));
    expect(upstreamBody.stream_options).toEqual({ include_usage: true });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { prompt_tokens: 4, completion_tokens: 10 },
        upstreamStatus: 200,
      })
    );
  });

  it("reconciles WITHOUT pausing when a stream finishes without usage", async () => {
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const response = await POST(makeReq({ ...body, stream: true }));
    await response.text();

    expect(response.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "managed_venice_missing_stream_usage",
        proxyKeyId: "key_1",
        // Reservation is held + invoice cron settles offline — keep the key live.
        pauseKey: false,
      })
    );
  });

  // Security review 2026-09 (HIGH): once Venice has answered 200 it is
  // generating, and billing Hivra, for this request. A client that closes the
  // connection before the final usage frame used to get the whole hold
  // released, so every streamed completion was free. A disconnect must keep
  // the hold and settle from what was observed, or leave a reconciliation
  // item the stale-hold sweep cannot release.
  it("keeps the hold and files a non-sweepable reconciliation item when the client disconnects mid-stream after upstream answered 200", async () => {
    const upstream = openUpstreamStream([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const response = await POST(makeReq({ ...body, stream: true }));
    expect(response.status).toBe(200);
    const client = response.body!.getReader();
    const first = await client.read();
    expect(new TextDecoder().decode(first.value)).toContain('"content":"hi"');
    await client.cancel();
    await settleMicrotasks();

    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    const reservedRef = mockReserve.mock.calls[0][0].referenceId;
    const filed = mockReconcile.mock.calls[0][0];
    expect(filed).toMatchObject({
      userId: "user_1",
      proxyKeyId: "key_1",
      referenceId: reservedRef,
      reason: "managed_venice_chat_stream_cancelled",
      pauseKey: false,
      metadata: expect.objectContaining({ cause: "client_cancelled", upstreamStatus: 200 }),
    });
    expect(SWEEPABLE_RECONCILIATION_REASONS).not.toContain(filed.reason);
    // Stop Venice generating (and billing) for a reader that has gone away.
    expect(upstream.wasCancelled()).toBe(true);
  });

  it("settles from the observed usage frame when the client disconnects after it arrived", async () => {
    const upstream = openUpstreamStream([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":10}}\n\n',
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const response = await POST(makeReq({ ...body, stream: true }));
    const client = response.body!.getReader();
    let seen = "";
    while (!seen.includes('"usage"')) {
      const next = await client.read();
      if (next.done) break;
      seen += new TextDecoder().decode(next.value);
    }
    await client.cancel();
    await settleMicrotasks();

    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceId: mockReserve.mock.calls[0][0].referenceId,
        usage: { prompt_tokens: 4, completion_tokens: 10 },
        upstreamStatus: 200,
      })
    );
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("keeps the hold under the cancel reason when capture fails after a client disconnect", async () => {
    mockCapture.mockRejectedValueOnce(new Error("ledger write failed"));
    const upstream = openUpstreamStream([
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":10}}\n\n',
    ]);
    mockFetch.mockResolvedValueOnce(
      new Response(upstream.stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );

    const response = await POST(makeReq({ ...body, stream: true }));
    const client = response.body!.getReader();
    await client.read();
    await client.cancel();
    await settleMicrotasks();

    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "managed_venice_chat_stream_cancelled",
        pauseKey: false,
        metadata: expect.objectContaining({ cause: "settlement_failed" }),
      })
    );
  });

  it("keeps the hold and files one reconciliation item when Venice drops the stream mid-generation", async () => {
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
            );
            controller.error(new Error("upstream socket reset"));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const response = await POST(makeReq({ ...body, stream: true }));
    await expect(response.text()).rejects.toThrow("upstream socket reset");

    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "managed_venice_stream_settlement_failed",
        pauseKey: false,
      })
    );
  });

  it("releases the reservation and propagates upstream error without pausing the key when Venice rate-limits a streaming request (429)", async () => {
    // Regression for 2026-05-17: Venice 429s on a streaming request used
    // to enter createSettlingStream, fail to find usage in the error body,
    // then mark reconciliation + pause the user's proxy key — bricking
    // the agent over a transient rate-limit. Now we should release the
    // reservation, pass the 429 body straight back to the caller, and
    // leave the proxy key active for the next attempt.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    const response = await POST(makeReq({ ...body, stream: true }));
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload.error?.type).toBe("rate_limit_error");
    expect(mockRelease).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1" }),
    );
    // Critical: do NOT pause the proxy key on a transient upstream error.
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
