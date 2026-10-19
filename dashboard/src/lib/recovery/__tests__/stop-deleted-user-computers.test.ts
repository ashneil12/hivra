import { stopDeletedUserComputer } from "../stop-deleted-user-computers";
import { supabaseAdmin } from "@/lib/supabase";
import { claimHivraAgentOperation, completeHivraAgentOperation, recordHivraAgentOperationFailure } from "@/lib/hivra/agent-operation-store";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { revokeRemoteDesktopCapability } from "@/lib/remote-computers/session-broker";
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/hivra/agent-operation-store", () => ({ claimHivraAgentOperation: jest.fn(), completeHivraAgentOperation: jest.fn(), recordHivraAgentOperationFailure: jest.fn() }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/remote-computers/session-broker", () => ({ revokeRemoteDesktopCapability: jest.fn() }));
const single = jest.fn();
let operationId: string | null;
const baseAgent = { id: "computer", user_id: "user_gone", status: "running", vmid: 123, computer_substrate: "proxmox-kvm" };
beforeEach(() => {
  jest.clearAllMocks();
  (supabaseAdmin!.from as jest.Mock).mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ single }) }) }) });
  operationId = null;
  single.mockImplementation(async () => ({ data: { ...baseAgent, ...(operationId ? { operation_id: operationId, operation_kind: "stop", desired_state: "stopped" } : {}) }, error: null }));
  (resolveHivraAgentExecutionContext as jest.Mock).mockResolvedValue({ infrastructureBindingTagEnforced: true, infrastructureBindingTag: "hivra-bind-fixture", env: {} });
  (claimHivraAgentOperation as jest.Mock).mockImplementation(async (input) => { operationId = input.operationId; return true; });
  (completeHivraAgentOperation as jest.Mock).mockResolvedValue(true);
  (recordHivraAgentOperationFailure as jest.Mock).mockResolvedValue(true);
  (runProxmoxHostScript as jest.Mock).mockResolvedValue({ ok: true });
  (revokeRemoteDesktopCapability as jest.Mock).mockResolvedValue({ ok: true });
});
it("claims the owner-bound operation and confirms shutdown before persisting stopped", async () => {
  await stopDeletedUserComputer("user_gone", "computer");
  expect(claimHivraAgentOperation).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_gone", agentId: "computer", operationKind: "stop", desiredState: "stopped" }));
  const script = (runProxmoxHostScript as jest.Mock).mock.calls[0][0];
  expect(script).toContain("hivra-bind-fixture");
  expect(script).toContain("autostart disable not confirmed");
  expect(completeHivraAgentOperation).toHaveBeenCalledWith(expect.objectContaining({ expectedDesiredState: "stopped", status: "stopped" }));
});
it("does not touch a computer busy with another lifecycle operation", async () => {
  (claimHivraAgentOperation as jest.Mock).mockResolvedValue(false);
  await expect(stopDeletedUserComputer("user_gone", "computer")).rejects.toThrow("busy");
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});
it("retains uncertainty without marking an unconfirmed stop successful", async () => {
  (runProxmoxHostScript as jest.Mock).mockResolvedValue({ ok: false });
  await expect(stopDeletedUserComputer("user_gone", "computer")).rejects.toThrow("unconfirmed");
  expect(completeHivraAgentOperation).not.toHaveBeenCalled();
  expect(recordHivraAgentOperationFailure).toHaveBeenCalled();
});
it("does not send another substrate through the Proxmox adapter", async () => {
  single.mockResolvedValue({ data: { ...baseAgent, computer_substrate: "provider-vm" }, error: null });
  await expect(stopDeletedUserComputer("user_gone", "computer")).rejects.toThrow("operator containment");
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it.each(["failure", "throw"])("still attempts VM containment when desktop revocation has a %s", async (mode) => {
  if (mode === "failure") (revokeRemoteDesktopCapability as jest.Mock).mockResolvedValue({ ok: false });
  else (revokeRemoteDesktopCapability as jest.Mock).mockRejectedValue(new Error("unavailable"));
  await expect(stopDeletedUserComputer("user_gone", "computer")).rejects.toThrow("revocation is incomplete");
  expect(runProxmoxHostScript).toHaveBeenCalled();
  expect(completeHivraAgentOperation).not.toHaveBeenCalled();
});
it("refuses a provider identity changed after operation claim", async () => {
  single.mockResolvedValueOnce({ data: baseAgent, error: null }).mockImplementation(async () => ({ data: { ...baseAgent, vmid: 999, operation_id: operationId, operation_kind: "stop", desired_state: "stopped" }, error: null }));
  await expect(stopDeletedUserComputer("user_gone", "computer")).rejects.toThrow("authority changed after");
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});
it("retries the same durable stop operation after an uncertain outcome", async () => {
  operationId = "11111111-1111-4111-8111-111111111111";
  await stopDeletedUserComputer("user_gone", "computer");
  expect(claimHivraAgentOperation).not.toHaveBeenCalled();
  expect(completeHivraAgentOperation).toHaveBeenCalledWith(expect.objectContaining({ operationId, expectedDesiredState: "stopped", status: "stopped" }));
  expect(completeHivraAgentOperation).toHaveBeenCalled();
});
