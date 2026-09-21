import { createHetznerCloudCleanupClient, HetznerCloudApiError } from "../client";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const absent = () => json({ error: { code: "not_found", message: "do not retain" } }, 404);

describe("project-scoped cleanup transport", () => {
  it("uses only the explicit project credential and fixed endpoint for all resources", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(json({ server: { id: 42 } }))
      .mockResolvedValueOnce(json({ primary_ip: { id: 88 } }))
      .mockResolvedValueOnce(json({ ssh_key: { id: 77 } }))
      .mockResolvedValueOnce(json({ action: { id: 500, command: "delete_server", status: "running", resources: [{ type: "server", id: 42 }] } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createHetznerCloudCleanupClient("owner-project", { fetchImpl });
    await client.getServer(42); await client.getPrimaryIp(88); await client.getSshKey(77);
    await client.deleteServer(42); await client.deletePrimaryIp(88); await client.deleteSshKey(77);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "servers/42", "primary_ips/88", "ssh_keys/77", "servers/42", "primary_ips/88", "ssh_keys/77",
    ].map(path => `https://api.hetzner.cloud/v1/${path}`));
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options.headers.get("Authorization")).toBe("Bearer owner-project");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    for (const [, options] of fetchImpl.mock.calls.slice(0, 3)) {
      expect(options.cache).toBe("no-store");
    }
  });

  it("only returns absent for an explicit provider not_found response", async () => {
    const fetchImpl = jest.fn().mockImplementation(async () => absent());
    const client = createHetznerCloudCleanupClient("owner", { fetchImpl });
    expect(await client.getServer(42)).toBeNull();
    expect(await client.getPrimaryIp(88)).toBeNull();
    expect(await client.getSshKey(77)).toBeNull();
    for (const response of [new Response("proxy 404", { status: 404 }), json({ error: { code: "unauthorized" } }, 404), json({ error: { code: "not_found" } }, 403)]) {
      fetchImpl.mockResolvedValueOnce(response);
      await expect(client.getServer(42)).rejects.toBeInstanceOf(HetznerCloudApiError);
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid IDs before transport: %s", async id => {
    const fetchImpl = jest.fn();
    const client = createHetznerCloudCleanupClient("owner", { fetchImpl });
    for (const method of Object.values(client)) await expect(method(id)).rejects.toBeInstanceOf(HetznerCloudApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not treat mismatched resource IDs, a lost delete response, or a delete 404 as complete", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(json({ server: { id: 43 } }))
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce(absent());
    const client = createHetznerCloudCleanupClient("owner", { fetchImpl });
    await expect(client.getServer(42)).rejects.toMatchObject({ code: "response_invalid" });
    await expect(client.deleteServer(42)).rejects.toThrow("lost acknowledgement");
    await expect(client.deletePrimaryIp(88)).rejects.toMatchObject({ status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    { command: "poweron", resources: [{ type: "server", id: 42 }] },
    { command: "delete_server", resources: [{ type: "server", id: 43 }] },
    { command: "delete_server", resources: [{ type: "primary_ip", id: 42 }] },
  ])("rejects unrelated delete action receipts: %j", async action => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ action: { id: 500, status: "running", ...action } }));
    await expect(createHetznerCloudCleanupClient("owner", { fetchImpl }).deleteServer(42)).rejects.toMatchObject({ code: "response_invalid" });
  });
});
