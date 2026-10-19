import { NextRequest } from "next/server";

const mockProbe = jest.fn();
const mockSync = jest.fn();
const mockLoadBundle = jest.fn();
const mockFrom = jest.fn();

jest.mock("@/lib/hivra/managed-provisioner-bundle-sync", () => ({
  ...jest.requireActual("@/lib/hivra/managed-provisioner-bundle-sync"),
  probeManagedProvisionerBundle: (...args: unknown[]) => mockProbe(...args),
  syncManagedProvisionerBundle: (...args: unknown[]) => mockSync(...args),
}));
jest.mock("@/lib/infrastructure/connection-preparation", () => ({
  loadPortableProvisionerBundle: (...args: unknown[]) => mockLoadBundle(...args),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
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

function tables(agents: Array<{ id: string; proxmox_host: string; managed_provisioner_channel: string | null }>) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "proxmox_hosts") return { select: () => Promise.resolve({ data: [], error: null }) };
    const builder = {
      select: () => builder, eq: () => builder, neq: () => builder, order: () => builder,
      range: () => Promise.resolve({ data: agents, error: null }),
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
  });
});
