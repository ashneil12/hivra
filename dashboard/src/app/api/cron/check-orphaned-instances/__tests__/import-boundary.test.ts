import { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { runOrphanSweep } from "@/lib/recovery/orphaned-instances";
import { shutdownServer } from "@/lib/hetzner/client";

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/hetzner/client", () => ({
  shutdownServer: jest.fn(),
}));

jest.mock("@/lib/recovery/orphaned-instances", () => ({
  runOrphanSweep: jest.fn(),
}));

describe("check-orphaned-instances Proxmox import boundary", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (clerkClient as unknown as jest.Mock).mockResolvedValue({ users: { getUser: jest.fn() } });
    (shutdownServer as jest.Mock).mockResolvedValue({ action: { id: 1 } });
    (runOrphanSweep as jest.Mock).mockImplementation(async ({ shutdownInstance }) => {
      const result = await shutdownInstance({
        id: "inst_hetz",
        user_id: "user_hetz",
        config: {},
        host_id: null,
        hetzner_server_id: 12345,
      });

      expect(result).toEqual({ ok: true });
      return {
        totalChecked: 1,
        alive: 0,
        orphans: 1,
        lookupFailures: 0,
        newlyDisabled: 1,
        shutdownFailures: 0,
        orphanIds: ["inst_hetz"],
      };
    });

    jest.doMock("@/lib/services/proxmox-instance-service", () => {
      throw new Error("proxmox service should not load for Hetzner orphan shutdown");
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("does not load the host-runner Proxmox service for Hetzner orphan shutdowns", async () => {
    const { GET } = await import("../route");

    const response = await GET(
      new Request("http://localhost/api/cron/check-orphaned-instances", {
        headers: { authorization: "Bearer cron-secret" },
      }) as unknown as NextRequest,
    );

    expect(response.status).toBe(200);
    expect(shutdownServer).toHaveBeenCalledWith(12345);
  });
});
