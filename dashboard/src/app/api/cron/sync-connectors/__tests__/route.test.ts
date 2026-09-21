import { NextRequest } from "next/server";

import { POST, GET } from "../route";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { supabaseAdmin } from "@/lib/supabase";
import { syncComposioToInstance } from "@/lib/composio/sync-connectors";

jest.mock("@/lib/bearer-auth", () => ({ verifyBearerHeader: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/composio/sync-connectors", () => ({ syncComposioToInstance: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function req(body: unknown): NextRequest {
  return { json: () => Promise.resolve(body) } as unknown as NextRequest;
}

function mockInstances(rows: Array<{ id: string; user_id?: string | null; backend?: string }>) {
  const chain: Record<string, unknown> = {};
  chain.select = jest.fn(() => chain);
  chain.in = jest.fn(() => Promise.resolve({ data: rows, error: null }));
  (supabaseAdmin!.from as jest.Mock).mockReturnValue(chain);
}

describe("POST /api/cron/sync-connectors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (verifyBearerHeader as jest.Mock).mockReturnValue(true);
    (process.env as Record<string, string>).CRON_SECRET = "test-cron-secret";
    (syncComposioToInstance as jest.Mock).mockResolvedValue({ applied: true, backend: "webfree" });
    mockInstances([{ id: "i1", user_id: "u1", backend: "webui" }]);
  });

  it("401 when the cron bearer is invalid", async () => {
    (verifyBearerHeader as jest.Mock).mockReturnValue(false);
    const res = await POST(req({ instanceIds: ["i1"] }));
    expect(res.status).toBe(401);
  });

  it("400 when instanceIds is missing", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("syncs each box via the shared helper, using the box OWNER user id", async () => {
    mockInstances([
      { id: "i1", user_id: "u1", backend: "webui" },
      { id: "i2", user_id: "u2", backend: "webui" },
    ]);
    const res = await POST(req({ instanceIds: ["i1", "i2"] }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.total).toBe(2);
    expect(json.data.applied).toBe(2);
    expect(syncComposioToInstance).toHaveBeenCalledTimes(2);
    // Ops backfill is config-only — must not bounce boxes / drop live sessions.
    expect(syncComposioToInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "i1", userId: "u1", restart: "never" }),
    );
  });

  it("records a per-box failure without aborting the batch", async () => {
    mockInstances([
      { id: "i1", user_id: "u1", backend: "webui" },
      { id: "i2", user_id: "u2", backend: "webui" },
    ]);
    (syncComposioToInstance as jest.Mock)
      .mockResolvedValueOnce({ applied: true, backend: "webfree" })
      .mockRejectedValueOnce(new Error("box unreachable"));
    const res = await POST(req({ instanceIds: ["i1", "i2"] }));
    const json = await res.json();
    expect(json.data.applied).toBe(1);
    expect(json.data.results.find((r: { id: string }) => r.id === "i2").error).toContain("unreachable");
  });

  it("marks unknown instance ids as not_found", async () => {
    mockInstances([{ id: "i1", user_id: "u1", backend: "webui" }]);
    const res = await POST(req({ instanceIds: ["i1", "ghost"] }));
    const json = await res.json();
    expect(json.data.results.find((r: { id: string }) => r.id === "ghost").reason).toBe("not_found");
  });
});

function getReq(url = "https://x/api/cron/sync-connectors"): NextRequest {
  return { url, headers: { get: () => null } } as unknown as NextRequest;
}

// The reconcile GET issues TWO queries: a count head-query, then a windowed
// data range-query. Model each as an awaitable builder that resolves to its own
// result regardless of which builder methods were chained.
function awaitableChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "range", "limit"]) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

function mockActiveInstances(
  rows: Array<{ id: string; user_id?: string | null }>,
  count = rows.length,
) {
  const from = supabaseAdmin!.from as jest.Mock;
  from.mockReset();
  from
    .mockReturnValueOnce(awaitableChain({ count, error: null }))
    .mockReturnValueOnce(awaitableChain({ data: rows, error: null }));
}

describe("GET /api/cron/sync-connectors (reconcile sweep)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (verifyBearerHeader as jest.Mock).mockReturnValue(true);
    (process.env as Record<string, string>).CRON_SECRET = "test-cron-secret";
    (syncComposioToInstance as jest.Mock).mockResolvedValue({
      applied: true,
      backend: "webfree",
      changed: true,
      restarted: false,
    });
    mockActiveInstances([{ id: "i1", user_id: "u1" }]);
  });

  it("401 when the cron bearer is invalid", async () => {
    (verifyBearerHeader as jest.Mock).mockReturnValue(false);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it("syncs active boxes config-only (restart: never), skipping owner-less rows", async () => {
    mockActiveInstances([
      { id: "i1", user_id: "u1" },
      { id: "i2", user_id: null },
      { id: "i3", user_id: "u3" },
    ]);
    const res = await GET(getReq());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.scanned).toBe(2); // owner-less i2 dropped
    expect(json.data.applied).toBe(2);
    expect(json.data.changed).toBe(2);
    expect(syncComposioToInstance).toHaveBeenCalledTimes(2);
    // Scheduled sweep is config-only — must not ripple-restart the fleet.
    expect(syncComposioToInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "i1", userId: "u1", restart: "never" }),
    );
  });

  it("counts a per-box failure without aborting the sweep", async () => {
    mockActiveInstances([
      { id: "i1", user_id: "u1" },
      { id: "i2", user_id: "u2" },
    ]);
    (syncComposioToInstance as jest.Mock)
      .mockResolvedValueOnce({ applied: true, backend: "webfree", changed: false, restarted: false })
      .mockRejectedValueOnce(new Error("box unreachable"));
    const res = await GET(getReq());
    const json = await res.json();
    expect(json.data.applied).toBe(1);
    expect(json.data.errored).toBe(1);
  });
});
