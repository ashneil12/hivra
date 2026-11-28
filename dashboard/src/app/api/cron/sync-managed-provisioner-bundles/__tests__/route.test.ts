import { NextRequest } from "next/server";

const mockProbe = jest.fn();
const mockSync = jest.fn();
const mockLoadBundle = jest.fn();
const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockHeartbeat = jest.fn();

jest.mock("@/lib/hivra/managed-provisioner-bundle-sync", () => ({
  ...jest.requireActual("@/lib/hivra/managed-provisioner-bundle-sync"),
  probeManagedProvisionerBundle: (...args: unknown[]) => mockProbe(...args),
  syncManagedProvisionerBundle: (...args: unknown[]) => mockSync(...args),
}));
jest.mock("@/lib/infrastructure/connection-preparation", () => ({
  loadPortableProvisionerBundle: (...args: unknown[]) => mockLoadBundle(...args),
}));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args), rpc: (...args: unknown[]) => mockRpc(...args) },
}));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/cron-heartbeat", () => ({
  recordCronHeartbeat: (...args: unknown[]) => mockHeartbeat(...args),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { GET } from "../route";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "@/lib/infrastructure/portable-provisioner-contract";

const ORIGINAL_ENV = process.env;
const mockedReport = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;

function request(token = "expected-secret", query = "") {
  return new NextRequest(`http://localhost/api/cron/sync-managed-provisioner-bundles${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

type AgentRow = {
  id: string;
  vmid?: number | null;
  status?: string | null;
  proxmox_host: string;
  managed_provisioner_channel: string | null;
};

function tables(agents: AgentRow[], hosts: Array<{ id: string; status: string; decommissioned_at: string | null }> = []) {
  // Rows default to a live VMID-bound computer; tests exercising the
  // "holds computers" predicate pass explicit vmid/status overrides.
  const rows = agents.map((agent) => ({ vmid: 500, status: "running", ...agent }));
  mockFrom.mockImplementation((table: string) => {
    if (table === "proxmox_hosts") return { select: () => Promise.resolve({ data: hosts, error: null }) };
    const builder = {
      select: () => builder, eq: () => builder, neq: () => builder, order: () => builder,
      range: () => Promise.resolve({ data: rows, error: null }),
    };
    return builder;
  });
}

describe("GET /api/cron/sync-managed-provisioner-bundles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      CRON_SECRET: "expected-secret",
      VERCEL_TARGET_ENV: "production",
      HIVRA_MANAGED_BUNDLE_SYNC_ENABLED: "true",
    };
    delete process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL;
    mockRpc.mockResolvedValue({ data: false, error: null });
    mockLoadBundle.mockResolvedValue(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map((relativePath) => ({
      relativePath, content: Buffer.from(relativePath),
    })));
    tables([{ id: "a1", proxmox_host: "fixturenode21", managed_provisioner_channel: null }]);
    mockProbe.mockImplementation(async (_channel: string, targetId: string) => ({
      kind: "present", targetId, observedVersion: "2026.09.30.1", manifestMatches: false, intact: true,
    }));
    mockSync.mockImplementation(async (channel: string, targetId: string) => ({
      ok: true, targetId, channel, requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: true, observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
    }));
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("fails closed without the cron secret", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("rejects a caller without the right bearer token", async () => {
    expect((await GET(request("wrong"))).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/api/cron/sync-managed-provisioner-bundles"))).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "false", "1", "yes"])("touches no database or host while the switch is %p", async (value) => {
    if (value === undefined) delete process.env.HIVRA_MANAGED_BUNDLE_SYNC_ENABLED;
    else process.env.HIVRA_MANAGED_BUNDLE_SYNC_ENABLED = value;

    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({ enabled: false, dryRun: false, hosts: [], synced: [] });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockLoadBundle).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockedReport).not.toHaveBeenCalled();
  });

  it("syncs a stale host on the deployment's own channel and reports it", async () => {
    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockSync).toHaveBeenCalledWith("default", "fixturenode21");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(payload.data).toMatchObject({ enabled: true, channel: "default", synced: ["fixturenode21"] });
    expect(mockedReport).toHaveBeenCalledWith(expect.objectContaining({
      severity: "info",
      title: `Provisioner bundle ${PORTABLE_HIVRA_PROVISIONER_VERSION} synced on fixturenode21 (default)`,
    }));
  });

  it("takes the channel from the server, so the Canary project writes only the Canary directory", async () => {
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
    tables([{ id: "a1", proxmox_host: "fixturenode11", managed_provisioner_channel: "canary" }]);

    expect((await GET(request())).status).toBe(200);
    expect(mockProbe).toHaveBeenCalledWith("canary", "fixturenode11", expect.any(String));
    expect(mockSync).toHaveBeenCalledWith("canary", "fixturenode11");
  });

  it("fails the Canary run before apply when the database cannot confirm the hold", async () => {
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
    tables([{ id: "a1", proxmox_host: "fixturenode11", managed_provisioner_channel: "canary" }]);
    mockRpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    expect((await GET(request())).status).toBe(500);
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("fails closed for an unfamiliar deployment before any host is touched", async () => {
    process.env.VERCEL_TARGET_ENV = "staging";
    expect((await GET(request())).status).toBe(500);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("probes but never syncs on a dry run, even with the switch off", async () => {
    process.env.HIVRA_MANAGED_BUNDLE_SYNC_ENABLED = "false";
    const payload = await (await GET(request("expected-secret", "?dryRun=1"))).json();

    expect(mockProbe).toHaveBeenCalledWith("default", "fixturenode21", expect.any(String));
    expect(mockSync).not.toHaveBeenCalled();
    expect(payload.data).toMatchObject({ enabled: false, dryRun: true, pending: ["fixturenode21"] });
  });

  it("pages for a host whose sync failed and stays quiet about one that is only waiting", async () => {
    tables([
      { id: "a1", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
      { id: "a2", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
      { id: "a3", proxmox_host: "fixturenode11", managed_provisioner_channel: null },
      { id: "a4", proxmox_host: "fixturenode12", managed_provisioner_channel: null },
    ]);
    mockSync.mockImplementation(async (channel: string, targetId: string) => ({
      ok: false, targetId, channel, requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: false, observedVersion: null, error: "readiness failed",
    }));

    const payload = await (await GET(request())).json();

    expect(payload.data.pending).toEqual(["fixturenode12"]);
    const titles = mockedReport.mock.calls.map(([event]) => [event.severity, event.title]);
    expect(titles).toEqual([
      ["error", "Provisioner bundle on fixturenode11 (default) needs attention: sync_failed"],
      ["error", "Provisioner bundle on fixturenode21 (default) needs attention: sync_failed"],
    ]);
    // Hosts needing a human mean the run did not fully do its job — the
    // heartbeat must record ok:false, not a clean run.
    expect(mockHeartbeat).toHaveBeenCalledWith("sync-managed-provisioner-bundles", {
      ok: false,
      detail: "hosts_needing_attention=2",
    });
  });

  it("reports remaining computer records separately from bundle health on a retired host", async () => {
    tables([
      { id: "stopped", status: "stopped", proxmox_host: "fixturenode21", managed_provisioner_channel: null },
      { id: "other-channel", proxmox_host: "fixturenode21", managed_provisioner_channel: "canary" },
    ], [{ id: "fixturenode21", status: "maintenance", decommissioned_at: "2026-01-01T00:00:00Z" }]);

    const payload = await (await GET(request())).json();

    expect(payload.data.hosts).toEqual([]);
    expect(payload.data.retiredHostReferences).toEqual([{ targetId: "fixturenode21", computerRecords: 1 }]);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockedReport).toHaveBeenCalledWith(expect.objectContaining({
      severity: "warn",
      metadata: { targetId: "fixturenode21", channel: "default", computerRecords: 1 },
    }));
    expect(mockHeartbeat).toHaveBeenCalledWith("sync-managed-provisioner-bundles", undefined);
  });

  it("stops before probing when the host registry read returns no data", async () => {
    const from = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => table === "proxmox_hosts"
      ? { select: async () => ({ data: null, error: null }) }
      : from(table));

    expect((await GET(request())).status).toBe(500);
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("records a plain heartbeat when no host needs attention", async () => {
    mockSync.mockResolvedValue({
      ok: true, targetId: "fixturenode21", channel: "test", requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: true, observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, error: null,
    });

    await GET(request());

    expect(mockHeartbeat).toHaveBeenCalledWith("sync-managed-provisioner-bundles", undefined);
  });
});
