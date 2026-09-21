/** @jest-environment jsdom */
import { createAgentModelLaunch, findAgentModelLaunch, type SavedModelLaunch } from "../agent-launch-api";

const requestId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const key = "synthetic-venice-key-only";
const saved: SavedModelLaunch = { requestId, intent: { type: "codex", name: "MY_CODEX", cpu: 2, ram: 4, browser: false,
  deployment: { mode: "hivra-managed" }, llm: { provider: "venice", mode: "byok", model: "deepseek-v4-pro" } } };
const agent = { id: agentId, type: "codex", name: "MY_CODEX", cpu: 2, ram: 4, status: "provisioning" };
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const accepted = (overrides = {}) => ({ success: true, data: { launchRequestId: requestId, agent, ...overrides } });
const fetchMock = jest.fn();
beforeEach(() => { jest.resetAllMocks(); global.fetch = fetchMock; });
afterEach(() => jest.useRealTimers());

it("sends one bound request over same-origin non-redirecting transport and returns only navigation fields", async () => {
  fetchMock.mockResolvedValue(response(accepted({ agent: { ...agent, api_token: key, llm_api_key_enc: key } })));
  expect(await createAgentModelLaunch(saved, ` ${key} `)).toEqual(agent);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/hivra/agents", expect.objectContaining({ method: "POST", cache: "no-store", redirect: "error", credentials: "same-origin" }));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ...saved.intent, launchRequestId: requestId, llm: { ...saved.intent.llm, apiKey: key } });
  expect(saved).not.toHaveProperty("intent.llm.apiKey");
});
it("managed selections never send the caller's incidental key", async () => {
  fetchMock.mockResolvedValue(response(accepted()));
  await createAgentModelLaunch({ ...saved, intent: { ...saved.intent, llm: { provider: "venice", mode: "managed", model: "deepseek-v4-pro", walletType: "card" } } }, key);
  expect(fetchMock.mock.calls[0][1].body).not.toContain(key);
});
it.each(["", "short", "bad key with spaces", "x".repeat(257)])("rejects invalid keys before transport: %s", async apiKey => {
  await expect(createAgentModelLaunch(saved, apiKey)).rejects.toThrow("No request was sent");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("rejects secret fields in the persisted intent", async () => {
  await expect(createAgentModelLaunch({ ...saved, intent: { ...saved.intent, llm: { ...saved.intent.llm, apiKey: key } } } as unknown as SavedModelLaunch, key)).rejects.toThrow("No request was sent");
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each([400, 401, 403, 409, 500, 503])("does not echo a server key on HTTP %i", async status => {
  fetchMock.mockResolvedValue(response({ success: false, error: key }, status));
  const error = await createAgentModelLaunch(saved, key).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(key);
});
it.each([
  { launchRequestId: agentId }, { agent: { ...agent, id: "javascript:alert(1)" } },
  { agent: { ...agent, type: "claude-code" } }, { agent: { ...agent, status: "complete" } },
])("rejects an unrelated or unrenderable accepted response %j", async overrides => {
  fetchMock.mockResolvedValue(response(accepted(overrides)));
  await expect(createAgentModelLaunch(saved, key)).rejects.toThrow("Launch could not be confirmed");
});
it("treats a missing lookup as unconfirmed and an unavailable lookup as an error", async () => {
  fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response({}, 503));
  expect(await findAgentModelLaunch(requestId)).toBeNull();
  await expect(findAgentModelLaunch(requestId)).rejects.toThrow("could not be confirmed");
  expect(fetchMock.mock.calls.every(([, init]) => init.method === "GET" && !init.body)).toBe(true);
});
it("accepts the original deleted computer without inventing a new launch", async () => {
  fetchMock.mockResolvedValue(response(accepted({ agent: { ...agent, status: "deleted" } })));
  expect(await findAgentModelLaunch(requestId)).toEqual({ ...agent, status: "deleted" });
});
it("bounds a stalled POST and never retries it automatically", async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error(key)));
  }));
  const result = createAgentModelLaunch(saved, key).catch(error => error);
  await jest.advanceTimersByTimeAsync(190_000);
  expect((await result).message).toContain("could not be confirmed");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("rejects invalid IDs without making requests", async () => {
  await expect(findAgentModelLaunch("../../other")).rejects.toThrow("No request was sent");
  expect(fetchMock).not.toHaveBeenCalled();
});
