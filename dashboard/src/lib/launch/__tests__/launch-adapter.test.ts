/** @jest-environment jsdom */

import { submitLaunchDraft } from "../launch-adapter";
import { createAgent, findHivraLaunchReceipt } from "@/lib/hivra/agent-api";

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

describe("bounded launch receipt reconciliation", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => jest.useRealTimers());

  it("accepts a receipt after the former 30-second limit without repeating the launch POST", async () => {
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
});
