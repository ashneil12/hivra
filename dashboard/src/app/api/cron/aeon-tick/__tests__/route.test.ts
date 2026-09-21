/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  // The shared logger imports sanitizeOpsMetadata; passthrough so the import resolves.
  sanitizeOpsMetadata: (m: Record<string, unknown> | undefined) => m ?? {},
}));

import { GET } from "../route";

const originalFetch = global.fetch;
const originalCronSecret = process.env.CRON_SECRET;
const originalToken = process.env.AEON_DISPATCH_GITHUB_TOKEN;
const originalRepo = process.env.AEON_DISPATCH_REPO;

function mockReq(secret = "test-cron-secret") {
  return new NextRequest("http://localhost/api/cron/aeon-tick", {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function restoreEnv(key: string, original: string | undefined) {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv("CRON_SECRET", originalCronSecret);
  restoreEnv("AEON_DISPATCH_GITHUB_TOKEN", originalToken);
  restoreEnv("AEON_DISPATCH_REPO", originalRepo);
  jest.restoreAllMocks();
});

describe("GET /api/cron/aeon-tick", () => {
  it("401s on a bad bearer", async () => {
    process.env.CRON_SECRET = "secret";
    const res = await GET(mockReq("wrong"));
    expect(res.status).toBe(401);
  });

  it("500s when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(mockReq("anything"));
    expect(res.status).toBe(500);
  });

  it("500s when the dispatch token is unset", async () => {
    process.env.CRON_SECRET = "secret";
    delete process.env.AEON_DISPATCH_GITHUB_TOKEN;
    const res = await GET(mockReq("secret"));
    expect(res.status).toBe(500);
  });

  it("dispatches a cron-tick to the Aeon repo and 200s on GitHub 204", async () => {
    process.env.CRON_SECRET = "secret";
    process.env.AEON_DISPATCH_GITHUB_TOKEN = "ghtok";
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(mockReq("secret"));
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/ashneil12/aeon/dispatches");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ event_type: "cron-tick" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghtok");
  });

  it("502s when GitHub rejects the dispatch", async () => {
    process.env.CRON_SECRET = "secret";
    process.env.AEON_DISPATCH_GITHUB_TOKEN = "ghtok";
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response("Bad credentials", { status: 401 })) as unknown as typeof fetch;

    const res = await GET(mockReq("secret"));
    expect(res.status).toBe(502);
  });

  it("honors the AEON_DISPATCH_REPO override", async () => {
    process.env.CRON_SECRET = "secret";
    process.env.AEON_DISPATCH_GITHUB_TOKEN = "ghtok";
    process.env.AEON_DISPATCH_REPO = "owner/other";
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await GET(mockReq("secret"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/other/dispatches");
  });
});
