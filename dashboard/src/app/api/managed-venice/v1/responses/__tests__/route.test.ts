import type { NextRequest } from "next/server";
import { POST } from "../route";
import { authorizeManagedVeniceChat } from "@/lib/venice/proxy-chat-core";
import { captureManagedVeniceChatUsage, markManagedVeniceReconciliationRequired, releaseManagedVeniceChatReservation } from "@/lib/venice/proxy-settlement";
jest.mock("@/lib/venice/proxy-chat-core", () => ({ authorizeManagedVeniceChat: jest.fn() }));
jest.mock("@/lib/venice/proxy-settlement", () => ({ captureManagedVeniceChatUsage: jest.fn(), markManagedVeniceReconciliationRequired: jest.fn(), releaseManagedVeniceChatReservation: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const authorize = jest.mocked(authorizeManagedVeniceChat), capture = jest.mocked(captureManagedVeniceChatUsage), reconcile = jest.mocked(markManagedVeniceReconciliationRequired), release = jest.mocked(releaseManagedVeniceChatReservation);
const originalFetch = global.fetch;
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const terminal = { id: "resp_1", status: "completed", usage };
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const req = (body: unknown = { model: "test", input: "hello", stream: true }, key = "fixture") => new Request("https://hivra.test/api/managed-venice/v1/responses", {
  method: "POST", body: JSON.stringify(body), headers: key ? { Authorization: `Bearer ${key}` } : {},
}) as NextRequest;
beforeEach(() => {
  jest.resetAllMocks();
  authorize.mockResolvedValue({ ok: true, value: { userId: "user", proxyKeyId: "key", referenceId: "reference", reservationId: "reservation", model: "test",
    upstreamUrl: "https://api.venice.ai/api/v1/responses", upstreamKey: "server-fixture", walletType: "card", pricingMap: new Map(), pricingSource: "live", liveModelCount: 1 } });
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
it("retains the reservation on cancellation after output; it never refunds an unknown bill", async () => {
  const source = upstream(), response = await POST(req()), reader = response.body!.getReader();
  source.control().enqueue(frame({ type: "response.output_text.delta", delta: "hi" }));
  await reader.read(); await reader.cancel();
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ reason: "managed_venice_responses_ambiguous_usage", pauseKey: false }));
  expect(release).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
});
it.each(["missing", "malformed", "settlement"])("retains a reviewable hold on %s usage", async failure => {
  const source = upstream(), response = await POST(req());
  if (failure === "settlement") capture.mockRejectedValueOnce(new Error("private details"));
  source.control().enqueue(frame(failure === "missing" ? { type: "response.output_text.delta", delta: "hi" } : { type: "response.completed", response: failure === "malformed" ? { ...terminal, usage: {} } : terminal }));
  source.control().close();
  await response.text().catch(() => undefined);
  expect(reconcile).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
});
it("supports nonstreaming terminal usage and releases only explicit rejection", async () => {
  jest.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(terminal)));
  const response = await POST(req({ model: "test", input: "hi" }));
  expect(await response.json()).toEqual(terminal); expect(capture).toHaveBeenCalledTimes(1);
  jest.mocked(fetch).mockResolvedValueOnce(new Response("upstream secret", { status: 400 }));
  expect((await POST(req())).status).toBe(400); expect(release).toHaveBeenCalledTimes(1);
});
it("does not release on transport errors or 5xx with ambiguous generation", async () => {
  jest.mocked(fetch).mockRejectedValueOnce(new Error("private details"));
  const response = await POST(req());
  expect(response.status).toBe(502); expect(await response.text()).not.toContain("private details");
  jest.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
  await POST(req());
  expect(reconcile).toHaveBeenCalledTimes(2); expect(release).not.toHaveBeenCalled();
});
