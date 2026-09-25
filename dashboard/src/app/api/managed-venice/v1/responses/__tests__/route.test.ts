import type { NextRequest } from "next/server";
import { POST } from "../route";
import { authorizeManagedVeniceChat } from "@/lib/venice/proxy-chat-core";
import { captureManagedVeniceChatUsage, captureManagedVeniceObservedOutput, markManagedVeniceReconciliationRequired, releaseManagedVeniceChatReservationOrFile } from "@/lib/venice/proxy-settlement";
jest.mock("@/lib/venice/proxy-chat-core", () => ({ authorizeManagedVeniceChat: jest.fn() }));
jest.mock("@/lib/venice/proxy-settlement", () => ({ captureManagedVeniceChatUsage: jest.fn(), captureManagedVeniceObservedOutput: jest.fn(), managedVeniceUsageCostMicroUsd: jest.fn(), markManagedVeniceReconciliationRequired: jest.fn(), releaseManagedVeniceChatReservationOrFile: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const authorize = jest.mocked(authorizeManagedVeniceChat), capture = jest.mocked(captureManagedVeniceChatUsage), observed = jest.mocked(captureManagedVeniceObservedOutput), reconcile = jest.mocked(markManagedVeniceReconciliationRequired), release = jest.mocked(releaseManagedVeniceChatReservationOrFile);
const originalFetch = global.fetch;
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const terminal = { id: "resp_1", status: "completed", usage };
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const req = (body: unknown = { model: "test", input: "hello", stream: true }, key = "fixture") => new Request("https://hivra.test/api/managed-venice/v1/responses", {
  method: "POST", body: JSON.stringify(body), headers: key ? { Authorization: `Bearer ${key}` } : {},
}) as NextRequest;
const authorized = { userId: "user", proxyKeyId: "key", referenceId: "reference", reservationId: "reservation", model: "test",
  upstreamUrl: "https://api.venice.ai/api/v1/responses", upstreamKey: "server-fixture", walletType: "card" as const, pricingMap: new Map(), pricingSource: "live", liveModelCount: 1, bodyPatch: {} };
beforeEach(() => {
  jest.resetAllMocks();
  authorize.mockResolvedValue({ ok: true, value: authorized });
  global.fetch = jest.fn();
});
afterEach(() => { global.fetch = originalFetch; });
function upstream() {
  let control!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = jest.fn();
  jest.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ start(c) { control = c; }, cancel }), { headers: { "Content-Type": "text/event-stream" } }));
  return { control: () => control, cancel };
}
it.each([401, 402])("rejects %s before any upstream work", async status => {
  authorize.mockResolvedValue({ ok: false, response: new Response(null, { status }) });
  const response = await POST(req());
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(fetch).not.toHaveBeenCalled();
});
it("requires auth and validates supported operations before reserve/dispatch", async () => {
  const missing = await POST(req(undefined, ""));
  expect(missing.status).toBe(401);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  const invalid = await POST(req({ model: "test", input: "x", background: true }));
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get("cache-control")).toBe("no-store");
  expect(authorize).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("rejects a provider tool hidden in a namespace before reserve or dispatch", async () => {
  const response = await POST(req({ model: "test", input: "x", tools: [{ type: "namespace", name: "functions", description: "", tools: [
    { type: "function", name: "local" }, { type: "web_search" },
  ] }] }));
  expect(response.status).toBe(400);
  expect(authorize).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("preserves namespace names, child schemas and call IDs in the upstream request", async () => {
  const body = { model: "test", input: [{ type: "function_call_output", call_id: "call_fixture", output: "ok" }],
    tools: [{ type: "namespace", name: "functions", description: "", tools: [{ type: "function", name: "local", parameters: { type: "object" } }] }] };
  jest.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(terminal)));
  expect((await POST(req(body))).status).toBe(200);
  expect(jest.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify(body));
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ tools: body.tools }) }));
});
it("preserves streaming bytes before completion and settles nested usage once", async () => {
  const source = upstream(), response = await POST(req()), reader = response.body!.getReader();
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ protocol: "responses" }));
  const init = jest.mocked(fetch).mock.calls[0][1]!;
  expect(JSON.parse(init.body as string)).toEqual({ model: "test", input: "hello", stream: true });
  expect(init.redirect).toBe("error");
  const delta = frame({ type: "response.output_text.delta", delta: "Hello" });
  source.control().enqueue(delta);
  expect((await reader.read()).value).toEqual(delta);
  expect(capture).not.toHaveBeenCalled();
  const last = frame({ type: "response.completed", response: terminal });
  source.control().enqueue(last.slice(0, 7)); source.control().enqueue(last.slice(7)); source.control().enqueue(last); source.control().close();
  while (!(await reader.read()).done) { /* drain through settlement */ }
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ usage, endpoint: "/api/v1/responses", referenceId: "reference" }));
  expect(release).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
const settled = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
// #167 second review: a cancel no longer stops the read, so Venice's
// terminal usage (hidden reasoning included) is still charged.
it("keeps reading after the client cancels and charges Venice's terminal usage; it never refunds a 200", async () => {
  const source = upstream(), response = await POST(req()), reader = response.body!.getReader();
  source.control().enqueue(frame({ type: "response.output_text.delta", delta: "hi" }));
  await reader.read(); await reader.cancel();
  await settled();
  expect(source.cancel).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled();
  source.control().enqueue(frame({ type: "response.output_text.delta", delta: " more" }));
  source.control().enqueue(frame({ type: "response.completed", response: terminal }));
  await settled();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ usage, referenceId: "reference" }));
  expect(release).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
it("charges the observed output when Venice ends without terminal usage after the client cancels", async () => {
  const source = upstream(), response = await POST(req()), reader = response.body!.getReader();
  source.control().enqueue(frame({ type: "response.output_text.delta", delta: "hi" }));
  await reader.read(); await reader.cancel();
  source.control().enqueue(frame({ type: "response.output_text.delta", delta: "abcd" }));
  source.control().close();
  await settled();
  expect(observed).toHaveBeenCalledTimes(1);
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ referenceId: "reference", cause: "client_cancelled", observedOutputTokens: 2,
    reconciliationReason: "managed_venice_responses_ambiguous_usage" }));
  expect(release).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
// #167 second review: one bad frame after response.completed settled the
// stream with no usage (60 µUSD against an exact 600,060).
it("charges the terminal usage already seen when a later frame cannot be read", async () => {
  const source = upstream(), response = await POST(req());
  source.control().enqueue(frame({ type: "response.completed", response: terminal }));
  source.control().enqueue(new TextEncoder().encode("data: {not json\n\n"));
  source.control().close();
  await response.text().catch(() => undefined);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith(expect.objectContaining({ usage }));
  expect(observed).not.toHaveBeenCalled();
});
it.each([["missing", "missing_terminal_usage"], ["malformed", "invalid_or_interrupted_stream"]])("charges the observed output on %s usage", async (failure, cause) => {
  const source = upstream(), response = await POST(req());
  source.control().enqueue(frame(failure === "missing" ? { type: "response.output_text.delta", delta: "hi" } : { type: "response.completed", response: { ...terminal, usage: {} } }));
  source.control().close();
  await response.text().catch(() => undefined);
  expect(observed).toHaveBeenCalledTimes(1); expect(observed).toHaveBeenCalledWith(expect.objectContaining({ cause }));
  expect(release).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
});
it("files the reported usage for the sweep when settling it throws", async () => {
  const source = upstream(), response = await POST(req());
  capture.mockRejectedValueOnce(new Error("private details"));
  source.control().enqueue(frame({ type: "response.completed", response: terminal }));
  source.control().close();
  await response.text().catch(() => undefined);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ reason: "managed_venice_responses_ambiguous_usage", pauseKey: false,
    metadata: expect.objectContaining({ cause: "settlement_failed" }) }));
  expect(release).not.toHaveBeenCalled(); expect(observed).not.toHaveBeenCalled();
});
it("supports nonstreaming terminal usage and releases only explicit rejection", async () => {
  jest.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(terminal)));
  const response = await POST(req({ model: "test", input: "hi" }));
  expect(await response.json()).toEqual(terminal); expect(capture).toHaveBeenCalledTimes(1);
  jest.mocked(fetch).mockResolvedValueOnce(new Response("upstream secret", { status: 400 }));
  expect((await POST(req())).status).toBe(400); expect(release).toHaveBeenCalledTimes(1);
});
it("files a transport error for an operator, which the sweep releases an hour later", async () => {
  jest.mocked(fetch).mockRejectedValueOnce(new Error("private details"));
  const response = await POST(req());
  expect(response.status).toBe(502); expect(await response.text()).not.toContain("private details");
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ cause: "dispatch_outcome_unknown" }) }));
  expect(release).not.toHaveBeenCalled();
});
// #167 second review (MEDIUM): a 5xx held the hold for a day while chat and
// the Worker released it; Codex retries 5xx, each retry with its own hold.
it.each([500, 502, 503, 504])("releases the hold of a Venice %s at once", async status => {
  jest.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));
  const response = await POST(req());
  expect(response.status).toBe(502);
  expect(release).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledWith(expect.objectContaining({ referenceId: "reference", upstreamStatus: status }));
  expect(reconcile).not.toHaveBeenCalled();
});
it("forwards the lowered output cap when authorize had to write one; the rest of the body is unchanged", async () => {
  authorize.mockResolvedValue({ ok: true, value: { ...authorized, bodyPatch: { max_output_tokens: 6_000 } } });
  const body = { model: "test", input: [{ type: "message", role: "user", content: "hi" }], instructions: "be brief", max_output_tokens: 50_000 };
  jest.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(terminal)));
  expect((await POST(req(body))).status).toBe(200);
  expect(JSON.parse(jest.mocked(fetch).mock.calls[0][1]?.body as string)).toEqual({ ...body, max_output_tokens: 6_000 });
});
