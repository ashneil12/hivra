/** @jest-environment node */
// The Add-an-agent list reads each computer's gateway protocol at most once a
// minute per origin. The claim does not reuse that list answer (it asks again).
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/resource-gate", () => ({ validateAgentResources: jest.fn(), resolvePlanAgentSlots: jest.fn() }));
jest.mock("../attachment-lifecycle-store", () => ({ createAttachmentLifecycleStore: jest.fn() }));

import { readAttachChoices, type AttachDependencies } from "../attach-routes";
import type { AttachedGatewayProtocol } from "../attached-gateway-protocol";

const READY = { version: 1, eligible: true, reason: null };

function depsWith(gatewayProtocol: jest.Mock): AttachDependencies {
  return {
    store: { readTarget: jest.fn(async () => READY) } as unknown as AttachDependencies["store"],
    loadComputer: jest.fn(),
    validate: jest.fn(),
    planSlots: jest.fn(),
    gatewayProtocol: gatewayProtocol as unknown as AttachDependencies["gatewayProtocol"],
  };
}

const computer = (chatUrl: string, id: string) => ({ id, deploymentMode: "my-server", chatUrl });

describe("readAttachChoices gateway answers", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("asks a gateway once and reuses its answer for the list for a minute", async () => {
    const gatewayProtocol = jest.fn(async () => "update_required" as AttachedGatewayProtocol);
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    const computers = [computer("https://list-ttl.example.test", "computer-ttl")];

    const first = await readAttachChoices("owner-1", computers, depsWith(gatewayProtocol));
    expect(first.get("computer-ttl")?.reason).toBe("computer_update_required");

    now.mockReturnValue(1_030_000);
    const second = await readAttachChoices("owner-1", computers, depsWith(gatewayProtocol));
    expect(second.get("computer-ttl")?.reason).toBe("computer_update_required");
    expect(gatewayProtocol).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_061_000);
    await readAttachChoices("owner-1", computers, depsWith(gatewayProtocol));
    expect(gatewayProtocol).toHaveBeenCalledTimes(2);
  });

  it("does not keep a probe that failed, so the next list asks again", async () => {
    const gatewayProtocol = jest.fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("current");
    const computers = [computer("https://failed-probe.example.test", "computer-failed")];

    await expect(readAttachChoices("owner-2", computers, depsWith(gatewayProtocol))).rejects.toThrow("down");
    const retried = await readAttachChoices("owner-2", computers, depsWith(gatewayProtocol));
    expect(retried.get("computer-failed")).toEqual({ reason: null, message: null });
    expect(gatewayProtocol).toHaveBeenCalledTimes(2);
  });
});
