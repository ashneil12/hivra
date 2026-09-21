import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isOpsAdminUser } from "@/lib/ops-access";
import { reportOpsEvent } from "@/lib/ops-events";
import { shutdownServer } from "@/lib/hetzner/client";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/ops-access", () => ({
  isOpsAdminUser: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
  sanitizeOpsMetadata: jest.fn(
    (metadata: Record<string, unknown> | undefined) => metadata ?? {},
  ),
}));

jest.mock("@/lib/hetzner/client", () => ({
  shutdownServer: jest.fn(),
}));

describe("force-suspend Proxmox import boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "admin_user" });
    (currentUser as jest.Mock).mockResolvedValue({
      primaryEmailAddress: { emailAddress: "ops@example.com" },
    });
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);
    (shutdownServer as jest.Mock).mockResolvedValue({ action: { id: 1 } });
    (reportOpsEvent as jest.Mock).mockResolvedValue({ id: "evt_1" });

    let call = 0;
    (supabaseAdmin!.from as jest.Mock).mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: "inst_hetz",
              user_id: "user_hetz",
              hetzner_server_id: 12345,
              host_id: null,
              config: {},
              status: "running",
              lifecycle_state: "active",
            },
            error: null,
          }),
        };
      }

      return {
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ error: null }),
      };
    });

    jest.doMock("@/lib/services/proxmox-instance-service", () => {
      throw new Error("proxmox service should not load for Hetzner suspend");
    });
  });

  it("does not load the host-runner Proxmox service for Hetzner-only rows", async () => {
    const { POST } = await import("../route");

    const response = await POST(
      new NextRequest("http://localhost/api/ops/instances/inst_hetz/force-suspend", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "inst_hetz" }) },
    );

    expect(response.status).toBe(200);
    expect(shutdownServer).toHaveBeenCalledWith(12345);
  });
});
