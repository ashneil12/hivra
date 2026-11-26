import { assertUnusedRunId, destroyRunResources, listHivraAgents } from "../e2e/first-run-audit/instances";

const origin = "https://canary.example.test";
const runId = "4bc8ea25";
const own = { id: "owned", name: `firstrun-audit-${runId}`, status: "running" };
const unrelated = { id: "unrelated", name: `${own.name}-different`, status: "running" };

function response(status: number, body: unknown) {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function requestWithAgents(inventories: Array<typeof own[]>) {
  const agents = jest.fn();
  for (const inventory of inventories) {
    agents.mockResolvedValueOnce(response(200, { success: true, data: { agents: inventory } }));
  }
  return {
    get: jest.fn((url: string) => url.endsWith("/agents")
      ? agents()
      : Promise.resolve(response(200, { success: true, data: [unrelated] }))),
    delete: jest.fn(),
  };
}

describe("first-run audit named resource cleanup", () => {
  it("reads the nested Hivra agent list envelope", async () => {
    await expect(listHivraAgents(requestWithAgents([[own]]) as never, origin)).resolves.toEqual([own]);
  });

  it("retries conflicts and verifies disappearance of the exact run, leaving existing resources alone", async () => {
    const request = requestWithAgents([[own, unrelated], [unrelated, own], [unrelated]]);
    request.delete.mockResolvedValueOnce(response(409, {})).mockResolvedValueOnce(response(200, {}));

    await expect(destroyRunResources(request as never, origin, runId, 3, 0))
      .resolves.toEqual({ destroyed: [own.id], survived: [] });
    expect(request.delete.mock.calls).toEqual(Array(2).fill([
      `${origin}/api/hivra/agents/${own.id}`, expect.objectContaining({ headers: { Origin: origin } }),
    ]));
  });

  it.each([
    [503, {}, /HTTP 503/],
    [200, { success: true, data: {} }, /response was not verified/],
  ])("rejects an unreadable inventory without deleting (HTTP %s)", async (status, body, error) => {
    const request = { get: jest.fn().mockResolvedValue(response(status, body)), delete: jest.fn() };
    await expect(destroyRunResources(request as never, origin, runId, 1, 0)).rejects.toThrow(error);
    expect(request.delete).not.toHaveBeenCalled();
  });

  it("does not treat an acknowledged delete as disappearance", async () => {
    const request = requestWithAgents([[own], [own]]);
    request.delete.mockResolvedValue(response(200, {}));

    await expect(destroyRunResources(request as never, origin, runId, 1, 0))
      .resolves.toMatchObject({ survived: [{ id: own.id, deleted: false }] });
  });

  it("rejects invalid run IDs, collisions before launch and ambiguous matches during cleanup", async () => {
    const request = requestWithAgents([[own], [own, { ...own, id: "another" }]]);
    await expect(destroyRunResources(request as never, origin, "", 1, 0)).rejects.toThrow(/exact eight-hex/);
    expect(request.get).not.toHaveBeenCalled();
    await expect(assertUnusedRunId(request as never, origin, runId)).rejects.toThrow(/already has a resource/);
    await expect(destroyRunResources(request as never, origin, runId, 1, 0)).rejects.toThrow(/ambiguous cleanup/);
    expect(request.delete).not.toHaveBeenCalled();
  });
});
