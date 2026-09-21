import { NextRequest } from "next/server";

const mockVerifyKey = jest.fn();

jest.mock("@/lib/venice/proxy-keys", () => ({
  verifyManagedVeniceProxyKey: (...args: unknown[]) => mockVerifyKey(...args),
}));

import { GET } from "../route";

function makeReq(key?: string, type?: string) {
  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const url =
    "http://localhost/api/managed-venice/v1/models" +
    (type ? `?type=${encodeURIComponent(type)}` : "");
  return new Request(url, { method: "GET", headers }) as unknown as NextRequest;
}

describe("/api/managed-venice/v1/models", () => {
  const realFetch = global.fetch;
  const originalKey = process.env.VENICE_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyKey.mockResolvedValue({ id: "key_1", userId: "user_1", status: "active" });
  });

  afterEach(() => {
    global.fetch = realFetch;
    if (originalKey === undefined) delete process.env.VENICE_API_KEY;
    else process.env.VENICE_API_KEY = originalKey;
  });

  it("returns 401 when no bearer key is provided", async () => {
    const response = await GET(makeReq());
    expect(response.status).toBe(401);
    expect(mockVerifyKey).not.toHaveBeenCalled();
  });

  it("returns 401 when the bearer key is invalid", async () => {
    mockVerifyKey.mockResolvedValueOnce(null);
    const response = await GET(makeReq("hven_live_bad"));
    expect(response.status).toBe(401);
  });

  it("returns the priced Venice catalog in OpenAI list format", async () => {
    const response = await GET(makeReq("hven_live_good"));
    const body = (await response.json()) as {
      object: string;
      data: Array<{
        id: string;
        object: string;
        owned_by: string;
        context_length: number;
        model_spec: {
          pricing: { input: { usd: number }; output: { usd: number } };
          privacy: string;
        };
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(50);

    const deepseekFlash = body.data.find((m) => m.id === "deepseek-v4-flash");
    expect(deepseekFlash).toBeDefined();
    expect(deepseekFlash?.object).toBe("model");
    expect(deepseekFlash?.owned_by).toBe("venice.ai");
    expect(deepseekFlash?.context_length).toBe(1_000_000);
    expect(deepseekFlash?.model_spec.pricing.input.usd).toBeCloseTo(0.17, 5);
    expect(deepseekFlash?.model_spec.pricing.output.usd).toBeCloseTo(0.35, 5);
    // cache_input is 6x cheaper than input — the catalog must surface it so
    // cache-heavy models like deepseek-v4-flash aren't billed at the full input
    // rate. Regression guard for the 2026-05-17 drift incident.
    expect(deepseekFlash?.model_spec.pricing).toMatchObject({
      cache_read: { usd: expect.any(Number) },
    });
    // Privacy class comes from Venice's /v1/models — deepseek-v4-flash is
    // anonymized upstream (forwarded to DeepSeek's API), not private.
    expect(deepseekFlash?.model_spec.privacy).toBe("anonymized");

    const e2eeModel = body.data.find((m) => m.id.startsWith("e2ee-"));
    expect(["e2ee_private", "private"]).toContain(e2eeModel?.model_spec.privacy);
  });

  it("proxies non-text ?type= straight to Venice (so media dropdowns aren't LLMs)", async () => {
    process.env.VENICE_API_KEY = "server-key";
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "veo-3-fast" }, { id: "kling-2-1" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const response = await GET(makeReq("hven_live_good", "video"));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.venice.ai/api/v1/models?type=video"
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["veo-3-fast", "kling-2-1"]);
    // must NOT fall through to the text pricing catalog
    expect(body.data.some((m) => m.id.startsWith("claude") || m.id.startsWith("deepseek"))).toBe(
      false
    );
  });

  it("keeps returning the priced text catalog when no type is given", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const response = await GET(makeReq("hven_live_good"));
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled(); // text catalog comes from the pricing map, not a proxy
  });
});
