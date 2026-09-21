/** @jest-environment node */
import { webcrypto } from "node:crypto";
import { createWorkspaceBrowserBridge, type WorkspaceSurface } from "../workspace-browser-bridge";

const computerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nonce = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", origin = "https://box.hermesos.cloud";
const now = Date.now(), originalCrypto = globalThis.crypto;
beforeAll(() => { Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto }); });
afterAll(() => { Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto }); });
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(now); });
afterEach(() => { jest.useRealTimers(); });
function fixture(surface: WorkspaceSurface = "files") {
  const session = { sessionId, computerId, surface, audience: origin, handoffUrl: `${origin}/workspace/handoff`,
    exchangeCode: `hwe1_${"x".repeat(43)}`, expiresAt: now + 240000, exchangeExpiresAt: now + 60000 };
  const frame = { postMessage: jest.fn() } as unknown as Window;
  const fetcher = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === "DELETE" ? { success: true } : { success: true, data: session }), { status: 200 }));
  const ports = { frame: () => frame, showFrame: jest.fn(), status: jest.fn(), fetch: fetcher };
  const bridge = createWorkspaceBrowserBridge(computerId, origin, surface, ports);
  const receive = (data: Record<string, unknown>, from = origin, source: MessageEventSource = frame) =>
    bridge.receive({ origin: from, source, data } as MessageEvent);
  const ready = () => receive({ type: "hivra.workspace.ready.v1", nonce });
  const connected = () => receive({ type: surface === "files" ? "hivra.workspace.connected.v1" : "hivra.workspace.mounted.v1",
    nonce, sessionId, surface, expiresAt: session.expiresAt });
  const result = (data: unknown, extra: Record<string, unknown> = {}) => {
    const calls = (frame.postMessage as jest.Mock).mock.calls;
    const requestId = calls[calls.length - 1][0].requestId;
    receive({ type: "hivra.workspace.result.v1", nonce, sessionId, surface, requestId, ok: true, status: 200, data, ...extra });
  };
  return { bridge, session, frame, fetcher, ports, receive, ready, connected, result };
}
it("keeps capabilities out of URLs and only hands off to the exact current frame/origin", async () => {
  const f = fixture(); await f.bridge.connect();
  expect(f.ports.showFrame).toHaveBeenLastCalledWith({ id: sessionId, url: `${origin}/workspace/handoff` });
  const issue = JSON.parse(f.fetcher.mock.calls[0][1]!.body as string);
  expect(issue).toEqual({ computerId, surface: "files", pkceChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  f.receive({ type: "hivra.workspace.ready.v1", nonce }, "https://foreign.example.test");
  f.receive({ type: "hivra.workspace.ready.v1", nonce }, origin, {} as Window);
  expect(f.frame.postMessage).not.toHaveBeenCalled();
  f.ready();
  expect(f.frame.postMessage).toHaveBeenCalledWith({ type: "hivra.workspace.init.v1", nonce, sessionId, surface: "files",
    exchangeCode: f.session.exchangeCode, verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }, origin);
  f.connected(); expect(f.ports.status).toHaveBeenLastCalledWith("connected");
  f.bridge.dispose();
  expect(f.fetcher).toHaveBeenLastCalledWith("/api/workspace/sessions", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ sessionId }) }));
});
it("roundtrips selected file operations and checks result binding/schema", async () => {
  const f = fixture(); await f.bridge.connect(); f.ready(); f.connected();
  const listing = f.bridge.files.list(".");
  f.result({ path: ".", entries: [{ name: "draft.txt", type: "file", size: 3, mtime: now }] }, { nonce: "wrong" });
  f.result({ path: ".", entries: [{ name: "draft.txt", type: "file", size: 3, mtime: now }] });
  expect(await listing).toEqual({ path: ".", entries: [{ name: "draft.txt", type: "file", size: 3, mtime: now }], error: null });
  const reading = f.bridge.files.read("draft.txt"); f.result({ content: "old" }); expect(await reading).toEqual({ content: "old", error: null });
  const writing = f.bridge.files.write("draft.txt", "new");
  expect(f.frame.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "write", path: "draft.txt", content: "new" }), origin);
  f.result({ ok: true }); expect(await writing).toEqual({ ok: true, error: null });
  const invalid = f.bridge.files.read("draft.txt"); f.result({ arbitrary: "not-file-content" }); expect((await invalid).error).not.toBeNull();
  f.bridge.dispose();
});
it("never turns mounting a terminal into a shell success or files authority", async () => {
  const f = fixture("box-terminal"); await f.bridge.connect(); f.ready(); f.connected();
  expect(f.ports.status).toHaveBeenLastCalledWith("mounted");
  expect((await f.bridge.files.list(".")).error).not.toBeNull();
  expect(f.frame.postMessage).toHaveBeenCalledTimes(1); f.bridge.dispose();
});
it.each(["expiry", "reload", "guest-end", "dispose", "request-timeout"])("settles pending requests without retry on %s", async fault => {
  const f = fixture(); await f.bridge.connect(); f.ready(); f.connected();
  const writing = f.bridge.files.write("draft.txt", "unsaved draft");
  if (fault === "expiry") jest.advanceTimersByTime(240000);
  if (fault === "request-timeout") jest.advanceTimersByTime(27000);
  if (fault === "reload") f.ready();
  if (fault === "guest-end") f.receive({ type: "hivra.workspace.ended.v1", nonce, sessionId, surface: "files", reason: "authorization-lost" });
  if (fault === "dispose") f.bridge.dispose();
  expect(await writing).toMatchObject({ ok: false, error: expect.any(String) });
  expect((f.frame.postMessage as jest.Mock).mock.calls.filter(call => call[0].operation === "write")).toHaveLength(1);
  expect(f.fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  f.bridge.dispose();
});
it.each(["audience", "computer", "surface", "url", "expiry"])("rejects issued %s mismatch before creating a guest frame", async fault => {
  const f = fixture();
  if (fault === "audience") f.session.audience = "https://foreign.example.test";
  if (fault === "computer") f.session.computerId = sessionId;
  if (fault === "surface") f.session.surface = "box-terminal";
  if (fault === "url") f.session.handoffUrl += "?token=forbidden";
  if (fault === "expiry") f.session.expiresAt = now + 240001;
  await f.bridge.connect(); expect(f.ports.status).toHaveBeenLastCalledWith("disconnected");
  expect(f.ports.showFrame).not.toHaveBeenCalledWith(expect.objectContaining({ id: sessionId }));
  expect(f.fetcher).toHaveBeenLastCalledWith("/api/workspace/sessions", expect.objectContaining({ method: "DELETE" }));
  f.bridge.dispose();
});
it("ends an opening attempt that never produces authenticated guest readiness", async () => {
  const f = fixture(); await f.bridge.connect(); f.ready(); jest.advanceTimersByTime(30000);
  expect(f.ports.status).toHaveBeenLastCalledWith("disconnected"); f.bridge.dispose();
});
