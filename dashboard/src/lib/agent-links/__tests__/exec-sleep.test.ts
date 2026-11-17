/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockWake = jest.fn();
jest.mock("@/lib/hivra/sleep-aware", () => ({ wakeAgentForUserAction: (...args: unknown[]) => mockWake(...args) }));
const mockRunWithStdin = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScriptWithStdin: (...args: unknown[]) => mockRunWithStdin(...args),
}));
const mockContext = jest.fn();
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: (...args: unknown[]) => mockContext(...args) }));
const mockGvisor = jest.fn();
jest.mock("@/lib/hivra/gvisor-computer-service", () => ({ executeGvisorComputerCommand: (...args: unknown[]) => mockGvisor(...args) }));

import { execRefusalCopy, runLinkedCommand } from "../exec";
import type { OwnedRow } from "../store";

// A linked command on a computer that is asleep: it wakes the computer first
// (the owner's agent asked for it), and says so plainly if it is still waking.

const computer = {
  id: "22222222-2222-4222-8222-222222222222", user_id: "owner", type: "linux-desktop", computer_profile: "ubuntu-desktop",
  status: "running", computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true, vmid: 1113,
} as unknown as OwnedRow;
const request = { command: "uname -a", timeoutSeconds: 10 };

beforeEach(() => {
  mockWake.mockResolvedValue({ ok: true, woke: false, cold: false });
  mockContext.mockResolvedValue({ infrastructureBindingTagEnforced: true, infrastructureBindingTag: `hivra-bind-${"a".repeat(32)}`, env: {} });
  mockRunWithStdin.mockResolvedValue({ ok: true, stdout: "HIVRA_LINK_EXEC_REFUSED guest_unreachable\n", stderr: "" });
});

it("wakes a Proxmox computer before running anything on it", async () => {
  await runLinkedCommand("owner", computer, request);
  expect(mockWake).toHaveBeenCalledWith(computer.id);
  expect(mockWake.mock.invocationCallOrder[0]).toBeLessThan(mockRunWithStdin.mock.invocationCallOrder[0]);
});

it("refuses with computer_asleep, and sends nothing to the host, while the computer is still waking", async () => {
  mockWake.mockResolvedValue({ ok: false, reason: "waking", status: 503, code: "computer_asleep", message: "x" });
  expect(await runLinkedCommand("owner", computer, request)).toEqual({ status: "refused", reason: "computer_asleep" });
  expect(mockContext).not.toHaveBeenCalled();
  expect(mockRunWithStdin).not.toHaveBeenCalled();
});

it("never wakes for a computer that is not running, or a sandbox", async () => {
  expect(await runLinkedCommand("owner", { ...computer, status: "stopped" } as OwnedRow, request)).toEqual({ status: "refused", reason: "computer_not_running" });
  mockGvisor.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
  await runLinkedCommand("owner", { ...computer, computer_substrate: "gvisor" } as OwnedRow, request);
  expect(mockWake).not.toHaveBeenCalled();
});

it("has plain copy for the asleep refusal, without dashes", () => {
  const copy = execRefusalCopy("computer_asleep");
  expect(copy).toMatch(/waking up/);
  expect(copy).not.toMatch(/[-–—]/);
});
