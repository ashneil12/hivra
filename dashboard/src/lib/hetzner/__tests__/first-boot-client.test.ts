import { createHetznerCloudFirstBootClient, HetznerCloudApiError } from "../client";
import { firstBootFirewallFixture } from "./first-boot-firewall.fixtures";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const absent = () => json({ error: { code: "not_found", message: "provider-private-detail" } }, 404);

describe("project-scoped first-boot transport", () => {
  afterEach(() => { jest.useRealTimers(); });

  it("uses the explicit project credential, fixed requests and original receipts", async () => {
    const f = firstBootFirewallFixture();
    const powerOn = { id: 91, command: "start_server", status: "running", resources: [{ id: 42, type: "server" }] };
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(json(f.response, 201))
      .mockResolvedValueOnce(json({ firewall: f.firewall }))
      .mockResolvedValueOnce(json({ action: f.applyAction }))
      .mockResolvedValueOnce(json({ server: f.server }))
      .mockResolvedValueOnce(json({ action: powerOn }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createHetznerCloudFirstBootClient(" owner-project ", { fetchImpl });
    expect(await client.createFirewall(f.scope)).toEqual(f.receipt);
    expect(await client.getFirewall(61)).toEqual(f.firewall);
    expect(await client.getAction(82)).toEqual(f.applyAction);
    expect(await client.getServer(42)).toEqual(f.server);
    expect(await client.powerOnServer(42)).toEqual(powerOn);
    await client.deleteFirewall(61);
    expect(fetchImpl.mock.calls.map(([url, opts]) => [url, opts.method ?? "GET"])).toEqual([
      ["firewalls", "POST"], ["firewalls/61", "GET"], ["actions/82", "GET"], ["servers/42", "GET"],
      ["servers/42/actions/poweron", "POST"], ["firewalls/61", "DELETE"],
    ].map(([path, method]) => ["https://api.hetzner.cloud/v1/" + path, method]));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(f.request);
    expect(fetchImpl.mock.calls[4][1].body).toBeUndefined();
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options.headers.get("Authorization")).toBe("Bearer owner-project");
      expect(options.redirect).toBe("error"); expect(options.cache).toBe("no-store");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(Object.keys(client).sort()).toEqual(["createFirewall", "deleteFirewall", "getAction", "getFirewall", "getServer", "powerOnServer"]);
  });

  it("does not substitute an ambient token for an empty explicit token", () => {
    const previous = process.env.HETZNER_API_TOKEN;
    try {
      process.env.HETZNER_API_TOKEN = "ambient-must-not-use";
      expect(() => createHetznerCloudFirstBootClient(" ", { fetchImpl: jest.fn() })).toThrow("token is required");
    } finally {
      if (previous === undefined) delete process.env.HETZNER_API_TOKEN;
      else process.env.HETZNER_API_TOKEN = previous;
    }
  });

  it("binds the original receipt to the dispatched scope despite caller mutation during POST", async () => {
    const f = firstBootFirewallFixture();
    let finish!: (response: Response) => void;
    const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const fetchImpl = jest.fn().mockReturnValueOnce(deferred);
    const task = createHetznerCloudFirstBootClient("owner", { fetchImpl }).createFirewall(f.scope);
    // Provider labels contain only the first half of the quote fingerprint;
    // re-reading a mutable scope after POST used to silently rebind the rest.
    f.scope.quoteFingerprint = "a".repeat(32) + "b".repeat(32);
    finish(json(f.response, 201));
    expect(await task).toEqual(f.receipt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe IDs before network access: %s", async id => {
    const fetchImpl = jest.fn();
    const client = createHetznerCloudFirstBootClient("owner", { fetchImpl });
    for (const method of [client.getFirewall, client.getAction, client.getServer, client.powerOnServer, client.deleteFirewall]) {
      await expect(method(id)).rejects.toBeInstanceOf(HetznerCloudApiError);
    }
    await expect(client.createFirewall({ ...firstBootFirewallFixture().scope, serverId: id })).rejects.toThrow("invalid_scope");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats only a precise provider not_found GET as absence", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(absent());
    const client = createHetznerCloudFirstBootClient("owner", { fetchImpl });
    expect(await client.getFirewall(61)).toBeNull();
    for (const response of [new Response("proxy 404", { status: 404 }), json({ error: { code: "unauthorized" } }, 404),
      json({ error: { code: "not_found" } }, 403)]) {
      fetchImpl.mockResolvedValueOnce(response);
      await expect(client.getFirewall(61)).rejects.toBeInstanceOf(HetznerCloudApiError);
    }
    fetchImpl.mockResolvedValueOnce(absent());
    await expect(client.deleteFirewall(61)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects mismatched GET IDs and incomplete responses", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(json({ firewall: { id: 62 } }))
      .mockResolvedValueOnce(json({ server: { id: 43 } }))
      .mockResolvedValueOnce(json({ action: { ...firstBootFirewallFixture().applyAction, id: 83 } }))
      .mockResolvedValueOnce(json(null));
    const client = createHetznerCloudFirstBootClient("owner", { fetchImpl });
    for (const [method, id] of [[client.getFirewall, 61], [client.getServer, 42], [client.getAction, 82], [client.getFirewall, 61]] as const) {
      await expect(method(id)).rejects.toMatchObject({ code: "response_invalid" });
    }
  });

  it("never retries an ambiguous POST or reflects fetch/JSON exception details", async () => {
    const f = firstBootFirewallFixture();
    const fetchImpl = jest.fn().mockRejectedValueOnce(new Error("owner-project provider-private-detail"))
      .mockResolvedValueOnce(new Response("provider-private-detail", { status: 200 }));
    const client = createHetznerCloudFirstBootClient("owner-project", { fetchImpl });
    await expect(client.createFirewall(f.scope)).rejects.toMatchObject({ code: "request_failed", method: "POST" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(client.getFirewall(61)).rejects.toThrow("Hetzner Cloud API GET request failed.");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("redacts provider error messages but preserves allowlisted diagnosis", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ error: { code: "token_readonly", message: "private-token" } }, 403));
    const client = createHetznerCloudFirstBootClient("owner", { fetchImpl });
    await expect(client.createFirewall(firstBootFirewallFixture().scope)).rejects.toMatchObject({ status: 403, providerCode: "token_readonly" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([200, 202, 204])("does not accept wrong create HTTP status %s", async status => {
    const fetchImpl = jest.fn().mockResolvedValue(status === 204 ? new Response(null, { status }) : json(firstBootFirewallFixture().response, status));
    await expect(createHetznerCloudFirstBootClient("owner", { fetchImpl }).createFirewall(firstBootFirewallFixture().scope))
      .rejects.toMatchObject({ code: "response_invalid" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not manufacture a complete receipt from a malformed successful POST", async () => {
    const f = firstBootFirewallFixture();
    const fetchImpl = jest.fn().mockResolvedValue(json({ ...f.response, actions: [] }, 201));
    await expect(createHetznerCloudFirstBootClient("owner", { fetchImpl }).createFirewall(f.scope)).rejects.toThrow("invalid_receipt");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("validates the exact power-on action without calling a fallback", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(json({ action: {
      id: 91, command: "start_server", status: "running", resources: [{ id: 43, type: "server" }],
    } }, 201));
    await expect(createHetznerCloudFirstBootClient("owner", { fetchImpl }).powerOnServer(42)).rejects.toThrow("resource_changed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled provider call and never retries a timed-out mutation", async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn((_url, options: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const task = createHetznerCloudFirstBootClient("owner", { fetchImpl }).powerOnServer(42);
    const assertion = expect(task).rejects.toMatchObject({ code: "timeout", method: "POST" });
    await jest.advanceTimersByTimeAsync(15_000); await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
