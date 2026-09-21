/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { createAgentModelLaunch, findAgentModelLaunch, type ModelLaunchAgent, type ModelLaunchIntent } from "@/lib/hivra/agent-launch-api";
import { modelLaunchStorageKey, useModelLaunch } from "../useModelLaunch";

jest.mock("@/lib/hivra/agent-launch-api", () => ({ ...jest.requireActual("@/lib/hivra/agent-launch-api"), createAgentModelLaunch: jest.fn(), findAgentModelLaunch: jest.fn() }));
const create = jest.mocked(createAgentModelLaunch), find = jest.mocked(findAgentModelLaunch);
const requestId = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222";
const intent: ModelLaunchIntent = { type: "codex", name: "MY_CODEX", cpu: 2, ram: 4, browser: false,
  deployment: { mode: "hivra-managed" }, llm: { provider: "venice", mode: "byok", model: "deepseek-v4-pro" } };
const agent: ModelLaunchAgent = { id: agentId, type: "codex", name: "MY_CODEX", cpu: 2, ram: 4, status: "provisioning" };
const key = "synthetic-key-not-for-storage";
const store = (owner = "user_a") => sessionStorage.setItem(modelLaunchStorageKey(owner), JSON.stringify({ requestId, intent }));
beforeEach(() => { jest.resetAllMocks(); sessionStorage.clear(); Object.defineProperty(crypto, "randomUUID", { configurable: true, value: jest.fn(() => requestId) }); });
afterEach(() => jest.restoreAllMocks());

it("persists exactly the owner-bound non-secret intent BEFORE dispatch and retains it after acceptance", async () => {
  create.mockImplementation(async () => {
    expect(JSON.parse(sessionStorage.getItem(modelLaunchStorageKey("user_a"))!)).toEqual({ requestId, intent });
    expect(sessionStorage.getItem(modelLaunchStorageKey("user_a"))).not.toContain(key);
    return agent;
  });
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await act(async () => { expect(await result.current.submit(intent, key)).toEqual(agent); });
  expect(result.current.agent).toEqual(agent);
  expect(result.current.saved).toEqual({ requestId, intent });
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
});
it("reuses frozen intent and ID after a lost response, even if caller choices change", async () => {
  create.mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce(agent);
  find.mockResolvedValue(null);
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await act(async () => { await result.current.submit(intent, key); });
  await act(async () => { await result.current.submit({ ...intent, cpu: 8, name: "DIFFERENT" }, "reentered-key"); });
  expect(create).toHaveBeenCalledTimes(2);
  for (const call of create.mock.calls) expect(call[0]).toEqual({ requestId, intent });
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  expect(find).toHaveBeenCalledWith(requestId, expect.anything());
});
it("recovers the original after reload without asking for or sending a key", async () => {
  store(); find.mockResolvedValue(agent);
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await waitFor(() => expect(result.current.agent).toEqual(agent));
  expect(create).not.toHaveBeenCalled();
  expect(result.current.saved?.requestId).toBe(requestId);
});
it.each([null, "unavailable"])("does not release the original ID after lookup %s", async value => {
  store();
  if (value === null) find.mockResolvedValue(null); else find.mockRejectedValue(new Error("unavailable"));
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await waitFor(() => expect(result.current.busy).toBe(false));
  act(() => result.current.startAnother());
  expect(result.current.saved?.requestId).toBe(requestId);
  expect(sessionStorage.getItem(modelLaunchStorageKey("user_a"))).not.toBeNull();
  expect(create).not.toHaveBeenCalled();
});
it("checks the original before an explicit retry and never posts when found", async () => {
  store(); find.mockResolvedValueOnce(null).mockResolvedValueOnce(agent);
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await waitFor(() => expect(result.current.busy).toBe(false));
  await act(async () => { expect(await result.current.submit(intent, "")).toEqual(agent); });
  expect(create).not.toHaveBeenCalled();
});
it("explicit revisions use the same ID and a fresh key-free intent, never a second reservation", async () => {
  store(); find.mockResolvedValue(null); create.mockResolvedValue(agent);
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await waitFor(() => expect(result.current.busy).toBe(false));
  act(() => result.current.reviewChoices());
  expect(result.current.editing).toBe(true);
  const revised = { ...intent, cpu: 4, name: "REVISED_CODEX" };
  await act(async () => { await result.current.submit(revised, key); });
  expect(create).toHaveBeenCalledWith({ requestId, intent: revised }, key, expect.anything());
  expect(crypto.randomUUID).not.toHaveBeenCalled();
  expect(result.current.editing).toBe(false);
  expect(JSON.parse(sessionStorage.getItem(modelLaunchStorageKey("user_a"))!)).toEqual({ requestId, intent: revised });
});
it("an earlier accepted computer wins over an explicit revision without another POST", async () => {
  store(); find.mockResolvedValueOnce(null).mockResolvedValueOnce(agent);
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await waitFor(() => expect(result.current.busy).toBe(false));
  act(() => result.current.reviewChoices());
  await act(async () => { expect(await result.current.submit({ ...intent, cpu: 4 }, key)).toEqual(agent); });
  expect(create).not.toHaveBeenCalled();
  expect(result.current.agent).toEqual(agent);
});
it("fences double clicks synchronously", async () => {
  let finish!: (agent: ModelLaunchAgent) => void;
  create.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useModelLaunch("user_a"));
  let first!: Promise<ModelLaunchAgent | null>;
  act(() => { first = result.current.submit(intent, key); });
  await act(async () => { expect(await result.current.submit(intent, key)).toBeNull(); });
  expect(create).toHaveBeenCalledTimes(1);
  await act(async () => { finish(agent); await first; });
});
it("aborts and discards stale acceptance across an account change", async () => {
  let finish!: (agent: ModelLaunchAgent) => void;
  create.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ owner }) => useModelLaunch(owner), { initialProps: { owner: "user_a" } });
  let first!: Promise<ModelLaunchAgent | null>;
  act(() => { first = result.current.submit(intent, key); });
  const signal = create.mock.calls[0][2]!.signal!;
  rerender({ owner: "user_b" });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(agent); expect(await first).toBeNull(); });
  expect(result.current.agent).toBeNull();
  expect(result.current.saved).toBeNull();
  expect(sessionStorage.getItem(modelLaunchStorageKey("user_a"))).not.toBeNull();
  expect(sessionStorage.getItem(modelLaunchStorageKey("user_b"))).toBeNull();
});
it("discards lookup results after unmount", async () => {
  store(); let finish!: (agent: ModelLaunchAgent) => void;
  find.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { unmount } = renderHook(() => useModelLaunch("user_a"));
  const signal = find.mock.calls[0][1]!.signal!;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish(agent));
  expect(create).not.toHaveBeenCalled();
});
it("permits a separate new request only after finding the original and explicit user action", async () => {
  store(); find.mockResolvedValue({ ...agent, status: "deleted" });
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await waitFor(() => expect(result.current.agent).not.toBeNull());
  act(() => result.current.startAnother());
  expect(result.current.saved).toBeNull();
  expect(sessionStorage.getItem(modelLaunchStorageKey("user_a"))).toBeNull();
});
it.each(["unreadable", "secret"])("fails closed for %s saved state", async condition => {
  sessionStorage.setItem(modelLaunchStorageKey("user_a"), condition === "unreadable" ? "not-json" : JSON.stringify({ requestId, intent: { ...intent, apiKey: key } }));
  const { result } = renderHook(() => useModelLaunch("user_a"));
  expect(result.current.ready).toBe(false);
  await act(async () => { await result.current.submit(intent, key); });
  expect(create).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
});
it("does not send when storage cannot retain the original request", async () => {
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  const { result } = renderHook(() => useModelLaunch("user_a"));
  await act(async () => { await result.current.submit(intent, key); });
  expect(create).not.toHaveBeenCalled();
  expect(result.current.error).toContain("No new launch was sent");
});
