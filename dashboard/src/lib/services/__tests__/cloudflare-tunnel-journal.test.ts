/** @jest-environment node */
jest.mock("server-only", () => ({}));
const mockCleanup = jest.fn();
jest.mock("../cloudflare-tunnel-cleanup", () => ({ deleteBoxTunnelVerified: (...args: unknown[]) => mockCleanup(...args) }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
import { createBoxTunnel } from "../cloudflare-tunnel";

const cfg = { apiToken: "test-secret", accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test" };
const tunnelId = "11111111-1111-4111-8111-111111111111";
const originalFetch = global.fetch;
const mockFetch = jest.fn();
let events: string[];
let postFailure: boolean;
let missingToken: boolean;
const journal = { beforeCreate: jest.fn(), cancelBeforeCreate: jest.fn(), created: jest.fn(), cleanupConfirmed: jest.fn() };
beforeEach(() => {
  jest.clearAllMocks();
  events = []; postFailure = false; missingToken = false;
  mockCleanup.mockReset().mockResolvedValue(undefined);
  journal.beforeCreate.mockReset().mockImplementation(async () => { events.push("intent"); });
  journal.cancelBeforeCreate.mockReset().mockResolvedValue(undefined);
  journal.created.mockReset().mockImplementation(async () => { events.push("journal-id"); });
  journal.cleanupConfirmed.mockReset().mockResolvedValue(undefined);
  mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
    let result: unknown;
    if (url.endsWith(`/zones/${cfg.zoneId}`)) result = { name: cfg.domain, account: { id: cfg.accountId } };
    else if (url.endsWith("/cfd_tunnel") && opts.method === "POST") {
      events.push("post-tunnel");
      if (postFailure) throw new Error("lost provider response");
      result = { id: tunnelId, token: missingToken ? undefined : "opaque-run-token" };
    } else if (url.endsWith("/configurations")) { events.push("configure"); result = {}; }
    else if (url.endsWith("/dns_records")) { events.push("post-dns"); result = { id: "c".repeat(32) }; }
    else throw new Error("unexpected request");
    return { ok: true, json: async () => ({ success: true, result }) };
  });
  global.fetch = mockFetch;
});
afterAll(() => { global.fetch = originalFetch; });

it("journals intent before create and the ID before configuration or DNS", async () => {
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).resolves.toMatchObject({ tunnelId });
  expect(events).toEqual(["intent", "post-tunnel", "journal-id", "configure", "post-dns"]);
  expect(mockCleanup).not.toHaveBeenCalled();
  const mutations = mockFetch.mock.calls.filter(([, opts]) => opts.method !== undefined);
  expect(mutations.every(([, opts]) => opts.signal === mutations[0][1].signal)).toBe(true);
});

it("does not allocate any resource when intent persistence fails", async () => {
  journal.beforeCreate.mockRejectedValue(new Error("database failed"));
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: true });
  expect(events).toEqual([]);
  expect(mockCleanup).not.toHaveBeenCalled();
  expect(journal.cancelBeforeCreate).toHaveBeenCalledWith({ hostname: "test-box.example.test" });
});

it("clears a committed intent after a lost DB response, before reporting verified absence", async () => {
  let persistedHostname: string | null = null;
  journal.beforeCreate.mockImplementation(async ({ hostname }) => {
    persistedHostname = hostname;
    throw new Error("lost DB response after commit");
  });
  journal.cancelBeforeCreate.mockImplementation(async () => { persistedHostname = null; });
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: true });
  expect(persistedHostname).toBeNull();
  expect(events).toEqual([]);
});

it("retains uncertain DB intent when pre-create cancellation cannot be confirmed", async () => {
  journal.beforeCreate.mockRejectedValue(new Error("lost DB response"));
  journal.cancelBeforeCreate.mockRejectedValue(new Error("DB unavailable"));
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: false });
  expect(events).toEqual([]);
});

it("does not POST after the deadline expires during intent persistence", async () => {
  const deadline = new AbortController();
  const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  journal.beforeCreate.mockImplementation(async () => { deadline.abort(); });
  try {
    await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: true });
    expect(events).toEqual([]);
    expect(journal.cancelBeforeCreate).toHaveBeenCalled();
  } finally { timeout.mockRestore(); }
});

it("journals a valid ID even if the token is missing and compensation fails", async () => {
  missingToken = true;
  mockCleanup.mockRejectedValue(new Error("provider unavailable"));
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: false });
  expect(events).toEqual(["intent", "post-tunnel", "journal-id"]);
  expect(journal.created).toHaveBeenCalledWith({ tunnelId, hostname: "test-box.example.test" });
});

it("compensates before allowing a failed ID journal write to settle", async () => {
  journal.created.mockRejectedValue(new Error("database failed"));
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: true });
  expect(events).toEqual(["intent", "post-tunnel"]);
  expect(mockCleanup).toHaveBeenCalledWith({ tunnelId, hostname: "test-box.example.test" }, cfg);
  expect(journal.cleanupConfirmed).toHaveBeenCalledWith({ tunnelId, hostname: "test-box.example.test" });
  expect(mockCleanup.mock.invocationCallOrder[0]).toBeLessThan(journal.cleanupConfirmed.mock.invocationCallOrder[0]);
});

it("retains the intent when the create response is lost", async () => {
  postFailure = true;
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: false });
  expect(events).toEqual(["intent", "post-tunnel"]);
  expect(journal.cleanupConfirmed).not.toHaveBeenCalled();
});

it("does not clear identity or swallow a failed compensation", async () => {
  journal.created.mockRejectedValue(new Error("database failed"));
  mockCleanup.mockRejectedValue(new Error("provider unavailable"));
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: false });
  expect(journal.cleanupConfirmed).not.toHaveBeenCalled();
});

it("retains a recoverable outcome if compensation cannot be persisted", async () => {
  journal.created.mockRejectedValue(new Error("database failed"));
  journal.cleanupConfirmed.mockRejectedValue(new Error("database still unavailable"));
  await expect(createBoxTunnel("test-box", { configOverride: cfg, journal })).rejects.toMatchObject({ cleanupVerified: false });
});
