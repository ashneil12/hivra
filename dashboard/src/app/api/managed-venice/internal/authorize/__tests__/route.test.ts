import { NextRequest } from "next/server";

const mockAuthorize = jest.fn();

jest.mock("@/lib/venice/proxy-chat-core", () => ({
  authorizeManagedVeniceChat: (...args: unknown[]) => mockAuthorize(...args),
}));

import { POST } from "../route";

const SECRET = "test-internal-secret";
const HEADER = "x-managed-venice-internal-secret";

function makeReq(
  payload: unknown,
  opts: { secret?: string | null } = {}
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers[HEADER] = secret;
  return new Request("http://localhost/api/managed-venice/internal/authorize", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }) as unknown as NextRequest;
}

const okValue = {
  referenceId: "ref_1",
  reservationId: "reservation_1",
  upstreamKey: "venice_server_key",
  upstreamUrl: "https://api.venice.ai/api/v1/chat/completions",
  walletType: "hermesos" as const,
  userId: "user_1",
  proxyKeyId: "key_1",
  model: "venice-uncensored-1-2",
  pricingMap: new Map(),
  pricingSource: "fallback",
  liveModelCount: 0,
  bodyPatch: {},
};

describe("/api/managed-venice/internal/authorize", () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    process.env.MANAGED_VENICE_INTERNAL_SECRET = SECRET;
    mockAuthorize.mockResolvedValue({ ok: true, value: okValue });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.MANAGED_VENICE_INTERNAL_SECRET;
  });

  it("503s when the internal secret is not configured", async () => {
    delete process.env.MANAGED_VENICE_INTERNAL_SECRET;
    const res = await POST(makeReq({ plaintextKey: "hven_live_x", body: { model: "m" } }));
    expect(res.status).toBe(503);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("403s when the secret header is missing", async () => {
    const res = await POST(
      makeReq({ plaintextKey: "hven_live_x", body: { model: "m" } }, { secret: null })
    );
    expect(res.status).toBe(403);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("403s when the secret is wrong", async () => {
    const res = await POST(
      makeReq({ plaintextKey: "hven_live_x", body: { model: "m" } }, { secret: "nope" })
    );
    expect(res.status).toBe(403);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("400s when the body is missing", async () => {
    const res = await POST(makeReq({ plaintextKey: "hven_live_x" }));
    expect(res.status).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("returns the authorized context (and never leaks pricingMap) on success", async () => {
    const res = await POST(
      makeReq({ plaintextKey: "hven_live_x", body: { model: "venice-uncensored-1-2" } })
    );
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      referenceId: "ref_1",
      upstreamKey: "venice_server_key",
      upstreamUrl: "https://api.venice.ai/api/v1/chat/completions",
      walletType: "hermesos",
      userId: "user_1",
      proxyKeyId: "key_1",
      model: "venice-uncensored-1-2",
      bodyPatch: {},
    });
    expect(payload).not.toHaveProperty("pricingMap");
    // A Worker that does not say it applies bodyPatch forwards its own copy of
    // the body, so it must never be given a lower output cap to apply.
    expect(mockAuthorize).toHaveBeenCalledWith({
      plaintextKey: "hven_live_x",
      body: { model: "venice-uncensored-1-2" },
      allowBodyRewrite: false,
    });
  });

  it.each([
    [true, true],
    ["true", false],
    [1, false],
  ])("acceptsBodyPatch=%p allows a body rewrite: %p", async (flag, allowed) => {
    await POST(
      makeReq({ plaintextKey: "hven_live_x", body: { model: "m" }, acceptsBodyPatch: flag })
    );
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({ allowBodyRewrite: allowed })
    );
  });

  it("relays the output-cap patch the Worker must apply", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: true,
      value: { ...okValue, bodyPatch: { max_completion_tokens: 30_000 } },
    });
    const res = await POST(
      makeReq({ plaintextKey: "hven_live_x", body: { model: "m" }, acceptsBodyPatch: true })
    );
    const payload = await res.json();
    expect(payload.bodyPatch).toEqual({ max_completion_tokens: 30_000 });
  });

  it("relays an authorize error response verbatim (402 billing)", async () => {
    mockAuthorize.mockResolvedValueOnce({
      ok: false,
      response: new Response(
        JSON.stringify({ error: { code: "managed_venice_insufficient_balance" } }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      ),
    });
    const res = await POST(
      makeReq({ plaintextKey: "hven_live_x", body: { model: "m" } })
    );
    const payload = await res.json();
    expect(res.status).toBe(402);
    expect(payload.error.code).toBe("managed_venice_insufficient_balance");
  });
});
