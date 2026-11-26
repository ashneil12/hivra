/** @jest-environment jsdom */

import { launchResultHref, SERVERS_FULL_RETRY_MS, submitLaunchDraft } from "../launch-adapter";
import {
  createAgent,
  findHivraLaunchReceipt,
  HivraLaunchCorrectableError,
  HivraLaunchInProgressError,
  HivraLaunchRejectedError,
  type HivraAgent,
} from "@/lib/hivra/agent-api";

jest.mock("@/lib/hivra/agent-api", () => {
  const actual = jest.requireActual("@/lib/hivra/agent-api");
  return { ...actual, createAgent: jest.fn(), findHivraLaunchReceipt: jest.fn() };
});

const requestId = "11111111-1111-4111-8111-111111111111";
const accepted = {
  id: "22222222-2222-4222-8222-222222222222",
  type: "linux-desktop" as const,
  computer_profile: "ubuntu-desktop" as const,
  name: "Ubuntu",
  status: "provisioning" as const,
  cpu: 2,
  ram: 8,
};
const draft = {
  resourceKind: "computer",
  profileId: "ubuntu-desktop",
  name: "Ubuntu",
  launchRequestId: requestId,
  resources: { cpu: 2, ram: 8, maximumCpu: 2, maximumRam: 8 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("bounded launch receipt reconciliation", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => jest.useRealTimers());

  it("settles from POST success first and aborts the slower receipt read", async () => {
    const post = deferred<HivraAgent>();
    const receipt = deferred<never>();
    jest.mocked(createAgent).mockReturnValue(post.promise);
    jest.mocked(findHivraLaunchReceipt).mockReturnValue(receipt.promise);

    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" });
    await flushMicrotasks();
    post.resolve(accepted);

    await expect(result).resolves.toEqual(accepted);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(findHivraLaunchReceipt).toHaveBeenCalledTimes(1);
    expect(jest.mocked(findHivraLaunchReceipt).mock.calls[0][1]?.aborted).toBe(true);
  });

  it("settles from the owner receipt first while the POST remains slow", async () => {
    const post = deferred<HivraAgent>();
    jest.mocked(createAgent).mockReturnValue(post.promise);
    jest.mocked(findHivraLaunchReceipt).mockResolvedValue({ state: "accepted", phase: "accepted", agent: accepted });

    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" });

    await expect(result).resolves.toEqual(accepted);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(findHivraLaunchReceipt).toHaveBeenCalledTimes(1);
  });

  it("settles from a definite POST rejection without waiting for the receipt or the deadline", async () => {
    const failure = new HivraLaunchCorrectableError("Change the selected capacity.", 409, "target_changed");
    jest.mocked(createAgent).mockRejectedValue(failure);
    jest.mocked(findHivraLaunchReceipt).mockReturnValue(new Promise(() => undefined));

    await expect(submitLaunchDraft(draft as never, { mode: "hivra-managed" })).rejects.toBe(failure);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(jest.mocked(findHivraLaunchReceipt).mock.calls[0][1]?.aborted).toBe(true);
  });

  it("returns a rate limit immediately after a definite capacity refusal", async () => {
    const rateLimit = new HivraLaunchCorrectableError("Too many requests", 429);
    jest.mocked(createAgent)
      .mockRejectedValueOnce(new HivraLaunchCorrectableError("No room", 503, "servers_full"))
      .mockRejectedValueOnce(rateLimit);
    jest.mocked(findHivraLaunchReceipt).mockResolvedValue(null);
    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" });
    const rejection = expect(result).rejects.toBe(rateLimit);
    await jest.advanceTimersByTimeAsync(SERVERS_FULL_RETRY_MS);
    await rejection;
    expect(createAgent).toHaveBeenCalledTimes(2);
  });

  it("accepts a delayed owner receipt when the replay POST is rate-limited", async () => {
    jest.mocked(createAgent).mockRejectedValue(new HivraLaunchCorrectableError("Too many requests", 429));
    const receipt = deferred<{ state: "accepted"; phase: string; agent: HivraAgent }>();
    jest.mocked(findHivraLaunchReceipt).mockReturnValue(receipt.promise);
    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" }, { resumingUncertain: true });
    await jest.advanceTimersByTimeAsync(1_000);
    receipt.resolve({ state: "accepted", phase: "accepted", agent: accepted });
    await expect(result).resolves.toEqual(accepted);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(findHivraLaunchReceipt).toHaveBeenCalledWith(requestId, expect.anything());
  });

  it("keeps the request resumable when rate-limited and no receipt is visible yet", async () => {
    jest.mocked(createAgent).mockRejectedValue(new HivraLaunchCorrectableError("Too many requests", 429));
    jest.mocked(findHivraLaunchReceipt).mockResolvedValue(null);
    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" }, { resumingUncertain: true });
    const rejected = expect(result).rejects.toMatchObject({ name: HivraLaunchInProgressError.name, launchRequestId: requestId });
    await jest.advanceTimersByTimeAsync(195_000);
    await rejected;
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("settles from a terminal receipt failure while the POST remains slow", async () => {
    const failure = new HivraLaunchRejectedError("The saved launch stopped before a computer was accepted.", 409, "agent_insert_conflict");
    jest.mocked(createAgent).mockReturnValue(new Promise(() => undefined));
    jest.mocked(findHivraLaunchReceipt).mockRejectedValue(failure);

    await expect(submitLaunchDraft(draft as never, { mode: "hivra-managed" })).rejects.toBe(failure);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(jest.mocked(findHivraLaunchReceipt).mock.calls[0][1]?.aborted).toBe(true);
  });

  it("lets a receipt answer after the POST response fails uncertainly", async () => {
    jest.mocked(createAgent).mockRejectedValue(new Error("network response lost"));
    jest.mocked(findHivraLaunchReceipt).mockImplementation(async () => {
      await new Promise(resolve => window.setTimeout(resolve, 1_000));
      return { state: "accepted", phase: "accepted", agent: accepted };
    });

    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" });
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual(accepted);
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("accepts a delayed receipt after the former 30-second limit without repeating the launch POST", async () => {
    jest.mocked(createAgent).mockReturnValue(new Promise(() => undefined));
    const startedAt = Date.now();
    jest.mocked(findHivraLaunchReceipt).mockImplementation(async id => {
      expect(id).toBe(requestId);
      return Date.now() - startedAt >= 35_000
        ? { state: "accepted", phase: "accepted", agent: accepted }
        : { state: "reconciling", phase: "reserved" };
    });

    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" });
    await jest.advanceTimersByTimeAsync(35_250);

    await expect(result).resolves.toEqual(accepted);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createAgent).mock.calls[0][0]).toMatchObject({ launchRequestId: requestId });
    expect(findHivraLaunchReceipt).toHaveBeenCalled();
  });

  it("ends the observation window even when the POST and receipt read are both stuck", async () => {
    jest.mocked(createAgent).mockReturnValue(new Promise(() => undefined));
    jest.mocked(findHivraLaunchReceipt).mockReturnValue(new Promise(() => undefined));
    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" });
    const rejected = expect(result).rejects.toMatchObject({
      name: HivraLaunchInProgressError.name,
      launchRequestId: requestId,
    });

    await jest.advanceTimersByTimeAsync(195_000);
    await rejected;
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(jest.mocked(findHivraLaunchReceipt).mock.calls[0][1]?.aborted).toBe(true);
  });

  it("keeps the same owner-generated request id on a retry after an uncertain first response", async () => {
    jest.mocked(createAgent)
      .mockRejectedValueOnce(new Error("network response lost"))
      .mockResolvedValueOnce(accepted);
    jest.mocked(findHivraLaunchReceipt).mockResolvedValue(null);

    const first = submitLaunchDraft(draft as never, { mode: "hivra-managed" });
    const firstFailure = expect(first).rejects.toThrow("network response lost");
    await jest.advanceTimersByTimeAsync(195_000);
    await firstFailure;
    await submitLaunchDraft(draft as never, { mode: "hivra-managed" });

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(jest.mocked(createAgent).mock.calls.map(([input]) => input.launchRequestId)).toEqual([requestId, requestId]);
  });

  it("returns one logical accepted result when the POST and receipt settle together", async () => {
    const post = deferred<HivraAgent>();
    const receipt = deferred<{ state: "accepted"; phase: "accepted"; agent: HivraAgent }>();
    jest.mocked(createAgent).mockReturnValue(post.promise);
    jest.mocked(findHivraLaunchReceipt).mockReturnValue(receipt.promise);

    const result = submitLaunchDraft(draft as never, { mode: "hivra-managed" });
    post.resolve(accepted);
    receipt.resolve({ state: "accepted", phase: "accepted", agent: accepted });

    await expect(result).resolves.toEqual(accepted);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(findHivraLaunchReceipt).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("sends the chosen Codex browser flag (%s) with its envelope", async browser => {
    const codex = { ...accepted, type: "codex" as const, computer_profile: null, name: "Codex" };
    jest.mocked(createAgent).mockResolvedValue(codex);
    const resources = browser
      ? { cpu: 1.5, ram: 3, maximumCpu: 2, maximumRam: 4 }
      : { cpu: 0.5, ram: 1, maximumCpu: 0.5, maximumRam: 1 };

    await expect(submitLaunchDraft({
      resourceKind: "agent", profileId: "codex", name: "Codex", launchRequestId: requestId, resources, browser,
    } as never, { mode: "hivra-managed" })).resolves.toEqual(codex);

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createAgent).mock.calls[0][0]).toEqual({
      type: "codex", name: "Codex", ...resources, browser,
      deployment: { mode: "hivra-managed" }, launchRequestId: requestId,
    });
  });

  it.each([
    ["ubuntu-desktop", { cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8 }],
    ["ubuntu-server", { cpu: 1, ram: 2, maximumCpu: 2, maximumRam: 4 }],
  ] as const)("posts %s as the linux-desktop type with its own profile and no browser", async (profileId, resources) => {
    const row = { ...accepted, computer_profile: profileId };
    jest.mocked(createAgent).mockResolvedValue(row);

    await expect(submitLaunchDraft({
      resourceKind: "computer", profileId, name: "Computer", launchRequestId: requestId, resources,
    } as never, { mode: "hivra-managed" })).resolves.toEqual(row);

    expect(jest.mocked(createAgent).mock.calls[0][0]).toEqual({
      type: "linux-desktop", computerProfile: profileId, name: "Computer", ...resources, browser: false,
      deployment: { mode: "hivra-managed" }, launchRequestId: requestId,
    });
  });

  it("opens a Linux computer on its files and a desktop on its desktop", () => {
    const base = { launchRequestId: requestId, capacity: { mode: "hivra-managed", targetId: null } };
    expect(launchResultHref({ ...base, profileId: "ubuntu-server" } as never, accepted.id)).toBe(`/dashboard/agent/${accepted.id}?tab=files`);
    expect(launchResultHref({ ...base, profileId: "ubuntu-desktop" } as never, accepted.id)).toBe(`/dashboard/agent/${accepted.id}?tab=desktop`);
  });
});
