/**
 * One env-drifted PVE host must not abort the whole fleet backup batch.
 *
 * resolveProxmoxHostEnv is fail-closed: it THROWS when a host slug has no
 * matching PROXMOX_<SLUG>_* overrides. It used to sit OUTSIDE processCandidate's
 * try, under Promise.all — so a single drifted host turned into an unhandled
 * rejection that aborted the entire batch: the route 500'd and BOTH the failure
 * ops event and the dead-man heartbeat were skipped. Per-instance restic backups
 * then stopped for every OTHER host, and nothing named the host at fault.
 */
import { NextRequest } from "next/server";

import { GET } from "../route";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { reportOpsEvent } from "@/lib/ops-events";
import { resolveProxmoxHostEnv, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
// Keep the real module: logger.ts imports sanitizeOpsMetadata from it, so a
// bare replacement breaks every log call inside the route.
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxHostEnv: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

const GOOD_ID = "11111111-1111-1111-1111-111111111111";
const DRIFTED_ID = "22222222-2222-2222-2222-222222222222";
const GOOD_HOST = "fixturenode1";
const DRIFTED_HOST = "fixturenode19";

function candidate(id: string, node: string) {
  return {
    id,
    proxmox_node: node,
    proxmox_vmid: 9001,
    resource_tier: "operator",
    lifecycle_state: "active",
    status: "running",
    ipv4_address: "10.240.0.1",
    last_instance_backup_at: null,
  };
}

function makeSupabaseMock(selectData: unknown[]) {
  function chain() {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "in", "or", "order"]) {
      builder[m] = jest.fn(() => builder);
    }
    builder.limit = jest.fn(() => Promise.resolve({ data: selectData, error: null }));
    builder.update = jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ error: null })) }));
    return builder;
  }
  return jest.fn(() => chain());
}

function request() {
  return new NextRequest("http://localhost/api/cron/daily-instance-backups", {
    method: "GET",
    headers: { authorization: "Bearer expected-secret" },
  });
}

describe("GET /api/cron/daily-instance-backups — one drifted host can't abort the fleet", () => {
  const originalEnv = { ...process.env };
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
  const mockedResolve = resolveProxmoxHostEnv as jest.Mock;
  const mockedRun = runProxmoxHostScript as jest.Mock;
  const mockedHeartbeat = recordCronHeartbeat as jest.Mock;
  const mockedOpsEvent = reportOpsEvent as jest.Mock;
  const spies: jest.SpyInstance[] = [];

  // The route's own escalation event, as distinct from the incidental ones
  // log.error emits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const failureEvent = (): any =>
    mockedOpsEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e?.source === "cron.daily_instance_backups_failed");

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "expected-secret";
    process.env.HERMES_RESTIC_MASTER_KEY = "test-master-key";
    process.env.DAILY_INSTANCE_BACKUPS_ENABLED = "true";
    for (const m of ["error", "warn", "log"] as const) {
      spies.push(jest.spyOn(console, m).mockImplementation(() => {}));
    }
    mockedRun.mockResolvedValue({ ok: true, stdout: "RESTIC_BACKUP_OK", stderr: "" });
    // fixturenodea's Vercel env drifted; fixturenodea is healthy.
    mockedResolve.mockImplementation((cfg: { hostSlug?: string }) => {
      if (cfg?.hostSlug === DRIFTED_HOST) {
        throw new Error(
          `Proxmox host routing config for ${DRIFTED_HOST} has no matching environment overrides`
        );
      }
      return { PROXMOX_EXEC_MODE: "ssh" };
    });
    mockedFrom.mockImplementation(
      makeSupabaseMock([candidate(DRIFTED_ID, DRIFTED_HOST), candidate(GOOD_ID, GOOD_HOST)])
    );
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    process.env = { ...originalEnv };
  });

  it("still backs up the healthy host, and reports the drifted one as a per-instance failure", async () => {
    const response = await GET(request());

    // The drifted host is listed FIRST, so under Promise.all its rejection
    // aborted the batch before fixturenodea was ever attempted.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.backedUp).toBe(1);
    expect(body.data.failed).toBe(1);

    // The healthy host's backup actually ran.
    expect(mockedRun).toHaveBeenCalledTimes(1);

    const failure = body.data.perInstance.find((r: { ok: boolean }) => !r.ok);
    expect(failure).toMatchObject({ id: DRIFTED_ID, host: DRIFTED_HOST, reason: "exception" });
    expect(failure.message).toContain(DRIFTED_HOST);
  });

  it("still stamps the dead-man heartbeat", async () => {
    await GET(request());
    // The whole point: a crash must not silence the watchdog meant to notice it.
    expect(mockedHeartbeat).toHaveBeenCalledWith("daily-instance-backups");
  });

  it("names the failing host in the ops event instead of swallowing it", async () => {
    await GET(request());

    // log.error also emits an ops event, so select the escalation by source
    // rather than counting calls.
    const event = failureEvent();
    expect(event).toBeDefined();
    expect(event.severity).toBe("warn");
    expect(event.metadata.failed_hosts).toEqual([DRIFTED_HOST]);
    expect(event.metadata.failed_instances[0]).toMatchObject({
      id: DRIFTED_ID,
      host: DRIFTED_HOST,
    });
  });

  it("does not fail the batch when every host is drifted", async () => {
    mockedResolve.mockImplementation(() => {
      throw new Error("Proxmox host routing config for fixturenode19 has no matching environment overrides");
    });

    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.failed).toBe(2);
    expect(body.data.backedUp).toBe(0);
    // Total failure is still a completed sweep — heartbeat + escalation both fire.
    expect(mockedHeartbeat).toHaveBeenCalledWith("daily-instance-backups");
    expect(failureEvent()).toBeDefined();
    expect(failureEvent().metadata.failed_hosts).toEqual([DRIFTED_HOST, GOOD_HOST]);
  });
});
