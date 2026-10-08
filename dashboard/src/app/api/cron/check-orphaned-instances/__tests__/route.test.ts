import { NextRequest } from "next/server";

import { GET } from "../route";
import { runOrphanSweep } from "@/lib/recovery/orphaned-instances";
import { clerkClient } from "@clerk/nextjs/server";
import { shutdownProxmoxInstance } from "@/lib/services/proxmox-instance-service";

jest.mock("@/lib/recovery/orphaned-instances", () => ({
  runOrphanSweep: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  shutdownProxmoxInstance: jest.fn(),
}));

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const ORIGINAL_ENV = process.env;

function makeRequest(authorization?: string): NextRequest {
  return new Request("http://localhost/api/cron/check-orphaned-instances", {
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;
}

describe("GET /api/cron/check-orphaned-instances", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let usersStub: { getUser: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    usersStub = { getUser: jest.fn() };
    (clerkClient as unknown as jest.Mock).mockResolvedValue({ users: usersStub });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "" };

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Cron secret is not configured");
    expect(runOrphanSweep).not.toHaveBeenCalled();
  });

  it("returns 401 when the authorization header is wrong", async () => {
    const response = await GET(makeRequest("Bearer wrong-secret"));
    expect(response.status).toBe(401);
    expect(runOrphanSweep).not.toHaveBeenCalled();
  });

  it("returns 401 when no authorization header is present", async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
    expect(runOrphanSweep).not.toHaveBeenCalled();
  });

  it("invokes the sweep with apply=true + a row-aware shutdownInstance and surfaces the summary on success", async () => {
    (runOrphanSweep as jest.Mock).mockResolvedValue({
      totalChecked: 51,
      alive: 49,
      orphans: 2,
      lookupFailures: 0,
      newlyDisabled: 2,
      shutdownFailures: 0,
      orphanIds: [
        "00000000-0000-4000-8000-000000001010",
        "00000000-0000-4000-8000-000000001052",
      ],
    });

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(runOrphanSweep).toHaveBeenCalledTimes(1);
    // The cron must wire a row-aware `shutdownInstance` so disable-then-delete
    // takes the VM offline regardless of whether it's Hetzner or Proxmox, and
    // backs off when the row sits on a shared host with other live tenants.
    expect(runOrphanSweep).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: true,
        clerk: usersStub,
        shutdownInstance: expect.any(Function),
      }),
    );
    expect(body.data).toEqual(
      expect.objectContaining({
        totalChecked: 51,
        orphans: 2,
        newlyDisabled: 2,
        shutdownFailures: 0,
      }),
    );
  });

  it("routes orphaned Proxmox rows by stored proxmox_node when config infrastructure is missing", async () => {
    (runOrphanSweep as jest.Mock).mockResolvedValue({
      totalChecked: 1,
      alive: 0,
      orphans: 1,
      lookupFailures: 0,
      newlyDisabled: 1,
      shutdownFailures: 0,
      orphanIds: ["inst_orphan"],
    });
    (shutdownProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true });

    await GET(makeRequest("Bearer cron-secret"));

    const shutdownInstance = (runOrphanSweep as jest.Mock).mock.calls[0][0].shutdownInstance;
    await expect(
      shutdownInstance({
        id: "inst_orphan",
        user_id: "missing_user",
        name: "Fixture Customer A",
        status: "running",
        backend: "webui",
        infrastructure_provider: "proxmox",
        proxmox_node: "fixturenode2",
        proxmox_vmid: 209,
        hetzner_server_id: null,
        host_id: null,
        config: {},
        created_at: "2026-05-08T00:00:00.000Z",
      })
    ).resolves.toEqual({ ok: true });

    expect(shutdownProxmoxInstance).toHaveBeenCalledWith(
      { vmid: 209, node: "fixturenode2" },
      { expectedInstanceId: "inst_orphan", hostConfig: { hostId: null, hostSlug: "fixturenode2", envPrefix: null, failClosed: true } }
    );
  });

  it("returns 500 and a generic message if the sweep itself throws", async () => {
    (runOrphanSweep as jest.Mock).mockRejectedValue(new Error("supabase down"));

    const response = await GET(makeRequest("Bearer cron-secret"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("supabase down");
  });
});
