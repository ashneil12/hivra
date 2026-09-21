import { createHetznerCloudPowerClient, HetznerCloudApiError } from "../client";
import { parseHetznerPowerAction, type HetznerPowerKind } from "../power-action";

const commands = { start: "start_server", stop: "shutdown_server", restart: "reboot_server" };
const paths = { start: "poweron", stop: "shutdown", restart: "reboot" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const receipt = (kind: HetznerPowerKind) => ({ id: 81, command: commands[kind], status: "running", resources: [{ id: 42, type: "server" }] });
afterEach(() => jest.useRealTimers());

it.each(["start", "stop", "restart"] as const)("uses only explicit owner-project authority and the fixed %s operation", async kind => {
  const action = receipt(kind);
  const fetchImpl = jest.fn().mockResolvedValueOnce(json({ action: { ...action, progress: 55, error: { message: "private-provider-detail" } } }, 201))
    .mockResolvedValueOnce(json({ action: { ...action, status: "success" } }));
  const client = createHetznerCloudPowerClient(" owner-key ", { fetchImpl });
  expect(await client.dispatch({ serverId: 42, kind })).toEqual(action);
  expect(await client.getAction({ serverId: 42, kind, actionId: 81 })).toEqual({ ...action, status: "success" });
  expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method ?? "GET"])).toEqual([
    [`https://api.hetzner.cloud/v1/servers/42/actions/${paths[kind]}`, "POST"],
    ["https://api.hetzner.cloud/v1/actions/81", "GET"],
  ]);
  for (const [, options] of fetchImpl.mock.calls) {
    expect(options.headers.get("Authorization")).toBe("Bearer owner-key");
    expect(options.redirect).toBe("error"); expect(options.cache).toBe("no-store");
    expect(options.body).toBeUndefined(); expect(options.signal).toBeInstanceOf(AbortSignal);
  }
  expect(Object.keys(client).sort()).toEqual(["dispatch", "getAction", "getServer"]);
});

it("never falls back to an ambient credential", () => {
  const previous = process.env.HETZNER_API_TOKEN;
  try { process.env.HETZNER_API_TOKEN = "ambient-never-use";
    expect(() => createHetznerCloudPowerClient(" ")).toThrow("token is required");
  } finally { if (previous === undefined) delete process.env.HETZNER_API_TOKEN; else process.env.HETZNER_API_TOKEN = previous; }
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe IDs %s before transport", async id => {
  const fetchImpl = jest.fn(), client = createHetznerCloudPowerClient("owner", { fetchImpl });
  await expect(client.dispatch({ serverId: id, kind: "start" })).rejects.toBeInstanceOf(HetznerCloudApiError);
  await expect(client.getAction({ serverId: 42, kind: "start", actionId: id })).rejects.toBeInstanceOf(HetznerCloudApiError);
  await expect(client.getServer(id)).rejects.toBeInstanceOf(HetznerCloudApiError);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(["reset", "poweroff", "constructor", "__proto__", "start/../../reset"])("rejects unsupported %s instead of choosing a fallback", async kind => {
  const fetchImpl = jest.fn();
  await expect(createHetznerCloudPowerClient("owner", { fetchImpl }).dispatch({ serverId: 42, kind: kind as HetznerPowerKind })).rejects.toBeInstanceOf(HetznerCloudApiError);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("snapshots the original identity before awaiting POST", async () => {
  const input = { serverId: 42, kind: "restart" as HetznerPowerKind };
  const fetchImpl = jest.fn(async () => { input.serverId = 43; input.kind = "stop"; return json({ action: receipt("restart") }, 201); });
  expect(await createHetznerCloudPowerClient("owner", { fetchImpl }).dispatch(input)).toEqual(receipt("restart"));
});
it.each(["id", "server", "command", "resources", "status", "shape"])("rejects changed %s in an original action observation", async changed => {
  const action: Record<string, unknown> = receipt("start");
  if (changed === "id") action.id = 82;
  if (changed === "server") action.resources = [{ id: 43, type: "server" }];
  if (changed === "command") action.command = "shutdown_server";
  if (changed === "resources") action.resources = [{ id: 42, type: "server" }, { id: 43, type: "server" }];
  if (changed === "status") action.status = "done";
  if (changed === "shape") action.id = "81";
  const fetchImpl = jest.fn().mockResolvedValue(json({ action }));
  await expect(createHetznerCloudPowerClient("owner", { fetchImpl }).getAction({ serverId: 42, kind: "start", actionId: 81 }))
    .rejects.toBeInstanceOf(HetznerCloudApiError);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([200, 202, 204])("does not reinterpret POST HTTP %s as an acknowledged action", async status => {
  const fetchImpl = jest.fn().mockResolvedValue(status === 204 ? new Response(null, { status }) : json({ action: receipt("stop") }, status));
  await expect(createHetznerCloudPowerClient("owner", { fetchImpl }).dispatch({ serverId: 42, kind: "stop" })).rejects.toMatchObject({ code: "response_invalid" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("aborts an unread unexpected-status response before releasing its deadline", async () => {
  jest.useFakeTimers();
  const cancelled = jest.fn();
  const body = new ReadableStream({ cancel: cancelled });
  const fetchImpl = jest.fn(async (_url, options: RequestInit = {}) => {
    // Like the real fetch transport, an abort terminates its response body.
    options.signal!.addEventListener("abort", () => { void body.cancel(); }, { once: true });
    return new Response(body, { status: 200 });
  });
  await expect(createHetznerCloudPowerClient("owner", { fetchImpl }).dispatch({ serverId: 42, kind: "start" }))
    .rejects.toMatchObject({ code: "response_invalid" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
it("releases the owned transport after consuming a valid action", async () => {
  jest.useFakeTimers();
  const fetchImpl = jest.fn(async (_url, options: RequestInit = {}) => {
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return json({ action: receipt("start") }, 201);
  });
  expect(await createHetznerCloudPowerClient("owner", { fetchImpl }).dispatch({ serverId: 42, kind: "start" })).toEqual(receipt("start"));
  expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});
it("returns a provider error outcome as observation, not success or raw error text", () => {
  expect(parseHetznerPowerAction({ ...receipt("restart"), status: "error", error: { message: "private" } }, { serverId: 42, kind: "restart" }))
    .toEqual({ ...receipt("restart"), status: "error" });
});
it("keeps malformed or ambiguous POSTs uncertain with no retry or sensitive exception", async () => {
  const fetchImpl = jest.fn().mockRejectedValueOnce(new Error("owner-key provider-private"))
    .mockResolvedValueOnce(json({ action: { ...receipt("stop"), resources: [] } }, 201));
  const client = createHetznerCloudPowerClient("owner-key", { fetchImpl });
  await expect(client.dispatch({ serverId: 42, kind: "stop" })).rejects.toThrow("Hetzner Cloud API POST request failed.");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(client.dispatch({ serverId: 42, kind: "stop" })).rejects.toMatchObject({ code: "response_invalid" });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
it("keeps precise safe provider diagnosis and drops provider messages", async () => {
  const fetchImpl = jest.fn().mockResolvedValue(json({ error: { code: "token_readonly", message: "owner-key" } }, 403));
  await expect(createHetznerCloudPowerClient("owner-key", { fetchImpl }).dispatch({ serverId: 42, kind: "restart" }))
    .rejects.toMatchObject({ status: 403, providerCode: "token_readonly" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("bounds a stalled mutation without retrying it", async () => {
  jest.useFakeTimers();
  const fetchImpl = jest.fn((_url, options: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const assertion = expect(createHetznerCloudPowerClient("owner", { fetchImpl }).dispatch({ serverId: 42, kind: "start" }))
    .rejects.toMatchObject({ code: "timeout", method: "POST" });
  await jest.advanceTimersByTimeAsync(15000); await assertion;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
