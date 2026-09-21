import { NextRequest } from "next/server";

import { GET } from "../route";
import { archiveInstance } from "@/lib/services/cold-storage-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/services/cold-storage-service", () => ({
  archiveInstance: jest.fn(),
}));

jest.mock("@/lib/cron-heartbeat", () => ({
  recordCronHeartbeat: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

type CandidateRow = {
  id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  resource_tier: string | null;
  last_lifecycle_transition_at: string | null;
};

// Stub the two hermes_instances reads the route makes before the dispatch loop:
//  1) stuck-archiving recovery UPDATE (.update().eq().lt().is().select()) — returns []
//  2) candidate SELECT (.select().eq()...limit()) — returns the candidate rows
function stubSupabase(candidates: CandidateRow[]) {
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table !== "hermes_instances") {
      throw new Error(`Unexpected table ${table}`);
    }
    const query: Record<string, unknown> = {};
    let isUpdate = false;
    query.update = jest.fn(() => {
      isUpdate = true;
      return query;
    });
    query.select = jest.fn(() => {
      // Terminal for the recovery update chain (resolve []); for the candidate
      // select chain, .select() is first and the chain continues to .limit().
      if (isUpdate) {
        return Promise.resolve({ data: [], error: null });
      }
      return query;
    });
    query.eq = jest.fn(() => query);
    query.is = jest.fn(() => query);
    query.lt = jest.fn(() => query);
    query.in = jest.fn(() => query);
    query.order = jest.fn(() => query);
    query.limit = jest.fn(() => Promise.resolve({ data: candidates, error: null }));
    return query;
  });
}

const makeRequest = (authorization?: string) =>
  new Request("http://localhost/api/cron/archive-stopped-vms", {
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;

const ORIGINAL_ENV = process.env;

describe("GET /api/cron/archive-stopped-vms time budget", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      CRON_SECRET: "cron-secret",
      // Enable the live archive path (default is dry-run no-op).
      COLD_STORAGE_ARCHIVE_ENABLED: "true",
    };
    (archiveInstance as jest.Mock).mockResolvedValue({ ok: true, archiveUri: "box://x" });
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  it("defers remaining candidates once the wall-clock budget is exhausted (no extra VMs archived)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-24T03:00:00Z"));

    // All on the SAME host so the dispatch loop is serial — deterministic for
    // the budget gate. 20 candidates, each archive advances the clock 60s; the
    // 700s budget allows ~12 before the gate trips.
    const candidates: CandidateRow[] = Array.from({ length: 20 }, (_, i) => ({
      id: `inst_${i}`,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 600 + i,
      resource_tier: "credit_base",
      last_lifecycle_transition_at: "2026-06-20T03:00:00Z",
    }));
    stubSupabase(candidates);

    (archiveInstance as jest.Mock).mockImplementation(async () => {
      jest.advanceTimersByTime(60_000);
      return { ok: true, archiveUri: "box://x" };
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.timedOut).toBe(true);
    expect(body.data.deferred).toBeGreaterThan(0);
    // archiveInstance was called only for the archived prefix — the deferred
    // tail's VMs were never touched (no destroy).
    expect((archiveInstance as jest.Mock).mock.calls.length).toBe(body.data.archived);
    expect(body.data.archived + body.data.deferred).toBe(20);
    // The candidate selection is unchanged (still 20); the budget only bounds
    // how many we acted on this run.
    expect(body.data.candidates).toBe(20);
  });

  it("bounds each archive's host-script timeout to the remaining function budget (never the fixed 15min)", async () => {
    // Regression: prod gave every archive a fixed 15-min (900s) host-script
    // timeout that EXCEEDS maxDuration (800s), so one slow archive SIGKILLed the
    // function before it could stamp its dead-man heartbeat — the cron looked
    // dead for days and flooded admin alerts. Each archive must instead be
    // handed only the runway left before the function ceiling.
    jest.useFakeTimers().setSystemTime(new Date("2026-06-24T03:00:00Z"));

    const candidates: CandidateRow[] = [
      {
        id: "inst_0",
        proxmox_node: "fixturenode1",
        proxmox_vmid: 601,
        resource_tier: "credit_base",
        last_lifecycle_transition_at: "2026-06-20T03:00:00Z",
      },
    ];
    stubSupabase(candidates);
    (archiveInstance as jest.Mock).mockResolvedValue({ ok: true, archiveUri: "box://x" });

    await GET(makeRequest("Bearer cron-secret"));

    expect(archiveInstance).toHaveBeenCalledTimes(1);
    const call = (archiveInstance as jest.Mock).mock.calls[0];
    // archiveInstance(supabase, instanceId, deps, options)
    const options = call[3] as { maxScriptTimeoutMs?: number };
    const timeout = options?.maxScriptTimeoutMs ?? 0;
    expect(timeout).toBeGreaterThan(0);
    // The SCRIPT budget must reserve the ~180s post-archive tail (manifest +
    // qm destroy + caddy cleanup) below the 800s−25s hard deadline, so the whole
    // archiveInstance() — not just the script — finishes before maxDuration.
    // 800s − 25s headroom − 180s tail = 595s max for the archive script itself.
    expect(timeout).toBeLessThanOrEqual(800_000 - 25_000 - 180_000);
    // Crucially NOT the old fixed 15-min (900s) that exceeded maxDuration.
    expect(timeout).toBeLessThan(15 * 60_000);
  });

  it("archives the whole batch and reports timedOut=false when the budget is ample", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-24T03:00:00Z"));

    const candidates: CandidateRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `inst_${i}`,
      proxmox_node: "fixturenode1",
      proxmox_vmid: 600 + i,
      resource_tier: "credit_base",
      last_lifecycle_transition_at: "2026-06-20T03:00:00Z",
    }));
    stubSupabase(candidates);

    // Clock barely advances — never hits the budget.
    (archiveInstance as jest.Mock).mockImplementation(async () => {
      jest.advanceTimersByTime(1_000);
      return { ok: true, archiveUri: "box://x" };
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.timedOut).toBe(false);
    expect(body.data.deferred).toBe(0);
    expect(body.data.archived).toBe(5);
  });

  it("defers a late batch member instead of giving its archive only 155 seconds", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-22T00:00:00Z"));

    const candidates: CandidateRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `inst_${i}`,
      proxmox_node: "fixturenode19",
      proxmox_vmid: 1910 + i,
      resource_tier: "credit_base",
      last_lifecycle_transition_at: "2026-08-19T00:00:00Z",
    }));
    stubSupabase(candidates);

    // Production archives averaged about 110s. After four successes the fifth
    // had only 155s of script runway, timed out after stopping its containers,
    // and left the originally-stopped VM running. That is not useful runway.
    (archiveInstance as jest.Mock).mockImplementation(async () => {
      jest.advanceTimersByTime(110_000);
      return { ok: true, archiveUri: "box://x" };
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(archiveInstance).toHaveBeenCalledTimes(4);
    expect(body.data.archived).toBe(4);
    expect(body.data.deferred).toBe(1);
    expect(body.data.timedOut).toBe(true);
  });
});
