import { NextRequest } from "next/server";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";

const mockVerifyKey = jest.fn();
const mockRecordUsage = jest.fn();

jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: (...args: unknown[]) => mockVerifyKey(...args),
}));
jest.mock("@/lib/venice/proxy-settlement", () => ({
  recordManagedVeniceMultimodalUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

import { GET, POST } from "../route";

function makeReq(
  method: string,
  url: string,
  key?: string,
  body?: string,
  contentType = "application/json"
) {
  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (body && method !== "GET") headers["Content-Type"] = contentType;
  return new Request(url, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  }) as unknown as NextRequest;
}

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe("/api/managed-venice/v1/[...path] passthrough", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyKey.mockResolvedValue({
      id: "key_1",
      userId: "user_1",
      status: "active",
      defaultWalletType: "hermesos",
    });
    mockRecordUsage.mockResolvedValue(undefined);
    process.env.VENICE_API_KEY = "server-key";
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("returns 401 with no bearer key (and never hits Venice)", async () => {
    const res = await POST(
      makeReq("POST", "http://localhost/api/managed-venice/v1/image/generate", undefined, "{}"),
      ctx(["image", "generate"])
    );
    expect(res.status).toBe(401);
    expect(mockVerifyKey).not.toHaveBeenCalled();
  });

  it.each([["responses"], ["responses", "compact"], ["responses", "resp_other"]])("fences every Responses descendant from unmetered passthrough: %j", async (...path) => {
    global.fetch = jest.fn();
    for (const method of [GET, POST]) {
      const result = await method(makeReq("POST", "https://hivra.test/api/managed-venice/v1/" + path.join("/"), "fixture", "{}"), ctx(path));
      expect(result.status).toBe(404);
      expect(result.headers.get("cache-control")).toBe("no-store");
    }
    expect(global.fetch).not.toHaveBeenCalled(); expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it.each(["responses%2Fcompact", "responses%252Fcompact", "responses%5Ccompact", "Responses/compact"])("fences the actual Next-decoded path %s before dispatch", async suffix => {
    const match = getRouteMatcher(getRouteRegex("/api/managed-venice/v1/[...path]"))("/api/managed-venice/v1/" + suffix);
    expect(match).toBeTruthy();
    if (!match) throw new Error("Expected route match");
    global.fetch = jest.fn();
    const result = await POST(makeReq("POST", "https://hivra.test/api/managed-venice/v1/" + suffix, "fixture", "{}"), ctx(match.path as string[]));
    expect(result.status).toBe(404); expect(fetch).not.toHaveBeenCalled(); expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 401 when the key is invalid", async () => {
    mockVerifyKey.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", "http://localhost/api/managed-venice/v1/image/generate", "hven_live_bad", "{}"),
      ctx(["image", "generate"])
    );
    expect(res.status).toBe(401);
  });

  it("forwards POST /image/generate to Venice's SINGULAR path with the server key + meters it", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ images: ["b64"], id: "req_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeReq(
        "POST",
        "http://localhost/api/managed-venice/v1/image/generate",
        "hven_live_good",
        JSON.stringify({ model: "venice-sd35", prompt: "a cat" })
      ),
      ctx(["image", "generate"])
    );

    expect(res.status).toBe(200);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://api.venice.ai/api/v1/image/generate");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer server-key");
    expect(init.method).toBe("POST");
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
    const usage = mockRecordUsage.mock.calls[0][0];
    expect(usage.endpoint).toBe("/api/v1/image/generate");
    expect(usage.model).toBe("venice-sd35");
    expect(usage.upstreamRequestId).toBe("req_1");
  });

  it("forwards the query string for GET reads and does NOT bill them", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "elevenlabs-music" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(
      makeReq("GET", "http://localhost/api/managed-venice/v1/models?type=music", "hven_live_good"),
      ctx(["models"])
    );

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.venice.ai/api/v1/models?type=music");
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("does NOT bill audio/retrieve polls and passes binary through byte-exact", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeReq(
        "POST",
        "http://localhost/api/managed-venice/v1/audio/retrieve",
        "hven_live_good",
        JSON.stringify({ model: "elevenlabs-music", queue_id: "q1" })
      ),
      ctx(["audio", "retrieve"])
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("forwards POST /crypto/rpc/{network} (read-only on-chain) and bills it", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      makeReq(
        "POST",
        "http://localhost/api/managed-venice/v1/crypto/rpc/ethereum-mainnet",
        "hven_live_good",
        JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 })
      ),
      ctx(["crypto", "rpc", "ethereum-mainnet"])
    );

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.venice.ai/api/v1/crypto/rpc/ethereum-mainnet"
    );
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
  });

  it("rejects path traversal", async () => {
    const res = await POST(
      makeReq("POST", "http://localhost/api/managed-venice/v1/image", "hven_live_good", "{}"),
      ctx(["image", ".."])
    );
    expect(res.status).toBe(404);
  });
});
