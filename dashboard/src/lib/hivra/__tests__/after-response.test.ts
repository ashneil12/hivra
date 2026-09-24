/** @jest-environment node */
import { after } from "next/server";

jest.mock("next/server", () => ({ after: jest.fn() }));
const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ log: { warn: (...args: unknown[]) => mockWarn(...args) } }));

import { runAfterResponse } from "../after-response";

const scheduled = () => (after as unknown as jest.Mock).mock.calls.map(([callback]) => callback as () => Promise<void>);

beforeEach(() => {
  (after as unknown as jest.Mock).mockReset();
  mockWarn.mockReset();
});

it("hands the work to next/server after(), so it never runs before the response", () => {
  const task = jest.fn(async () => undefined);
  runAfterResponse(task, { source: "test", failureType: "test_failed" });
  expect(after).toHaveBeenCalledTimes(1);
  expect(task).not.toHaveBeenCalled();
});

it("logs a failure with its context instead of throwing into a finished response", async () => {
  runAfterResponse(async () => { throw new Error("guest unreachable"); }, { source: "hivra/agents/[id]", failureType: "computer_contract_step_skipped", agentId: "agent-1" });
  await expect(scheduled()[0]()).resolves.toBeUndefined();
  expect(mockWarn).toHaveBeenCalledWith("background step failed", {
    source: "hivra/agents/[id]", failureType: "computer_contract_step_skipped", agentId: "agent-1", errorMessage: "guest unreachable",
  });
});
