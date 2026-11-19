/** @jest-environment node */
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  deleteTunnelConnection,
  getBoxTunnelOrigin,
  getBoxTunnelToken,
  listTunnelConnections,
  rotateTunnelSecret,
  setBoxTunnelOrigin,
  type CloudflareTunnelConfig,
} from "../cloudflare-tunnel";

const ACCOUNT = "a".repeat(32);
const TUNNEL = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";
const cfg: CloudflareTunnelConfig = { apiToken: "test-api-value", accountId: ACCOUNT, zoneId: "b".repeat(32), domain: "example.test" };
const FAKE_RUN_DOC = "e".repeat(80);

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let answers: unknown[] = [];

beforeEach(() => {
  calls = [];
  answers = [];
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const result = answers.shift();
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
});

describe("host ingress tunnel calls", () => {
  it("reads the run token and refuses anything not shaped like one", async () => {
    answers.push(FAKE_RUN_DOC);
    await expect(getBoxTunnelToken(TUNNEL, cfg)).resolves.toBe(FAKE_RUN_DOC);
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`);
    answers.push({ not: "a token" });
    await expect(getBoxTunnelToken(TUNNEL, cfg)).rejects.toThrow("no usable tunnel credential");
    await expect(getBoxTunnelToken("../x", cfg)).rejects.toThrow("invalid tunnel id");
  });

  it("lists connectors with their live connection counts", async () => {
    answers.push([
      { id: CLIENT, version: "2026.8.2", run_at: "t", conns: [{ is_pending_reconnect: false }, { is_pending_reconnect: true }] },
    ]);
    await expect(listTunnelConnections(TUNNEL, cfg)).resolves.toEqual([
      { clientId: CLIENT, version: "2026.8.2", runAt: "t", connections: 1 },
    ]);
    answers.push([{ id: "bad" }]);
    await expect(listTunnelConnections(TUNNEL, cfg)).rejects.toThrow();
  });

  it("rotates with a fresh 32-byte secret and never puts it in an error", async () => {
    answers.push({});
    await rotateTunnelSecret(TUNNEL, cfg);
    expect(calls[0]).toMatchObject({ method: "PATCH", url: expect.stringContaining(`/cfd_tunnel/${TUNNEL}`) });
    const secret = (calls[0].body as { tunnel_secret: string }).tunnel_secret;
    expect(Buffer.from(secret, "base64")).toHaveLength(32);
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "no" }] }), { status: 400 })) as unknown as typeof fetch;
    await expect(rotateTunnelSecret(TUNNEL, cfg)).rejects.toThrow(/^(?!.*tunnel_secret).*$/);
  });

  it("evicts one connector by client id", async () => {
    answers.push(null);
    await deleteTunnelConnection(TUNNEL, CLIENT, cfg);
    expect(calls[0]).toMatchObject({ method: "DELETE", url: expect.stringContaining(`/connections?client_id=${CLIENT}`) });
    await expect(deleteTunnelConnection(TUNNEL, "x", cfg)).rejects.toThrow("invalid connector id");
  });

  it("reads and changes only the box hostname's origin, keeping every other rule", async () => {
    const config = { ingress: [{ hostname: "box.example.test", service: "http://localhost:8080", originRequest: {} }, { service: "http_status:404" }], "warp-routing": { enabled: false } };
    answers.push({ config });
    await expect(getBoxTunnelOrigin(TUNNEL, "box.example.test", cfg)).resolves.toBe("http://localhost:8080");
    answers.push({ config }, {});
    await setBoxTunnelOrigin(TUNNEL, "box.example.test", "http://127.0.0.1:8080", cfg);
    expect(calls[2]).toMatchObject({ method: "PUT" });
    expect(calls[2].body).toEqual({ config: { ...config, ingress: [{ hostname: "box.example.test", service: "http://127.0.0.1:8080", originRequest: {} }, { service: "http_status:404" }] } });
    // Already there: no write.
    answers.push({ config: { ingress: [{ hostname: "box.example.test", service: "http://127.0.0.1:8080" }] } });
    await setBoxTunnelOrigin(TUNNEL, "box.example.test", "http://127.0.0.1:8080", cfg);
    expect(calls).toHaveLength(4);
    await expect(setBoxTunnelOrigin(TUNNEL, "box.example.test", "http://evil:1" as "http://localhost:8080", cfg)).rejects.toThrow("invalid tunnel origin");
  });
});
