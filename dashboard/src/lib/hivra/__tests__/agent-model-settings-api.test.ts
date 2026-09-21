import { randomUUID } from "node:crypto";
import { cancelAgentLaunchModel, continueAgentLaunchModel, getAgentModelSettings, resumeAgentModelSettings, setAgentModelSettings } from "../agent-model-settings-api";

const op = randomUUID(), originalFetch = global.fetch;
const input = { provider: "venice" as const, mode: "byok" as const, apiKey: "synthetic-fixture-key" };
const requestId = randomUUID();
const launch = { requestId, operationId: op, createdAt: "2026-08-28T00:00:00Z", state: "needs_attention",
  requested: { provider: "venice", mode: "byok", model: "fixture-model" } };
beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); });
const respond = (data: unknown, status = 200) => jest.mocked(fetch).mockResolvedValue(Response.json({ success: true, data }, { status }));

it("reads only key-free summaries with same-origin credentials and no cache", async () => {
  respond({ llm: null, pending: null });
  expect(await getAgentModelSettings("agent/fixture")).toEqual({ llm: null, pending: null });
  expect(fetch).toHaveBeenCalledWith("/api/hivra/agents/agent%2Ffixture/llm", expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error", credentials: "same-origin" }));
});
it.each(["apply", "resume"])("sends an explicit %s request once and keeps pending distinct from applied", async action => {
  respond({ operationId: op, status: "pending", reason: "delivery_unconfirmed" }, 202);
  const result = action === "apply" ? await setAgentModelSettings("agent", op, input) : await resumeAgentModelSettings("agent", op);
  expect(result.status).toBe("pending"); expect(fetch).toHaveBeenCalledTimes(1);
  const options = jest.mocked(fetch).mock.calls[0][1]!;
  expect(JSON.parse(options.body as string)).toEqual(action === "apply" ? { action, operationId: op, llm: input } : { action, operationId: op });
  expect(options.signal!.aborted).toBe(true);
});
it("sends clear as explicit null rather than an omitted or malformed selection", async () => {
  respond({ operationId: op, status: "applied" });
  await setAgentModelSettings("agent", op, null);
  expect(JSON.parse(jest.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ action: "apply", operationId: op, llm: null });
});
it.each([{}, null, { operationId: randomUUID(), status: "applied" }, { operationId: op, status: "success" },
  { operationId: op, status: "applied", boxPayload: { apiKey: "unexpected-secret" } }])("rejects malformed, wrong-request or plaintext results: %j", async data => {
  respond(data);
  await expect(setAgentModelSettings("agent", op, input)).rejects.toThrow("did not match your change");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([{ llm: null }, { llm: null, pending: null, encrypted_key: "private" }, { llm: null, pending: {} }])("does not assume missing or unsafe summary data means native settings", async data => {
  respond(data); await expect(getAgentModelSettings("agent")).rejects.toThrow("could not be read");
});
it("retains typed server errors without silently retrying", async () => {
  jest.mocked(fetch).mockResolvedValue(Response.json({ success: false, error: "Guest update required.", code: "guest_upgrade_required" }, { status: 409 }));
  await expect(setAgentModelSettings("agent", op, input)).rejects.toMatchObject({ code: "guest_upgrade_required" });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("turns network loss into uncertainty without reflecting raw exception data", async () => {
  jest.mocked(fetch).mockRejectedValue(new Error("PRIVATE synthetic-fixture-key"));
  await expect(setAgentModelSettings("agent", op, input)).rejects.toThrow("Connection interrupted");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("propagates the view lifetime cancellation and removes its listener", async () => {
  const scope = new AbortController();
  jest.mocked(fetch).mockImplementation(async (_url, init) => {
    scope.abort(); expect(init!.signal!.aborted).toBe(true); throw new Error("aborted");
  });
  await expect(setAgentModelSettings("agent", op, input, { signal: scope.signal })).rejects.toThrow("Refresh model settings");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(["waiting_for_computer", "ready_to_apply", "setup_requested", "needs_attention"])("reads strict launch metadata in %s", async state => {
  respond({ llm: null, pending: null, launch: { ...launch, state } });
  expect((await getAgentModelSettings("agent")).launch).toEqual({ ...launch, state });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  { ...launch, state: "completed" }, { ...launch, requestId: "bad" },
  { ...launch, requested: { ...launch.requested, apiKey: "private" } },
  { ...launch, requested: { ...launch.requested, mode: "managed" } },
  { ...launch, encrypted_key: "private" },
])("rejects unsafe or ambiguous launch metadata", async value => {
  respond({ llm: null, pending: null, launch: value });
  await expect(getAgentModelSettings("agent")).rejects.toThrow("could not be read");
});
it.each([true, false])("continues the same launch once with automatic=%s and no secret", async automatic => {
  respond({ requestId, operationId: op, status: "waiting", reason: "resume_required" }, 202);
  expect((await continueAgentLaunchModel("agent", requestId, op, automatic)).status).toBe("waiting");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(jest.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ action: "continue_launch", requestId, automatic });
});
it.each([
  { requestId: randomUUID(), operationId: op, status: "applied" },
  { requestId, operationId: randomUUID(), status: "applied" },
  { requestId, operationId: op, status: "applied", apiKey: "private" },
])("does not accept a continuation response for another request or operation", async value => {
  respond(value); await expect(continueAgentLaunchModel("agent", requestId, op, false)).rejects.toThrow("did not match this launch");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("cancels only the identified launch choice", async () => {
  respond({ requestId, status: "cancelled" });
  await expect(cancelAgentLaunchModel("agent", requestId)).resolves.toEqual({ requestId, status: "cancelled" });
  expect(JSON.parse(jest.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({ action: "cancel_launch", requestId });
});
it("does not accept cancellation of a different launch", async () => {
  respond({ requestId: randomUUID(), status: "cancelled" });
  await expect(cancelAgentLaunchModel("agent", requestId)).rejects.toThrow("did not match this launch");
});
