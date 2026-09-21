/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

const mockedAuth = auth as jest.MockedFunction<typeof auth>;

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/memory/test-connection", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/memory/test-connection", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user-123" } as Awaited<ReturnType<typeof auth>>);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns 401 when not authenticated", async () => {
    mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);
    const res = await POST(buildRequest({ endpoint: "https://example.com" }));
    expect(res.status).toBe(401);
  });

  it("rejects malformed bodies", async () => {
    const res = await POST(buildRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns ok=false for invalid URLs", async () => {
    const res = await POST(buildRequest({ endpoint: "not-a-url" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/valid URL/i);
  });

  it("rejects unsupported schemes", async () => {
    const res = await POST(buildRequest({ endpoint: "ftp://example.com" }));
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/Unsupported scheme/);
  });

  it("does not fetch loopback endpoints from the dashboard server", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(buildRequest({ endpoint: "http://127.0.0.1:3000" }));
    const json = await res.json();

    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let healthPath override the probe to cloud metadata", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(
      buildRequest({
        endpoint: "https://openviking.example",
        healthPath: "http://169.254.169.254/latest/meta-data/",
      }),
    );
    const json = await res.json();

    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok=true on a 200 response from /health", async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await POST(buildRequest({ endpoint: "https://openviking.example" }));
    const json = await res.json();

    expect(json.data.ok).toBe(true);
    expect(json.data.status).toBe(200);
    expect(typeof json.data.latencyMs).toBe("number");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openviking.example/health",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns ok=false with status when remote responds non-2xx", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 503 })) as unknown as typeof fetch;
    const res = await POST(buildRequest({ endpoint: "https://openviking.example" }));
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.status).toBe(503);
    expect(json.data.error).toMatch(/HTTP 503/);
  });

  it("returns ok=false on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    const res = await POST(buildRequest({ endpoint: "https://openviking.example" }));
    const json = await res.json();
    expect(json.data.ok).toBe(false);
    expect(json.data.error).toMatch(/Connection failed/);
  });

  it("uses a custom healthPath when supplied", async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await POST(buildRequest({ endpoint: "https://openviking.example/api", healthPath: "/v1/status" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openviking.example/v1/status",
      expect.anything()
    );
  });

  it("forwards an Authorization header when apiKey is provided", async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await POST(
      buildRequest({ endpoint: "https://openviking.example", apiKey: "secret-token" }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });
});
