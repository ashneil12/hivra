/**
 * Unit tests for the Cloudflare DNS reconciler. Pure planner behaviour
 * (skip reasons, grace window, max-delete cap) plus a happy/unhappy run
 * of the orchestrator with the supabase admin client and global fetch
 * mocked. No real network, no real DB.
 */

import { planReconcile, loadLiveSubdomains } from "@/lib/recovery/cloudflare-dns-reconcile";
import type {
  CloudflareDnsConfig,
  CloudflareDnsRecord,
} from "@/lib/services/cloudflare-dns";

const CONFIG: CloudflareDnsConfig = {
  apiToken: "cf_test_token",
  zoneId: "zone123",
  domain: "agents.hermesos.cloud",
};

function record(partial: Partial<CloudflareDnsRecord> & { id: string; name: string }): CloudflareDnsRecord {
  return {
    type: "A",
    content: "192.0.2.1",
    ttl: 1,
    proxied: false,
    ...partial,
  };
}

describe("planReconcile", () => {
  const now = Date.parse("2026-05-18T12:00:00Z");
  const oldCreated = "2026-05-01T00:00:00Z"; // way outside grace
  const freshCreated = "2026-05-18T11:30:00Z"; // 30 min ago — inside default 1h grace

  it("returns an empty plan when every record has a live row", () => {
    const records = [
      record({ id: "1", name: "live-a.agents.hermesos.cloud", created_on: oldCreated }),
      record({ id: "2", name: "live-b.agents.hermesos.cloud", created_on: oldCreated }),
    ];
    const { candidates, skipped } = planReconcile({
      records,
      liveSubdomains: new Set(["live-a", "live-b"]),
      config: CONFIG,
      now,
    });
    expect(candidates).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual([
      "live_instance_exists",
      "live_instance_exists",
    ]);
  });

  it("flags records with no live row as candidates", () => {
    const records = [
      record({ id: "ghost", name: "ghost.agents.hermesos.cloud", created_on: oldCreated }),
      record({ id: "live", name: "live.agents.hermesos.cloud", created_on: oldCreated }),
    ];
    const { candidates, skipped } = planReconcile({
      records,
      liveSubdomains: new Set(["live"]),
      config: CONFIG,
      now,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      recordId: "ghost",
      fqdn: "ghost.agents.hermesos.cloud",
      subdomain: "ghost",
    });
    expect(skipped.map((s) => s.reason)).toEqual(["live_instance_exists"]);
  });

  it("skips records younger than the grace window", () => {
    const records = [
      record({ id: "fresh", name: "fresh.agents.hermesos.cloud", created_on: freshCreated }),
    ];
    const { candidates, skipped } = planReconcile({
      records,
      liveSubdomains: new Set(),
      config: CONFIG,
      now,
    });
    expect(candidates).toEqual([]);
    expect(skipped[0]?.reason).toBe("within_grace_period");
  });

  it("skips records outside the configured domain", () => {
    const records = [
      record({ id: "apex", name: "agents.hermesos.cloud", created_on: oldCreated }),
      record({ id: "other", name: "marketing.hermesos.cloud", created_on: oldCreated }),
    ];
    const { candidates, skipped } = planReconcile({
      records,
      liveSubdomains: new Set(),
      config: CONFIG,
      now,
    });
    expect(candidates).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual([
      "not_under_configured_domain",
      "not_under_configured_domain",
    ]);
  });

  it("skips deeper subdomains (legacy per-host wildcards)", () => {
    const records = [
      record({ id: "legacy", name: "abc.fixturenode2.agents.hermesos.cloud", created_on: oldCreated }),
    ];
    const { candidates, skipped } = planReconcile({
      records,
      liveSubdomains: new Set(),
      config: CONFIG,
      now,
    });
    expect(candidates).toEqual([]);
    expect(skipped[0]?.reason).toBe("deeper_subdomain");
  });

  it("caps candidates at maxDeletes and marks the overflow as cap_reached", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      record({ id: String(i), name: `g${i}.agents.hermesos.cloud`, created_on: oldCreated }),
    );
    const { candidates, skipped } = planReconcile({
      records,
      liveSubdomains: new Set(),
      config: CONFIG,
      now,
      maxDeletes: 3,
    });
    expect(candidates).toHaveLength(3);
    expect(skipped.map((s) => s.reason)).toEqual([
      "delete_cap_reached",
      "delete_cap_reached",
    ]);
  });

  it("matches subdomains case-insensitively", () => {
    const records = [
      record({ id: "1", name: "Ghost.agents.hermesos.cloud", created_on: oldCreated }),
    ];
    const { candidates } = planReconcile({
      records,
      liveSubdomains: new Set(["ghost"]),
      config: CONFIG,
      now,
    });
    expect(candidates).toEqual([]);
  });

  it("treats records without created_on as eligible regardless of age", () => {
    const records = [
      record({ id: "no-date", name: "g.agents.hermesos.cloud" }),
    ];
    const { candidates } = planReconcile({
      records,
      liveSubdomains: new Set(),
      config: CONFIG,
      now,
    });
    expect(candidates).toHaveLength(1);
  });
});

describe("runCloudflareDnsReconcile", () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  let prevConsoleLog: typeof console.log;
  let prevConsoleWarn: typeof console.warn;
  let prevConsoleInfo: typeof console.info;
  let prevConsoleError: typeof console.error;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CLOUDFLARE_API_TOKEN = "cf_token";
    process.env.CLOUDFLARE_ZONE_ID = "zone123";
    process.env.CLOUDFLARE_DNS_DOMAIN = "agents.hermesos.cloud";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    prevConsoleLog = console.log;
    prevConsoleWarn = console.warn;
    prevConsoleInfo = console.info;
    prevConsoleError = console.error;
    console.log = jest.fn();
    console.warn = jest.fn();
    console.info = jest.fn();
    console.error = jest.fn();
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    console.log = prevConsoleLog;
    console.warn = prevConsoleWarn;
    console.info = prevConsoleInfo;
    console.error = prevConsoleError;
    jest.restoreAllMocks();
  });

  function mockOpsEvents() {
    jest.doMock("@/lib/ops-events", () => ({
      reportOpsEvent: jest.fn().mockResolvedValue({ id: "ops-1" }),
      // Required by logger.ts at import time.
      sanitizeOpsMetadata: (m: Record<string, unknown> | undefined) => m ?? {},
      buildOpsEventFingerprint: () => "fp",
      archiveOpsEvents: jest.fn(),
    }));
  }

  function mockSupabase(liveSubdomains: string[]) {
    const single = jest.fn().mockResolvedValue({
      data: liveSubdomains.map((subdomain) => ({ subdomain })),
      error: null,
    });
    const range = jest.fn().mockReturnValue(single);
    // loadLiveSubdomains chains `.order("id")` before `.range(...)`.
    const order = jest.fn().mockReturnValue({ range });
    const notNull = jest.fn().mockReturnValue({ order });
    const neq = jest.fn().mockReturnValue({ not: notNull });
    const select = jest.fn().mockReturnValue({ neq });
    const fromMock = jest.fn().mockReturnValue({ select });
    jest.doMock("@/lib/supabase", () => ({
      supabaseAdmin: { from: fromMock },
    }));
    // The Supabase chain ends with `.range(...)` which must return an awaitable.
    // Make `.range` return the resolved data shape directly.
    range.mockResolvedValue({
      data: liveSubdomains.map((subdomain) => ({ subdomain })),
      error: null,
    });
    return { fromMock };
  }

  function mockCloudflareFetch(opts: {
    records: CloudflareDnsRecord[];
    deleteFails?: Set<string>;
  }) {
    const deletes: string[] = [];
    const fetchMock = jest.fn(async (url: string | URL, init: RequestInit = {}) => {
      const u = typeof url === "string" ? url : url.toString();
      if (init.method === "DELETE") {
        const id = u.split("/").pop()!;
        deletes.push(id);
        if (opts.deleteFails?.has(id)) {
          return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "boom" }] }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ success: true, result: { id } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // GET list call
      return new Response(
        JSON.stringify({
          success: true,
          result: opts.records,
          result_info: { page: 1, per_page: 1000, total_pages: 1, count: opts.records.length, total_count: opts.records.length },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;
    return { fetchMock, deletes };
  }

  it("returns would_delete entries when the flag is off", async () => {
    delete process.env.CLOUDFLARE_DNS_RECONCILE_ENABLED;
    mockOpsEvents();
    mockSupabase(["live"]);
    const { deletes } = mockCloudflareFetch({
      records: [
        record({ id: "ghost", name: "ghost.agents.hermesos.cloud", created_on: "2026-05-01T00:00:00Z" }),
        record({ id: "live", name: "live.agents.hermesos.cloud", created_on: "2026-05-01T00:00:00Z" }),
      ],
    });

    const { runCloudflareDnsReconcile: run } = await import("@/lib/recovery/cloudflare-dns-reconcile");
    const summary = await run();
    expect(summary.enabled).toBe(false);
    expect(summary.deletedCount).toBe(0);
    expect(summary.wouldDeleteCount).toBe(1);
    expect(summary.results.map((r) => r.outcome)).toEqual(["would_delete"]);
    expect(deletes).toEqual([]);
  });

  it("deletes orphan records when the flag is on", async () => {
    process.env.CLOUDFLARE_DNS_RECONCILE_ENABLED = "1";
    mockOpsEvents();
    mockSupabase(["live"]);
    const { deletes } = mockCloudflareFetch({
      records: [
        record({ id: "ghost-1", name: "ghost-1.agents.hermesos.cloud", created_on: "2026-05-01T00:00:00Z" }),
        record({ id: "live", name: "live.agents.hermesos.cloud", created_on: "2026-05-01T00:00:00Z" }),
      ],
    });

    const { runCloudflareDnsReconcile: run } = await import("@/lib/recovery/cloudflare-dns-reconcile");
    const summary = await run();
    expect(summary.enabled).toBe(true);
    expect(summary.deletedCount).toBe(1);
    expect(summary.results.map((r) => r.outcome)).toEqual(["deleted"]);
    expect(deletes).toEqual(["ghost-1"]);
  });

  it("records delete_failed when Cloudflare returns an error", async () => {
    process.env.CLOUDFLARE_DNS_RECONCILE_ENABLED = "1";
    mockOpsEvents();
    mockSupabase([]);
    mockCloudflareFetch({
      records: [
        record({ id: "boom", name: "boom.agents.hermesos.cloud", created_on: "2026-05-01T00:00:00Z" }),
      ],
      deleteFails: new Set(["boom"]),
    });

    const { runCloudflareDnsReconcile: run } = await import("@/lib/recovery/cloudflare-dns-reconcile");
    const summary = await run();
    expect(summary.deletedCount).toBe(0);
    expect(summary.deleteFailedCount).toBe(1);
    expect(summary.results[0]?.outcome).toBe("delete_failed");
  });

  it("throws when Cloudflare config is missing", async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    mockOpsEvents();
    mockSupabase([]);
    const { runCloudflareDnsReconcile: run } = await import("@/lib/recovery/cloudflare-dns-reconcile");
    await expect(run()).rejects.toThrow(/Cloudflare DNS not configured/);
  });
});

describe("loadLiveSubdomains pagination", () => {
  function builderReturning(pages: Array<Array<{ subdomain: string | null }>>, orderCols: string[]) {
    let call = 0;
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      neq: () => builder,
      not: () => builder,
      order: (col: string) => {
        orderCols.push(col);
        return builder;
      },
      range: () => {
        const data = pages[call] ?? [];
        call += 1;
        return Promise.resolve({ data, error: null });
      },
    });
    return { from: () => builder } as unknown as Parameters<typeof loadLiveSubdomains>[0];
  }

  it("orders by a stable key and never drops a row that lands on a later page", async () => {
    const orderCols: string[] = [];
    // First page is full (pageSize=1000) so the loop fetches a second page.
    const page0 = Array.from({ length: 1000 }, (_, i) => ({ subdomain: `agent-${i}` }));
    const page1 = [{ subdomain: "agent-1000" }, { subdomain: "AGENT-1001" }];
    const supabase = builderReturning([page0, page1], orderCols);

    const set = await loadLiveSubdomains(supabase);

    // The whole point of the fix: the query is ordered by a stable key.
    expect(orderCols).toContain("id");
    // Both pages are unioned; the row that landed on page 2 is not lost.
    expect(set.has("agent-0")).toBe(true);
    expect(set.has("agent-1000")).toBe(true);
    // Subdomains are normalized to lowercase.
    expect(set.has("agent-1001")).toBe(true);
    expect(set.size).toBe(1002);
  });

  it("propagates a query error instead of returning a partial set", async () => {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: () => builder,
      neq: () => builder,
      not: () => builder,
      order: () => builder,
      range: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    });
    const supabase = { from: () => builder } as unknown as Parameters<typeof loadLiveSubdomains>[0];
    await expect(loadLiveSubdomains(supabase)).rejects.toThrow(/boom/);
  });
});
