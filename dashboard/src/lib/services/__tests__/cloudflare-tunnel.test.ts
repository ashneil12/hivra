import { boxHostname, createBoxTunnel } from "../cloudflare-tunnel";
import { log } from "@/lib/logger";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

// Cloudflare Universal SSL serves an edge cert for `<zone>` and `*.<zone>` ONLY —
// one label deep. A box hostname any deeper has no edge cert, so the browser can't
// TLS-handshake it and every fetch dies with "Failed to fetch" (the real-world bug
// these cases lock down). boxHostname() must therefore ALWAYS return a name exactly
// one label under the zone apex.
describe("boxHostname — pins hostnames one label under the zone apex", () => {
  const apex = "hermesos.cloud";

  it("uses the zone apex directly when domain === apex", () => {
    expect(boxHostname("box-abc123", apex, apex)).toBe("box-abc123.hermesos.cloud");
  });

  it("uses the zone apex when no domain is configured", () => {
    expect(boxHostname("box-abc123", apex)).toBe("box-abc123.hermesos.cloud");
    expect(boxHostname("box-abc123", apex, null)).toBe("box-abc123.hermesos.cloud");
    expect(boxHostname("box-abc123", apex, "")).toBe("box-abc123.hermesos.cloud");
  });

  it("folds deeper domain labels into the slug instead of nesting them as DNS labels (the bug)", () => {
    // The exact misconfig that broke prod: a 3-level domain would have produced
    // box-abc123.agents.canary.hermesos.cloud (no edge cert). It must collapse to
    // a single label under the apex.
    expect(boxHostname("box-abc123", apex, "agents.canary.hermesos.cloud")).toBe(
      "agents-canary-box-abc123.hermesos.cloud",
    );
    expect(boxHostname("box-abc123", apex, "agents.hermesos.cloud")).toBe(
      "agents-box-abc123.hermesos.cloud",
    );
  });

  it("always yields a hostname exactly one label under the apex", () => {
    for (const dom of [apex, "a.hermesos.cloud", "a.b.c.hermesos.cloud", "x.y.hermesos.cloud"]) {
      const host = boxHostname("box-1", apex, dom);
      expect(host.endsWith("." + apex)).toBe(true);
      const labelsUnderApex = host.slice(0, -(apex.length + 1)).split(".");
      expect(labelsUnderApex).toHaveLength(1);
    }
  });

  it("ignores a configured domain that isn't under the zone apex (falls back to apex)", () => {
    expect(boxHostname("box-abc123", apex, "example.com")).toBe("box-abc123.hermesos.cloud");
    expect(boxHostname("box-abc123", apex, "agents.other.net")).toBe("box-abc123.hermesos.cloud");
  });

  it("tolerates leading/trailing dots and case in the apex and domain", () => {
    expect(boxHostname("Box-ABC", "Hermesos.Cloud", ".Agents.Hermesos.Cloud.")).toBe(
      "agents-box-abc.hermesos.cloud",
    );
  });

  it("sanitizes the slug and never emits an empty label", () => {
    expect(boxHostname("", apex)).toBe("box.hermesos.cloud");
    expect(boxHostname("--weird__slug--", apex)).toBe("weird-slug.hermesos.cloud");
  });

  it("keeps the leftmost label within the 63-char DNS limit", () => {
    const host = boxHostname("box-" + "a".repeat(80), apex, "agents.canary.hermesos.cloud");
    const label = host.slice(0, host.indexOf("."));
    expect(label.length).toBeLessThanOrEqual(63);
    expect(host.endsWith(".hermesos.cloud")).toBe(true);
  });
});

describe("createBoxTunnel — failed-provision cleanup", () => {
  const TUNNEL_ID = "00000000-0000-4000-8000-000000000b01";
  const CFG = { apiToken: "cf_test", zoneId: "zone123", domain: "hermesos.cloud", accountId: "acct123" };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  afterEach(() => jest.restoreAllMocks());

  it("logs a failed cleanup delete instead of swallowing it, and still deletes the tunnel", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      // 1) GET zone → apex name + account
      .mockResolvedValueOnce(json({ success: true, result: { name: "hermesos.cloud", account: { id: "acct123" } } }))
      // 2) POST tunnel → created
      .mockResolvedValueOnce(json({ success: true, result: { id: TUNNEL_ID, token: "tok_test" } }))
      // 3) PUT tunnel configuration → fails, so provisioning enters cleanup
      .mockResolvedValueOnce(json({ success: false, errors: [{ code: 1000, message: "config rejected" }] }, 500))
      // 4) DELETE stale connections → fails during cleanup
      .mockResolvedValueOnce(json({ success: false, errors: [{ code: 1001, message: "connections busy" }] }, 500))
      // 5) DELETE tunnel → succeeds
      .mockResolvedValueOnce(json({ success: true, result: {} }));

    const result = await createBoxTunnel("box-abc123", { configOverride: CFG });

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "cloudflare tunnel cleanup: stale connection delete failed",
      expect.objectContaining({ tunnelId: TUNNEL_ID, error: expect.stringContaining("connections busy") }),
    );
    const tunnelDelete = fetchSpy.mock.calls.find(
      ([url, init]) => String(url).endsWith(`/cfd_tunnel/${TUNNEL_ID}`) && init?.method === "DELETE",
    );
    expect(tunnelDelete).toBeDefined();
  });
});
