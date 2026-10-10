import { inspectChatReadiness } from "../chat-readiness";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
type Answer = () => Promise<Response>;
const answer = (data: unknown, status = 200): Answer => async () => reply(data, status);
const failure = (error: Error): Answer => async () => { throw error; };
/** Route the box's two readiness endpoints; anything else is a test error. */
function box({ llm, login }: { llm?: Answer; login?: Answer }) {
  global.fetch = jest.fn((url: string) => {
    if (url.endsWith("/api/llm") && llm) return llm();
    if (url.endsWith("/api/login/status") && login) return login();
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
}
const requested = () => (fetch as jest.Mock).mock.calls.map(([url]) => url);

it("asks the Codex provider and sign-in questions together, not one after the other", async () => {
  const pending: Array<(response: Response) => void> = [];
  global.fetch = jest.fn(() => new Promise<Response>((resolve) => { pending.push(resolve); })) as unknown as typeof fetch;
  const readiness = inspectChatReadiness("https://box.test", "codex", "private-fixture");
  await Promise.resolve();
  // Both requests are out before either answers.
  expect(requested()).toEqual(["https://box.test/api/llm", "https://box.test/api/login/status"]);
  for (const [, init] of (fetch as jest.Mock).mock.calls) {
    expect(init).toEqual(expect.objectContaining({ cache: "no-store", redirect: "error", headers: { Authorization: "Bearer private-fixture" } }));
  }
  pending[1](reply({ loggedIn: true }));
  pending[0](reply({ agentKind: "codex", provider: null }));
  await expect(readiness).resolves.toBe("native_connected");
});
it("uses live provider configuration without requiring or claiming native login", async () => {
  box({ llm: answer({ agentKind: "codex", provider: "venice", model: "test", providerChatProtocol: "responses-v1" }), login: answer({ loggedIn: false }) });
  await expect(inspectChatReadiness("https://box.test/", "codex", "private-fixture")).resolves.toBe("provider_configured");
  expect(fetch).toHaveBeenCalledWith("https://box.test/api/llm", expect.objectContaining({ cache: "no-store", redirect: "error", headers: { Authorization: "Bearer private-fixture" } }));
});
it("does not wait for the sign-in answer once the provider decides", async () => {
  box({ llm: answer({ agentKind: "codex", provider: "venice", providerChatProtocol: "responses-v1" }), login: () => new Promise<Response>(() => undefined) });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("provider_configured");
});
it.each([undefined, null, "chat", "responses-v2"])("requires a verified Responses capability rather than just a saved provider: %s", async providerChatProtocol => {
  box({ llm: answer({ agentKind: "codex", provider: "venice", model: "test", providerChatProtocol }), login: answer({ loggedIn: true }) });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("upgrade_required");
});
it.each([true, false])("keeps native login when no alternative provider is configured: %s", async loggedIn => {
  box({ llm: answer({ agentKind: "codex", provider: null }), login: answer({ loggedIn }) });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe(loggedIn ? "native_connected" : "sign_in_required");
});
it.each([
  ["an unreadable sign-in state", answer({ loggedIn: "yes" })],
  ["a failed sign-in read", answer({}, 503)],
  ["an unreachable sign-in read", failure(new Error("private transport details"))],
])("fails closed on %s when Codex has no alternative provider", async (_label, login) => {
  box({ llm: answer({ agentKind: "codex", provider: null }), login });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("unavailable");
});
it.each([null, {}, { agentKind: "openclaw", provider: "venice" }, { agentKind: "codex", provider: "unknown" }])("fails closed on an invalid live provider summary: %j", async summary => {
  box({ llm: answer(summary), login: answer({ loggedIn: true }) });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("unavailable");
});
it("classifies a missing Codex provider capability as an actionable runtime upgrade", async () => {
  box({ llm: answer({}, 404), login: answer({ loggedIn: true }) });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("upgrade_required");
});
it.each([401, 503])("does not turn provider read failure %s into a native login prompt", async status => {
  box({ llm: answer({}, status), login: answer({ loggedIn: false }) });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("unavailable");
});
it("does not fall back to native login when the provider read cannot reach the computer", async () => {
  box({ llm: failure(new Error("private transport details")), login: answer({ loggedIn: true }) });
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("unavailable");
});
it("keeps other runtimes on their native handshake and sanitizes transport failures", async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error("private transport details"));
  await expect(inspectChatReadiness("https://box.test", "aeon")).resolves.toBe("unavailable");
  expect(fetch).toHaveBeenCalledWith("https://box.test/api/login/status", expect.any(Object));
});
it.each([true, false])("asks only the sign-in question for other runtimes: %s", async loggedIn => {
  box({ login: answer({ loggedIn }) });
  await expect(inspectChatReadiness("https://box.test", "claude-code", "private-fixture")).resolves.toBe(loggedIn ? "native_connected" : "sign_in_required");
  expect(requested()).toEqual(["https://box.test/api/login/status"]);
});
