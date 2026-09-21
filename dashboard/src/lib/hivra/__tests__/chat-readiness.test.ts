import { inspectChatReadiness } from "../chat-readiness";

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

it("uses live provider configuration without requiring or claiming native login", async () => {
  global.fetch = jest.fn().mockResolvedValue(reply({ agentKind: "codex", provider: "venice", model: "test", providerChatProtocol: "responses-v1" }));
  await expect(inspectChatReadiness("https://box.test/", "codex", "private-fixture")).resolves.toBe("provider_configured");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://box.test/api/llm", expect.objectContaining({ cache: "no-store", redirect: "error", headers: { Authorization: "Bearer private-fixture" } }));
});
it.each([undefined, null, "chat", "responses-v2"])("requires a verified Responses capability rather than just a saved provider: %s", async providerChatProtocol => {
  global.fetch = jest.fn().mockResolvedValue(reply({ agentKind: "codex", provider: "venice", model: "test", providerChatProtocol }));
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("upgrade_required");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([true, false])("keeps native login when no alternative provider is configured: %s", async loggedIn => {
  global.fetch = jest.fn().mockResolvedValueOnce(reply({ agentKind: "codex", provider: null }))
    .mockResolvedValueOnce(reply({ loggedIn }));
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe(loggedIn ? "native_connected" : "sign_in_required");
});
it.each([null, {}, { agentKind: "openclaw", provider: "venice" }, { agentKind: "codex", provider: "unknown" }])("fails closed on an invalid live provider summary: %j", async summary => {
  global.fetch = jest.fn().mockResolvedValue(reply(summary));
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("unavailable");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("classifies a missing Codex provider capability as an actionable runtime upgrade", async () => {
  global.fetch = jest.fn().mockResolvedValue(reply({}, 404));
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("upgrade_required");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([401, 503])("does not turn provider read failure %s into a native login prompt", async status => {
  global.fetch = jest.fn().mockResolvedValue(reply({}, status));
  await expect(inspectChatReadiness("https://box.test", "codex")).resolves.toBe("unavailable");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("keeps other runtimes on their native handshake and sanitizes transport failures", async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error("private transport details"));
  await expect(inspectChatReadiness("https://box.test", "aeon")).resolves.toBe("unavailable");
  expect(fetch).toHaveBeenCalledWith("https://box.test/api/login/status", expect.any(Object));
});
