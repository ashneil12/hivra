import {
  destroyAllHivraAgents,
  listHivraAgents,
} from "../e2e/first-run-audit/instances";

function response(status: number, body: unknown) {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("first-run audit Hivra cleanup", () => {
  it("reads the nested Hivra agent list envelope", async () => {
    const request = {
      get: jest.fn().mockResolvedValue(response(200, {
        success: true,
        data: { agents: [{ id: "agent-1", name: "audit", status: "running" }] },
      })),
    };

    await expect(listHivraAgents(request as never, "https://canary.example.test"))
      .resolves.toEqual([{ id: "agent-1", name: "audit", status: "running" }]);
  });

  it("retries a provider-operation conflict, sends the exact Origin, and proves disappearance", async () => {
    const request = {
      get: jest.fn()
        .mockResolvedValueOnce(response(200, {
          success: true,
          data: { agents: [{ id: "agent-1", name: "audit", status: "provisioning" }] },
        }))
        .mockResolvedValueOnce(response(200, {
          success: true,
          data: { agents: [{ id: "agent-1", name: "audit", status: "running" }] },
        }))
        .mockResolvedValueOnce(response(200, { success: true, data: { agents: [] } })),
      delete: jest.fn()
        .mockResolvedValueOnce(response(409, { error: "operation finishing" }))
        .mockResolvedValueOnce(response(200, { success: true })),
    };

    const result = await destroyAllHivraAgents(
      request as never,
      "https://canary.example.test",
      3,
      0,
    );

    expect(result).toEqual({ destroyed: ["agent-1"], survived: [] });
    expect(request.delete).toHaveBeenNthCalledWith(
      1,
      "https://canary.example.test/api/hivra/agents/agent-1",
      expect.objectContaining({
        headers: { Origin: "https://canary.example.test" },
      }),
    );
  });
});
