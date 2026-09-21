import { NextRequest } from "next/server";
import { POST as exchange } from "../exchange/route";
import { POST as authorize } from "../authorize/route";
import { supabaseAdmin } from "@/lib/supabase";
import { enforceRateLimit } from "@/lib/rate-limit";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: jest.fn() } }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: jest.fn(() => ({ success: true })), getIP: () => "127.0.0.1" }));
const binding = { sessionId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
  surface: "files", audience: "https://box.example.test" };
const exchangeBody = { ...binding, exchangeCode: `hwe1_${"x".repeat(43)}`, verifier: "v".repeat(64) };
const token = `hws1_${"t".repeat(43)}`;
const rpc = supabaseAdmin!.rpc as jest.Mock;
const request = (kind: string, headers = {}, body: unknown = kind === "exchange" ? exchangeBody : binding, query = "") =>
  new NextRequest(`https://canary.hermesos.cloud/api/workspace/sessions/${kind}${query}`, { method: "POST",
    headers: { "content-type": "application/json", ...(kind === "authorize" ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body) });

describe("guest-only workspace endpoints", () => {
  beforeEach(() => {
    jest.clearAllMocks(); (enforceRateLimit as jest.Mock).mockReturnValue({ success: true });
    rpc.mockImplementation(async (name: string) => ({ data: { ...binding, userId: "owner", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: name.startsWith("exchange") ? "exchanged" : "authorized" }, error: null }));
  });
  it("returns a short-lived bearer only to a broker exchange and does not cache it", async () => {
    const response = await exchange(request("exchange"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data.sessionToken).toMatch(/^hws1_[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("authorizes through the real broker adapter without reflecting its bearer", async () => {
    const response = await authorize(request("authorize"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorized: true, data: binding });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
  });
  it("budgets maximum ledger-session maintenance plus interactive headroom", async () => {
    await authorize(request("authorize"));
    const policy = (enforceRateLimit as jest.Mock).mock.calls[0][1];
    const maintenanceChecks = 64 * Math.ceil(policy.windowMs / 5000);
    expect(policy.limit).toBeGreaterThanOrEqual(maintenanceChecks * 2);
    expect(policy.limit).toBeLessThanOrEqual(4096);
  });
  it.each(["origin", "sec-fetch-site", "cookie"])("rejects browser authority header %s", async header => {
    expect((await exchange(request("exchange", { [header]: "present" }))).status).toBe(403);
    expect((await authorize(request("authorize", { [header]: "present" }))).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects URL capabilities and exchange authorization headers", async () => {
    expect((await exchange(request("exchange", {}, exchangeBody, "?token=x"))).status).toBe(403);
    expect((await authorize(request("authorize", {}, binding, "?token=x"))).status).toBe(403);
    expect((await exchange(request("exchange", { authorization: `Bearer ${token}` }))).status).toBe(403);
    expect((await authorize(request("authorize", { authorization: "Bearer wrong" }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects encoding, content type, oversized and extra-field bodies before storage", async () => {
    for (const [kind, handler, body] of [["exchange", exchange, exchangeBody], ["authorize", authorize, binding]] as const) {
      expect((await handler(request(kind, { "content-encoding": "gzip" }, body))).status).toBe(415);
      expect((await handler(request(kind, { "content-type": "text/plain" }, body))).status).toBe(415);
      expect((await handler(request(kind, { "content-length": "9000" }, body))).status).toBe(413);
      expect((await handler(request(kind, {}, { ...body, unexpected: true }))).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rate limits before storage and returns generic storage denials", async () => {
    (enforceRateLimit as jest.Mock).mockReturnValueOnce({ success: false });
    expect((await exchange(request("exchange"))).status).toBe(429);
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockRejectedValue(new Error("private information"));
    const response = await authorize(request("authorize"));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ authorized: false });
  });
});
