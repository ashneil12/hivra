import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { applyGuestLlmApplication, expectedGuestLlmReceipt, inspectGuestLlmApplication,
  GUEST_LLM_APPLICATION_PROTOCOL, type GuestLlmApplication, type GuestLlmReceipt } from "../guest-llm-transport";

jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: jest.fn() }));
const { createLlmApplicationStore } = createRequire(__filename)(join(process.cwd(), "provisioner/hivra-chat/llm-application.js"));
const directories: string[] = [];
const target = { hostname: "box-fixture.hermesos.cloud", apiToken: "a".repeat(64), runtime: "codex" as const };
const payload = { provider: "venice" as const, baseUrl: "https://api.venice.ai/api/v1", apiKey: "synthetic-model-key", model: "test-model" };
const receiptResponse = (receipt: GuestLlmReceipt) => Response.json({ ok: true, ...receipt }, { headers: { "Cache-Control": "no-store" } });
function fixture(initial: typeof payload | null = null) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "hivra-llm-transport-"))); directories.push(directory);
  const store: { inspect(): GuestLlmReceipt; apply(input: unknown): GuestLlmReceipt; applyLegacy(input: unknown): GuestLlmReceipt }
    = createLlmApplicationStore({ directory, apiToken: target.apiToken, runtime: target.runtime });
  if (initial) store.applyLegacy(initial);
  const input: GuestLlmApplication = { target: { ...target }, operationId: randomUUID(), expectedStateDigest: store.inspect().stateDigest, payload: { ...payload } };
  const fetcher = jest.fn(async (url: string, options?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname, headers = options?.headers as Record<string, string>;
    if (path === "/api/meta") return Response.json({ agentKind: "codex", surfaceAuth: "post-cookie-v1", llmApplication: GUEST_LLM_APPLICATION_PROTOCOL });
    if (path !== "/api/llm/application") throw new Error("Unexpected test path");
    if (!headers.Authorization) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (options?.method === "POST") return receiptResponse(store.apply(JSON.parse(options.body as string)));
    return receiptResponse(store.inspect());
  });
  return { store, input, fetcher };
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  jest.useRealTimers();
});

it("inspects the real private guest record without posting a model key", async () => {
  const { store, fetcher } = fixture(payload), before = store.inspect();
  await expect(inspectGuestLlmApplication(target, fetcher)).resolves.toEqual({ ok: true, receipt: before });
  expect(store.inspect()).toEqual(before);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET" && options.body === undefined)).toBe(true);
  expect(JSON.stringify(await inspectGuestLlmApplication(target, fetcher))).not.toContain(payload.apiKey);
});
it.each([false, true])("matches the real guest's exact authenticated set/clear receipt (clear=%s)", async clear => {
  const { input, fetcher, store } = fixture(payload);
  input.payload = clear ? null : { ...payload, baseUrl: payload.baseUrl + "///", model: null };
  const expected = expectedGuestLlmReceipt(input);
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "applied", receipt: expected, writeAttempted: true });
  expect(store.inspect()).toEqual(expected);
  expect(fetcher).toHaveBeenCalledTimes(4);
  const [url, options] = fetcher.mock.calls[3];
  expect(url).toBe(`https://${target.hostname}/api/llm/application`);
  expect(JSON.parse(options!.body as string)).toEqual({ protocol: GUEST_LLM_APPLICATION_PROTOCOL,
    operationId: input.operationId, expectedStateDigest: input.expectedStateDigest,
    payload: clear ? null : { ...payload, model: null } });
  for (const [requestUrl, requestOptions] of fetcher.mock.calls) {
    expect(requestOptions).toMatchObject({ redirect: "manual", cache: "no-store", credentials: "omit" });
    expect(requestOptions?.signal?.aborted).toBe(true);
    expect(requestUrl).not.toContain(target.apiToken); expect(requestUrl).not.toContain(payload.apiKey);
    expect(requestOptions).not.toHaveProperty("dispatcher");
  }
  expect(fetcher.mock.calls.slice(0, 2).every(([, init]) => !(init!.headers as Record<string, string>).Authorization)).toBe(true);
});
it("defaults to the connect-time DNS-safe fetcher", async () => {
  const { input, fetcher } = fixture();
  jest.mocked(ssrfSafeFetch).mockImplementation(fetcher);
  expect((await applyGuestLlmApplication(input)).status).toBe("applied");
  expect(ssrfSafeFetch).toHaveBeenCalledTimes(4);
});
it("reconciles a lost acknowledgement without a second write", async () => {
  const { input, store, fetcher } = fixture(), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    const response = await original(url, options);
    if (options?.method === "POST") throw new Error("PRIVATE " + payload.apiKey + target.apiToken);
    return response;
  });
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "applied", receipt: store.inspect(), writeAttempted: false });
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
});
it("rejects stale state before posting and preserves the active credential", async () => {
  const { input, store, fetcher } = fixture();
  store.applyLegacy({ ...payload, apiKey: "different-synthetic-key" });
  const before = store.inspect();
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "not_sent", reason: "state_conflict" });
  expect(store.inspect()).toEqual(before);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("rejects same-operation/different-payload conflicts without another write", async () => {
  const { input, store, fetcher } = fixture();
  await applyGuestLlmApplication(input, fetcher);
  const before = store.inspect(); input.payload = null;
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "not_sent", reason: "operation_conflict" });
  expect(store.inspect()).toEqual(before);
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
});
it.each(["localhost", "127.0.0.1", "169.254.169.254", "example.com.", "example.com:443", "a/b.example.com", "user:secret@example.com"])("rejects unsafe/malformed hostname %s before network access", async hostname => {
  const { input, fetcher } = fixture(); input.target.hostname = hostname;
  expect((await applyGuestLlmApplication(input, fetcher)).status).toBe("not_sent");
  expect((await inspectGuestLlmApplication(input.target, fetcher)).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { operationId: "not-an-id" }, { expectedStateDigest: "short" }, { payload: undefined },
  { payload: {} }, { payload: { ...payload, apiKey: "tiny" } }, { payload: { ...payload, apiKey: "key with spaces" } },
  { payload: { ...payload, baseUrl: "http://api.venice.ai/api/v1" } },
  { payload: { ...payload, baseUrl: "https://api.venice.ai./api/v1" } },
  { payload: { ...payload, model: "invalid model" } }, { surprise: "secret" },
])("rejects invalid input without exposing its contents %j", async change => {
  const { input, fetcher } = fixture();
  expect(await applyGuestLlmApplication({ ...input, ...change } as GuestLlmApplication, fetcher)).toEqual({ status: "not_sent", reason: "invalid_request" });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["missing_protocol", "wrong_runtime", "old_auth"])("requires declared compatible guest metadata (%s)", async reason => {
  const { input, fetcher } = fixture();
  fetcher.mockResolvedValue(Response.json({ agentKind: reason === "wrong_runtime" ? "openclaw" : "codex",
    surfaceAuth: reason === "old_auth" ? "query-token" : "post-cookie-v1",
    ...(reason === "missing_protocol" ? {} : { llmApplication: GUEST_LLM_APPLICATION_PROTOCOL }) }));
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "not_sent", reason: "unsupported_guest" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]!.headers).not.toHaveProperty("Authorization");
});
it.each(["redirect", "html", "oversize", "broken_json", "open_auth_gate"])("sends no credential on incompatible preflight (%s)", async failure => {
  const { input, fetcher } = fixture(), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    if (failure === "open_auth_gate" && url.endsWith("/api/llm/application")) return Response.json({ ok: true });
    if (failure !== "open_auth_gate") return failure === "redirect" ? new Response(null, { status: 302, headers: { Location: "https://different.example" } })
      : failure === "oversize" ? Response.json({ pad: "x".repeat(8192) })
        : new Response(failure === "html" ? "<html>Login</html>" : "{", { headers: { "Content-Type": failure === "html" ? "text/html" : "application/json" } });
    return original(url, options);
  });
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "not_sent", reason: "unavailable" });
  expect(fetcher.mock.calls.every(([, init]) => !(init!.headers as Record<string, string>).Authorization)).toBe(true);
});
it.each(["operation", "payload", "state", "model", "provider", "extra_secret", "failure", "cached"])("does not settle an unproven post response (%s)", async failure => {
  const { input, fetcher } = fixture(), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    if (options?.method !== "POST") return original(url, options);
    const receipt = expectedGuestLlmReceipt(input);
    const changes = { operation: { operationId: randomUUID() }, payload: { payloadDigest: "0".repeat(64) },
      state: { stateDigest: "0".repeat(64) }, model: { model: "other-model" }, provider: { provider: null, model: null },
      extra_secret: { apiKey: "PRIVATE-DO-NOT-RETURN" }, failure: { ok: false }, cached: {} }[failure];
    return Response.json({ ok: true, ...receipt, ...changes }, { headers: { "Cache-Control": failure === "cached" ? "max-age=600" : "no-store" } });
  });
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it.each([302, 400, 401, 409, 500, 503])("keeps a possible write unconfirmed after HTTP %s, without retry", async status => {
  const { input, fetcher } = fixture(), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => options?.method === "POST"
    ? new Response("PRIVATE", { status, headers: { Location: "https://other.example" } }) : original(url, options));
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls.every(([url]) => new URL(url).hostname === target.hostname)).toBe(true);
});
it("snapshots all mutable caller input before the first asynchronous boundary", async () => {
  const { input, fetcher } = fixture(), expected = expectedGuestLlmReceipt(input), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, options) => {
    input.target.hostname = "wrong.example"; input.target.apiToken = "b".repeat(64);
    if (input.payload) input.payload.apiKey = "wrong-key";
    input.operationId = randomUUID(); input.expectedStateDigest = "c".repeat(64);
    return original(url, options);
  });
  await expect(applyGuestLlmApplication(input, fetcher)).resolves.toEqual({ status: "applied", receipt: expected, writeAttempted: true });
  expect(fetcher.mock.calls.every(([url]) => new URL(url).hostname === target.hostname)).toBe(true);
});
it.each([false, true])("bounds a fetch that ignores cancellation (after dispatch=%s)", async afterDispatch => {
  jest.useFakeTimers();
  const { input, fetcher } = fixture(), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, options) => !afterDispatch || options?.method === "POST" ? new Promise(() => {}) : original(url, options));
  const result = applyGuestLlmApplication(input, fetcher);
  await jest.advanceTimersByTimeAsync(12000);
  expect(await result).toEqual(afterDispatch ? { status: "unconfirmed", reason: "delivery_unconfirmed" } : { status: "not_sent", reason: "unavailable" });
  expect(jest.getTimerCount()).toBe(0);
});
it("bounds a stalled receipt body and cleans up its stream", async () => {
  jest.useFakeTimers();
  const { input, fetcher } = fixture(), original = fetcher.getMockImplementation()!, cancel = jest.fn();
  fetcher.mockImplementation((url, options) => options?.method === "POST"
    ? Promise.resolve(new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }))
    : original(url, options));
  const result = applyGuestLlmApplication(input, fetcher);
  await jest.advanceTimersByTimeAsync(12000);
  expect(await result).toEqual({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  expect(cancel).toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
});
it("honors the owning caller's earlier cancellation without network work", async () => {
  const { input, fetcher } = fixture(), abort = new AbortController(); abort.abort();
  await expect(applyGuestLlmApplication(input, fetcher, abort.signal)).resolves.toEqual({ status: "not_sent", reason: "unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
});
