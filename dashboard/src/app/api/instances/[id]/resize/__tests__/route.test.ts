import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { resolveEffectiveTierSpec } from "@/lib/services/tier-specs";
import { resizeProxmoxVm } from "@/lib/services/proxmox-instance-service";
import { PATCH } from "../route";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock("@/lib/logger", () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@/lib/billing/venice-compute-boost", () => ({
  isVeniceBoostEligible: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  getProxmoxInfrastructure: jest.fn(() => ({ vmid: 201, node: "fixturenode1" })),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  resizeProxmoxVm: jest.fn(),
}));

const TIER = "operator";
const SPEC = resolveEffectiveTierSpec(TIER, false);

function mockInstanceAndUpdate(updateResult: { error: { message: string } | null }) {
  const updateChain = {
    eq: jest.fn(),
  };
  // .update().eq("id", ...).eq("user_id", ...) resolves to the write result.
  updateChain.eq.mockReturnValueOnce(updateChain).mockResolvedValueOnce(updateResult);
  const updateSpy = jest.fn(() => updateChain);

  const selectChain: Record<string, jest.Mock> = {};
  selectChain.select = jest.fn(() => selectChain);
  selectChain.eq = jest.fn(() => selectChain);
  selectChain.neq = jest.fn(() => selectChain);
  selectChain.single = jest.fn(async () => ({
    data: {
      id: "inst-1",
      user_id: "user_1",
      resource_tier: TIER,
      config: { infrastructure: { vmid: 201, node: "fixturenode1" } },
      hetzner_server_id: null,
      host_id: "host-1",
      status: "running",
    },
    error: null,
  }));

  (supabaseAdmin!.from as jest.Mock).mockImplementation(() => ({
    select: selectChain.select,
    update: updateSpy,
  }));

  return { updateSpy, updateChain };
}

describe("PATCH /api/instances/[id]/resize", () => {
  beforeEach(() => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
    (resizeProxmoxVm as jest.Mock).mockResolvedValue({ ok: true, stdout: "resized\n", stderr: "" });
  });

  it("records the resized caps on the row after the VM resize succeeds", async () => {
    const { updateSpy, updateChain } = mockInstanceAndUpdate({ error: null });

    const response = await PATCH(new NextRequest("http://localhost/api/instances/inst-1/resize", { method: "PATCH" }), {
      params: Promise.resolve({ id: "inst-1" }),
    });

    expect(response.status).toBe(200);
    expect(resizeProxmoxVm).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cpu_limit: SPEC.cpuLimit, ram_limit: SPEC.ramLimitMb }),
    );
    expect(updateChain.eq).toHaveBeenCalledWith("user_id", "user_1");
  });

  it("does not report success when the row write fails after the VM was resized", async () => {
    mockInstanceAndUpdate({ error: { message: "connection reset" } });

    const response = await PATCH(new NextRequest("http://localhost/api/instances/inst-1/resize", { method: "PATCH" }), {
      params: Promise.resolve({ id: "inst-1" }),
    });

    expect(response.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      "instance resize database update failed after VM resize",
      expect.objectContaining({ message: "connection reset" }),
      expect.objectContaining({ failureType: "instance_resize_row_update_failed", instanceId: "inst-1" }),
    );
  });
});
