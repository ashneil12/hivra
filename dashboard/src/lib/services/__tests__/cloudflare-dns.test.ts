/**
 * Tests for the Cloudflare DNS integration.
 *
 * Mocks the global fetch so the test asserts we hit the right Cloudflare API
 * endpoints with the right body/headers, and that the propagation-verify
 * rollback path triggers when DNS doesn't propagate. No real network.
 */

import {
  createDnsRecord,
  deleteDnsRecordById,
  deriveDnsDomainFromGatewayUrl,
  findDnsRecord,
  getCloudflareDnsConfig,
  isCloudflareDnsConfigured,
  listAllDnsRecords,
  mintInstanceDns,
  removeInstanceDns,
  removeInstanceDnsBestEffort,
  updateDnsRecordProxyState,
  verifyDnsPropagation,
  type CloudflareDnsConfig,
} from "@/lib/services/cloudflare-dns";
import { log } from "@/lib/logger";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const TEST_CONFIG: CloudflareDnsConfig = {
  apiToken: "cf_test_token",
  zoneId: "zone123",
  domain: "agents.hermesos.cloud",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cfSuccess<T>(result: T): { success: true; result: T } {
  return { success: true, result };
}

function cfError(code: number, message: string) {
  return { success: false, errors: [{ code, message }] };
}

describe("getCloudflareDnsConfig", () => {
  it("returns null when any required env var is missing", () => {
    expect(getCloudflareDnsConfig({})).toBeNull();
    expect(
      getCloudflareDnsConfig({
        CLOUDFLARE_API_TOKEN: "x",
        CLOUDFLARE_ZONE_ID: "y",
      }),
    ).toBeNull();
  });

  it("returns config and strips wrapping dots from domain", () => {
    const config = getCloudflareDnsConfig({
      CLOUDFLARE_API_TOKEN: " tok ",
      CLOUDFLARE_ZONE_ID: " zone ",
      CLOUDFLARE_DNS_DOMAIN: ".agents.hermesos.cloud.",
    });
    expect(config).toEqual({
      apiToken: "tok",
      zoneId: "zone",
      domain: "agents.hermesos.cloud",
      proxied: false,
    });
  });

  it("reads the optional proxied flag", () => {
    expect(
      getCloudflareDnsConfig({
        CLOUDFLARE_API_TOKEN: "tok",
        CLOUDFLARE_ZONE_ID: "zone",
        CLOUDFLARE_DNS_DOMAIN: "agents.hermesos.cloud",
        CLOUDFLARE_DNS_PROXIED: "true",
      }),
    ).toEqual({
      apiToken: "tok",
      zoneId: "zone",
      domain: "agents.hermesos.cloud",
      proxied: true,
    });
  });

  it("isCloudflareDnsConfigured mirrors getCloudflareDnsConfig", () => {
    expect(isCloudflareDnsConfigured({})).toBe(false);
    expect(
      isCloudflareDnsConfigured({
        CLOUDFLARE_API_TOKEN: "t",
        CLOUDFLARE_ZONE_ID: "z",
        CLOUDFLARE_DNS_DOMAIN: "d.example",
      }),
    ).toBe(true);
  });
});

describe("createDnsRecord", () => {
  afterEach(() => jest.restoreAllMocks());

  it("POSTs an A record and returns the new record id", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse(cfSuccess({ id: "rec_abc", type: "A", name: "a.b", content: "203.0.113.4", ttl: 1 })));

    const result = await createDnsRecord(TEST_CONFIG, {
      fqdn: "inst-foo.agents.hermesos.cloud",
      ip: "203.0.113.4",
      comment: "hermes instance abc",
    });

    expect(result).toEqual({ id: "rec_abc" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone123/dns_records");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer cf_test_token");
    expect(JSON.parse(init?.body as string)).toEqual({
      type: "A",
      name: "inst-foo.agents.hermesos.cloud",
      content: "203.0.113.4",
      ttl: 1,
      proxied: false,
      comment: "hermes instance abc",
    });
  });

  it("throws with the Cloudflare error code+message on failure", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse(cfError(81053, "An A record with that host already exists."), 400));

    await expect(
      createDnsRecord(TEST_CONFIG, { fqdn: "x.example.com", ip: "1.1.1.1" }),
    ).rejects.toThrow(/81053.*already exists/);
  });

  it("throws on non-JSON response", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("<html>500</html>", { status: 500 }));

    await expect(
      createDnsRecord(TEST_CONFIG, { fqdn: "x.example.com", ip: "1.1.1.1" }),
    ).rejects.toThrow(/non-JSON response/);
  });
});

describe("updateDnsRecordProxyState", () => {
  afterEach(() => jest.restoreAllMocks());

  it("PATCHes the record proxy flag", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse(cfSuccess({ id: "rec_x", type: "A", name: "x", content: "1.1.1.1", ttl: 1 })));

    await updateDnsRecordProxyState(TEST_CONFIG, "rec_x", true);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone123/dns_records/rec_x");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ proxied: true });
  });
});

describe("findDnsRecord", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns the first matching record", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        jsonResponse(
          cfSuccess([
            { id: "rec_first", type: "A", name: "x.example.com", content: "1.1.1.1", ttl: 1 },
          ]),
        ),
      );

    const record = await findDnsRecord(TEST_CONFIG, "x.example.com");

    expect(record?.id).toBe("rec_first");
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("type=A");
    expect(url).toContain("name=x.example.com");
  });

  it("returns null when no records exist", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(cfSuccess([])));
    expect(await findDnsRecord(TEST_CONFIG, "missing.example.com")).toBeNull();
  });
});

describe("listAllDnsRecords", () => {
  afterEach(() => jest.restoreAllMocks());

  function pageResponse(records: Array<{ id: string; name: string }>, info: {
    page: number;
    total_pages: number;
  }) {
    return jsonResponse({
      success: true,
      result: records.map((r) => ({
        id: r.id,
        type: "A",
        name: r.name,
        content: "1.1.1.1",
        ttl: 1,
        created_on: "2026-05-01T00:00:00Z",
      })),
      result_info: {
        page: info.page,
        per_page: 1000,
        total_pages: info.total_pages,
        count: records.length,
        total_count: records.length,
      },
    });
  }

  it("pages through results and concatenates them", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        pageResponse(
          [
            { id: "p1a", name: "p1a.example.com" },
            { id: "p1b", name: "p1b.example.com" },
          ],
          { page: 1, total_pages: 2 },
        ),
      )
      .mockResolvedValueOnce(
        pageResponse(
          [{ id: "p2a", name: "p2a.example.com" }],
          { page: 2, total_pages: 2 },
        ),
      );

    const records = await listAllDnsRecords(TEST_CONFIG);
    expect(records.map((r) => r.id)).toEqual(["p1a", "p1b", "p2a"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(firstUrl).toContain("page=1");
    expect(firstUrl).toContain("type=A");
    const secondUrl = fetchSpy.mock.calls[1]![0] as string;
    expect(secondUrl).toContain("page=2");
  });

  it("passes the nameSuffix as name.endswith", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(pageResponse([], { page: 1, total_pages: 1 }));

    await listAllDnsRecords(TEST_CONFIG, { nameSuffix: ".agents.hermesos.cloud" });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("name.endswith=");
    expect(decodeURIComponent(url)).toContain("name.endswith=.agents.hermesos.cloud");
  });

  it("stops at the maxRecords cap", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        pageResponse(
          Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `p${i}.example.com` })),
          { page: 1, total_pages: 5 },
        ),
      );

    const records = await listAllDnsRecords(TEST_CONFIG, { maxRecords: 3 });
    expect(records).toHaveLength(3);
  });

  it("throws on a Cloudflare error response", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(cfError(10000, "Invalid API Token"), 401));
    await expect(listAllDnsRecords(TEST_CONFIG)).rejects.toThrow(/Invalid API Token/);
  });
});

describe("deleteDnsRecordById", () => {
  afterEach(() => jest.restoreAllMocks());

  it("issues a DELETE to the record endpoint", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(cfSuccess({ id: "rec_x" })));
    await deleteDnsRecordById(TEST_CONFIG, "rec_x");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone123/dns_records/rec_x");
    expect(init?.method).toBe("DELETE");
  });
});

describe("verifyDnsPropagation", () => {
  it("returns true on first poll when resolver matches", async () => {
    const resolve4 = jest.fn().mockResolvedValue(["203.0.113.4"]);
    const ok = await verifyDnsPropagation("x.example.com", "203.0.113.4", {
      resolve4,
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(ok).toBe(true);
    expect(resolve4).toHaveBeenCalledTimes(1);
  });

  it("polls past transient ENOTFOUND until resolver returns expected IP", async () => {
    const resolve4 = jest
      .fn<Promise<string[]>, [string]>()
      .mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }))
      .mockResolvedValueOnce(["9.9.9.9"]) // wrong IP, keep polling
      .mockResolvedValueOnce(["203.0.113.4"]);

    const ok = await verifyDnsPropagation("x.example.com", "203.0.113.4", {
      resolve4,
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(ok).toBe(true);
    expect(resolve4).toHaveBeenCalledTimes(3);
  });

  it("returns false when timeout elapses without a match", async () => {
    const resolve4 = jest.fn().mockResolvedValue(["9.9.9.9"]);
    const ok = await verifyDnsPropagation("x.example.com", "203.0.113.4", {
      resolve4,
      timeoutMs: 30,
      pollIntervalMs: 5,
    });
    expect(ok).toBe(false);
    expect(resolve4.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("mintInstanceDns", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns cloudflare_not_configured when no config", async () => {
    const result = await mintInstanceDns({ subdomain: "x", ip: "203.0.113.4" }, null);
    expect(result).toEqual({ ok: false, error: "cloudflare_not_configured" });
  });

  it("creates record and verifies propagation on happy path (no existing record)", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      // 1) GET find-all → none exist
      .mockResolvedValueOnce(jsonResponse(cfSuccess([])))
      // 2) POST create → success
      .mockResolvedValueOnce(
        jsonResponse(cfSuccess({ id: "rec_new", type: "A", name: "f", content: "203.0.113.4", ttl: 1 })),
      );
    const resolve4 = jest.fn().mockResolvedValue(["203.0.113.4"]);

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", resolve4, propagationTimeoutMs: 5_000 },
      TEST_CONFIG,
    );

    expect(result).toEqual({
      ok: true,
      fqdn: "inst-foo.agents.hermesos.cloud",
      recordId: "rec_new",
    });
    // GET find-all + POST create; no rollback DELETE.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]![1]?.method).toBe("POST");
  });

  it("skipVerify avoids the propagation poll", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(cfSuccess([])))
      .mockResolvedValueOnce(
        jsonResponse(cfSuccess({ id: "rec_new", type: "A", name: "f", content: "203.0.113.4", ttl: 1 })),
      );
    const resolve4 = jest.fn();

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", skipVerify: true, resolve4 },
      TEST_CONFIG,
    );

    expect(result.ok).toBe(true);
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("creates proxied records and skips origin-IP propagation checks", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(cfSuccess([])))
      .mockResolvedValueOnce(
        jsonResponse(cfSuccess({ id: "rec_new", type: "A", name: "f", content: "203.0.113.4", ttl: 1 })),
      );
    const resolve4 = jest.fn();

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", proxied: true, resolve4 },
      TEST_CONFIG,
    );

    expect(result).toEqual({
      ok: true,
      fqdn: "inst-foo.agents.hermesos.cloud",
      recordId: "rec_new",
    });
    // calls[0] is the find-all GET; calls[1] is the create POST.
    expect(JSON.parse(fetchSpy.mock.calls[1]![1]?.body as string)).toMatchObject({ proxied: true });
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("adopts an existing record that already points at the correct IP (no create, no patch)", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      jsonResponse(
        cfSuccess([
          { id: "rec_existing", type: "A", name: "inst-foo.agents.hermesos.cloud", content: "203.0.113.4", ttl: 1, proxied: true },
        ]),
      ),
    );

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", proxied: true, skipVerify: true },
      TEST_CONFIG,
    );

    expect(result).toEqual({
      ok: true,
      fqdn: "inst-foo.agents.hermesos.cloud",
      recordId: "rec_existing",
    });
    // Only the find-all GET — no create, no patch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("repoints an existing record that points at a stale IP (the host-move / split-brain fix)", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      // 1) GET find-all → stale record on the old host IP
      .mockResolvedValueOnce(
        jsonResponse(
          cfSuccess([
            { id: "rec_stale", type: "A", name: "inst-foo.agents.hermesos.cloud", content: "9.9.9.9", ttl: 1, proxied: true },
          ]),
        ),
      )
      // 2) PATCH repoint → success
      .mockResolvedValueOnce(
        jsonResponse(cfSuccess({ id: "rec_stale", type: "A", name: "f", content: "203.0.113.4", ttl: 1, proxied: true })),
      );

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", proxied: true, skipVerify: true },
      TEST_CONFIG,
    );

    expect(result).toEqual({
      ok: true,
      fqdn: "inst-foo.agents.hermesos.cloud",
      recordId: "rec_stale",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [patchUrl, patchInit] = fetchSpy.mock.calls[1]!;
    expect(patchUrl).toContain("/dns_records/rec_stale");
    expect(patchInit?.method).toBe("PATCH");
    expect(JSON.parse(patchInit?.body as string)).toMatchObject({ content: "203.0.113.4", proxied: true });
  });

  it("deletes duplicate records and keeps a single repointed record", async () => {
    const deletedIds: string[] = [];
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET") {
        // find-all returns two records: keeper (correct IP) + a stale dup.
        return Promise.resolve(
          jsonResponse(
            cfSuccess([
              { id: "rec_keep", type: "A", name: "inst-foo.agents.hermesos.cloud", content: "203.0.113.4", ttl: 1, proxied: true },
              { id: "rec_dup", type: "A", name: "inst-foo.agents.hermesos.cloud", content: "9.9.9.9", ttl: 1, proxied: true },
            ]),
          ),
        );
      }
      if (method === "DELETE") {
        deletedIds.push(url.split("/").pop()!);
        return Promise.resolve(jsonResponse(cfSuccess({ id: "rec_dup" })));
      }
      return Promise.resolve(jsonResponse(cfSuccess({ id: "rec_keep" })));
    });

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", proxied: true, skipVerify: true },
      TEST_CONFIG,
    );

    expect(result).toEqual({
      ok: true,
      fqdn: "inst-foo.agents.hermesos.cloud",
      recordId: "rec_keep",
    });
    expect(deletedIds).toEqual(["rec_dup"]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("adopts a raced record when create fails after find-all saw none", async () => {
    jest
      .spyOn(global, "fetch")
      // 1) GET find-all → none
      .mockResolvedValueOnce(jsonResponse(cfSuccess([])))
      // 2) POST create → already exists (lost the race)
      .mockResolvedValueOnce(jsonResponse(cfError(81053, "An A record with that host already exists."), 400))
      // 3) GET find → the record the racer created (same IP)
      .mockResolvedValueOnce(
        jsonResponse(
          cfSuccess([
            { id: "rec_raced", type: "A", name: "inst-foo.agents.hermesos.cloud", content: "203.0.113.4", ttl: 1 },
          ]),
        ),
      );

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", skipVerify: true },
      TEST_CONFIG,
    );

    expect(result).toEqual({
      ok: true,
      fqdn: "inst-foo.agents.hermesos.cloud",
      recordId: "rec_raced",
    });
  });

  it("returns error when create fails and no existing record can be found", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse(cfSuccess([]))) // find-all → none
      .mockResolvedValueOnce(jsonResponse(cfError(9100, "Permission denied"), 403)) // create fails
      .mockResolvedValueOnce(jsonResponse(cfSuccess([]))); // race find → still none

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", skipVerify: true },
      TEST_CONFIG,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Permission denied/);
  });

  it("rolls back a freshly created record when propagation times out", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      // 1) GET find-all → none
      .mockResolvedValueOnce(jsonResponse(cfSuccess([])))
      // 2) POST create → success
      .mockResolvedValueOnce(
        jsonResponse(cfSuccess({ id: "rec_doomed", type: "A", name: "f", content: "203.0.113.4", ttl: 1 })),
      )
      // 3) DELETE rollback → success
      .mockResolvedValueOnce(jsonResponse(cfSuccess({ id: "rec_doomed" })));
    const resolve4 = jest.fn().mockResolvedValue(["9.9.9.9"]); // never matches

    const result = await mintInstanceDns(
      { subdomain: "inst-foo", ip: "203.0.113.4", resolve4, propagationTimeoutMs: 30 },
      TEST_CONFIG,
    );

    expect(result).toEqual({ ok: false, error: "dns_propagation_timeout" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [rollbackUrl, rollbackInit] = fetchSpy.mock.calls[2]!;
    expect(rollbackUrl).toContain("/dns_records/rec_doomed");
    expect(rollbackInit?.method).toBe("DELETE");
  });
});

describe("deriveDnsDomainFromGatewayUrl", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "tok",
    CLOUDFLARE_ZONE_ID: "zone",
    CLOUDFLARE_DNS_DOMAIN: "agents.hermesos.cloud",
  };

  it("returns the zone domain for a per-instance URL directly under the zone", () => {
    expect(
      deriveDnsDomainFromGatewayUrl(
        "https://inst-abc.agents.hermesos.cloud",
        "inst-abc",
        env,
      ),
    ).toBe("agents.hermesos.cloud");
  });

  it("preserves a per-host sub-subdomain shape so legacy URLs round-trip exactly", () => {
    // The recent PROXMOX_FIXTURENODE2_GATEWAY_DOMAIN-style instances live at
    // <sub>.fixturenodea.<zone>. Returning just `agents.hermesos.cloud` would
    // silently flip them to a different URL on redeploy.
    expect(
      deriveDnsDomainFromGatewayUrl(
        "https://inst-abc.fixturenode2.agents.hermesos.cloud",
        "inst-abc",
        env,
      ),
    ).toBe("fixturenode2.agents.hermesos.cloud");
  });

  it("accepts the exact configured Proxmox gateway domain outside the nested DNS namespace", () => {
    expect(
      deriveDnsDomainFromGatewayUrl(
        "https://inst-abc.hermesos.cloud",
        "inst-abc",
        {
          ...env,
          CLOUDFLARE_DNS_DOMAIN: "agents.canary.hermesos.cloud",
          PROXMOX_GATEWAY_DOMAIN: "hermesos.cloud",
        },
      ),
    ).toBe("hermesos.cloud");
  });

  it("returns null for a sslip gateway URL", () => {
    expect(
      deriveDnsDomainFromGatewayUrl("https://203-0-113-4.sslip.io", "inst-abc", env),
    ).toBeNull();
  });

  it("returns null when cloudflare is not configured", () => {
    expect(
      deriveDnsDomainFromGatewayUrl(
        "https://inst-abc.agents.hermesos.cloud",
        "inst-abc",
        {},
      ),
    ).toBeNull();
  });

  it("returns null for null/empty/malformed inputs", () => {
    expect(deriveDnsDomainFromGatewayUrl(null, "inst-abc", env)).toBeNull();
    expect(deriveDnsDomainFromGatewayUrl("", "inst-abc", env)).toBeNull();
    expect(deriveDnsDomainFromGatewayUrl("not a url", "inst-abc", env)).toBeNull();
    expect(deriveDnsDomainFromGatewayUrl("https://x.example.com", null, env)).toBeNull();
    expect(deriveDnsDomainFromGatewayUrl("https://x.example.com", "", env)).toBeNull();
  });

  it("returns null when the URL is on a different domain than the zone", () => {
    expect(
      deriveDnsDomainFromGatewayUrl(
        "https://inst-abc.example.com",
        "inst-abc",
        env,
      ),
    ).toBeNull();
  });

  it("returns null when the URL hostname doesn't start with the subdomain", () => {
    expect(
      deriveDnsDomainFromGatewayUrl(
        "https://other-sub.agents.hermesos.cloud",
        "inst-abc",
        env,
      ),
    ).toBeNull();
  });
});

describe("removeInstanceDns", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns cloudflare_not_configured when no config", async () => {
    const result = await removeInstanceDns("x", null);
    expect(result).toEqual({ ok: false, error: "cloudflare_not_configured" });
  });

  it("deletes the record when found", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(
          cfSuccess([
            { id: "rec_to_kill", type: "A", name: "inst-foo.agents.hermesos.cloud", content: "203.0.113.4", ttl: 1 },
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(cfSuccess({ id: "rec_to_kill" })));

    const result = await removeInstanceDns("inst-foo", TEST_CONFIG);

    expect(result).toEqual({ ok: true, removed: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns ok+removed=false when record is already gone", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(cfSuccess([])));
    const result = await removeInstanceDns("missing", TEST_CONFIG);
    expect(result).toEqual({ ok: true, removed: false });
  });

  it("surfaces API errors as ok=false", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(cfError(7003, "Could not route"), 400));
    const result = await removeInstanceDns("x", TEST_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not route/);
  });
});

describe("removeInstanceDnsBestEffort", () => {
  const warn = log.warn as jest.Mock;

  beforeEach(() => {
    warn.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());

  it("no-ops when subdomain is null", async () => {
    await removeInstanceDnsBestEffort(null, { source: "test" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("no-ops when subdomain is undefined", async () => {
    await removeInstanceDnsBestEffort(undefined, { source: "test" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("no-ops when subdomain is empty string", async () => {
    await removeInstanceDnsBestEffort("", { source: "test" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not log on success", async () => {
    // Cloudflare returns no matching record → ok+removed=false, still ok=true.
    // The helper has no configOverride seam, so we set env directly.
    const prevEnv = { ...process.env };
    process.env.CLOUDFLARE_API_TOKEN = TEST_CONFIG.apiToken;
    process.env.CLOUDFLARE_ZONE_ID = TEST_CONFIG.zoneId;
    process.env.CLOUDFLARE_DNS_DOMAIN = TEST_CONFIG.domain;
    try {
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(cfSuccess([])));
      await removeInstanceDnsBestEffort("inst-foo", { source: "test" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env = prevEnv;
    }
  });

  it("deletes from an explicit persisted gateway domain instead of the default namespace", async () => {
    const prevEnv = { ...process.env };
    process.env.CLOUDFLARE_API_TOKEN = TEST_CONFIG.apiToken;
    process.env.CLOUDFLARE_ZONE_ID = TEST_CONFIG.zoneId;
    process.env.CLOUDFLARE_DNS_DOMAIN = TEST_CONFIG.domain;
    try {
      const fetchSpy = jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(jsonResponse(cfSuccess([
          {
            id: "rec_static_origin",
            type: "A",
            name: "inst-foo.hermesos.cloud",
            content: "203.0.113.4",
            ttl: 1,
          },
        ])))
        .mockResolvedValueOnce(jsonResponse(cfSuccess({ id: "rec_static_origin" })));

      await removeInstanceDnsBestEffort(
        "inst-foo",
        { source: "test" },
        { dnsDomain: "hermesos.cloud" },
      );

      expect(fetchSpy.mock.calls[0]?.[0]).toContain(
        "name=inst-foo.hermesos.cloud",
      );
      expect(fetchSpy.mock.calls[1]?.[0]).toContain(
        "/dns_records/rec_static_origin",
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env = prevEnv;
    }
  });

  it("logs a structured warning when removeInstanceDns returns ok=false", async () => {
    // No env config → removeInstanceDns returns cloudflare_not_configured.
    // The helper must surface that as a warning, NOT throw.
    await removeInstanceDnsBestEffort("inst-foo", {
      source: "test",
      instanceId: "inst-1",
      userId: "user-1",
    });
    expect(warn).toHaveBeenCalledWith(
      "cloudflare DNS cleanup failed; continuing",
      expect.objectContaining({
        source: "test",
        instanceId: "inst-1",
        userId: "user-1",
        failureType: "cloudflare_dns_cleanup_failed",
        error: "cloudflare_not_configured",
      }),
    );
  });

  it("never throws even when removeInstanceDns rejects", async () => {
    // Force the underlying fetch to throw — removeInstanceDns catches and
    // returns ok=false, so this exercises that path. Even if removeInstanceDns
    // itself somehow threw, the helper's .catch() wrapper would still log
    // and resolve. This is the contract callers rely on to drop the
    // try/catch at the call site.
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    await expect(
      removeInstanceDnsBestEffort("inst-foo", { source: "test" }, ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "cloudflare DNS cleanup failed; continuing",
      expect.objectContaining({
        source: "test",
        failureType: "cloudflare_dns_cleanup_failed",
      }),
    );
  });

  it("forwards arbitrary extra ctx fields to the log line", async () => {
    // Callers spread their full RequestContext (requestId, route, method,
    // traceId) into ctx; the helper's index signature accepts them and
    // log.warn carries them through.
    await removeInstanceDnsBestEffort("inst-foo", {
      source: "test",
      requestId: "req_abc",
      route: "/api/foo",
      method: "DELETE",
      traceId: "trace_xyz",
    });
    expect(warn).toHaveBeenCalledWith(
      "cloudflare DNS cleanup failed; continuing",
      expect.objectContaining({
        requestId: "req_abc",
        route: "/api/foo",
        method: "DELETE",
        traceId: "trace_xyz",
      }),
    );
  });
});
