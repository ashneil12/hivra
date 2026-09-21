/** @jest-environment jsdom */

import { getHivraCloudCapacity } from "../hivra-cloud-client";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("getHivraCloudCapacity", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("returns the active managed pool and its computers", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({
      success: true,
      data: {
        subscribed: true,
        plan: {
          key: "operator",
          name: "Pro",
          price: 999,
          maxAgents: 3,
          maxCpuPerAgent: 2,
          maxRamPerAgent: 4096,
          totalCpu: 2,
          totalRam: 4096,
          status: "active",
          currentPeriodEnd: null,
          source: "stripe",
          canChangePlanInPlace: true,
        },
        usage: {
          agentCount: 1,
          maxAgents: 3,
          usedCpu: 1,
          totalCpu: 2,
          usedRam: 2048,
          totalRam: 4096,
          instances: [{
            source: "hivra",
            id: "agent-1",
            name: "Codex",
            status: "running",
            cpu: 1,
            ram: 2048,
            disk_size_gb: 0,
            disk_upgraded: false,
            backups_enabled: false,
            type: "codex",
          }],
        },
      },
    }));

    await expect(getHivraCloudCapacity()).resolves.toEqual(
      expect.objectContaining({ subscribed: true, paid: true }),
    );
    expect(global.fetch).toHaveBeenCalledWith("/api/billing/usage", {
      method: "GET",
      cache: "no-store",
      signal: undefined,
    });
  });

  it("keeps Free capacity distinct from a paid pool", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({
      success: true,
      data: {
        subscribed: true,
        plan: {
          key: "free",
          name: "Free",
          price: 0,
          maxAgents: 1,
          maxCpuPerAgent: 0.5,
          maxRamPerAgent: 1024,
          totalCpu: 0.5,
          totalRam: 1024,
          status: "active",
          currentPeriodEnd: null,
          source: "free",
          canChangePlanInPlace: false,
        },
        usage: {
          agentCount: 0,
          maxAgents: 1,
          usedCpu: 0,
          totalCpu: 0.5,
          usedRam: 0,
          totalRam: 1024,
          instances: [],
        },
      },
    }));

    await expect(getHivraCloudCapacity()).resolves.toEqual(
      expect.objectContaining({ subscribed: true, paid: false }),
    );
  });

  it("fails closed on an unexpected billing response", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ success: true, data: {} }));

    await expect(getHivraCloudCapacity()).rejects.toEqual(
      expect.objectContaining({
        name: "HivraCloudCapacityError",
        status: 200,
      }),
    );
  });
});
