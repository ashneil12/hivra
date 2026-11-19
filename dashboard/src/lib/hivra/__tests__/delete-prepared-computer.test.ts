/** @jest-environment node */
// Deleting a prepared computer's claim must keep the prepared VM
// (docs/release/OMARCHY-PREPARED-REFRESH.md): Delete releases the claim's
// binding on the slot and never runs the per-claim VM destroy script.

jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

let mockOperationId = "";
let mockRow: Record<string, unknown> = {};
const mockTable = (name: string) => {
  const result = name === "hivra_agents"
    ? { data: { ...mockRow, operation_kind: "delete", operation_id: mockOperationId, desired_state: "deleted" }, error: null }
    : { data: null, error: null };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.single = async () => result;
  chain.maybeSingle = async () => result;
  return chain;
};
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (name: string) => mockTable(name) } }));
const mockRunHost = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunHost(...args),
  resolveProxmoxTargetConfiguration: () => ({ env: { SLOT_HOST: "1" } }),
}));
const mockMatch = jest.fn();
jest.mock("@/lib/hivra/prepared-canary-computers", () => ({
  matchPreparedCanaryComputer: (...args: unknown[]) => mockMatch(...args),
  preparedCanaryReleaseScript: (profile: string, slot: { vmid: number }, hash: string | null) =>
    `RELEASE ${profile} ${slot.vmid} ${hash}`,
}));
jest.mock("@/lib/hivra/agent-events", () => ({ logHivraAgentEvent: jest.fn() }));
jest.mock("@/lib/hivra/agent-delete-cleanup", () => ({ HivraAgentDeleteCleanupError: class extends Error {} }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({
  describeHivraAgentExecutionContextError: jest.fn(),
  hivraAgentProvisionLogPath: () => null,
  hivraAgentProvisionSecretPath: () => null,
  hivraAgentStartLogPath: () => null,
  resolveHivraAgentTeardownExecutionContext: async () => ({
    host: "node-b", env: { CONTEXT_HOST: "1" }, paths: { storage: "local-lvm" },
    infrastructureBindingTagEnforced: true, infrastructureBindingTag: `hivra-bind-${"a".repeat(32)}`,
  }),
}));
jest.mock("@/lib/hivra/tailscale-private-access", () => ({
  hivraPrivateAccessAuthority: jest.fn(),
  prepareHivraTailscaleForDelete: jest.fn(),
  sameHivraPrivateAccessAuthority: () => false,
}));
const mockComplete = jest.fn();
const mockRelease = jest.fn();
jest.mock("@/lib/hivra/agent-operation-store", () => ({
  completeHivraAgentDelete: (...args: unknown[]) => mockComplete(...args),
  releaseHivraAgentOperation: (...args: unknown[]) => mockRelease(...args),
  requestHivraAgentDelete: async (input: { operationId: string }) => {
    mockOperationId = input.operationId;
    return "claimed";
  },
}));
jest.mock("@/lib/hivra/sleep-aware", () => ({ wakeForUserAction: async () => ({ ok: true }) }));

import { deleteProxmoxHivraAgent } from "../delete-hivra-agent";

const HASH = "a".repeat(64);
const SLOT = { host: "node-b", node: "node-b", vmid: 2098, ip: "10.240.20.98", claim: "00000000-0000-4000-8000-000000001005" };

function preparedRow(profile: "windows" | "omarchy", extra: Record<string, unknown> = {}) {
  return {
    id: "agent-1", user_id: "owner", type: "computer", status: "running", deployment_mode: "hivra-managed",
    computer_profile: profile, vmid: SLOT.vmid, proxmox_host: "node-b", ip_address: SLOT.ip,
    infrastructure_binding_token_hash: HASH, allocation_operation_id: null, ...extra,
  };
}

beforeEach(() => {
  mockRunHost.mockReset();
  mockMatch.mockReset();
  mockComplete.mockReset().mockResolvedValue(true);
  mockRelease.mockReset().mockResolvedValue(true);
});

describe("deleteProxmoxHivraAgent and a prepared computer", () => {
  it.each(["windows", "omarchy"] as const)("releases a %s claim's binding and keeps the VM", async (profile) => {
    mockRow = preparedRow(profile);
    mockMatch.mockReturnValue({ profile, slot: SLOT });
    mockRunHost.mockResolvedValue({ ok: true, stdout: "HIVRA_PREPARED_BINDING_RELEASED\n", stderr: "" });

    expect(await deleteProxmoxHivraAgent("owner", mockRow)).toEqual({ ok: true });
    expect(mockRunHost).toHaveBeenCalledTimes(1);
    const [script, env] = mockRunHost.mock.calls[0];
    expect(script).toBe(`RELEASE ${profile} 2098 ${HASH}`);
    expect(script).not.toContain("qm destroy");
    expect(env).toEqual({ SLOT_HOST: "1" });
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it("releases a claim that carries an allocation operation the same way", async () => {
    mockRow = preparedRow("omarchy", { allocation_operation_id: "11111111-1111-4111-8111-111111111111" });
    mockMatch.mockReturnValue({ profile: "omarchy", slot: SLOT });
    mockRunHost.mockResolvedValue({ ok: true, stdout: "HIVRA_PREPARED_BINDING_RELEASED\n", stderr: "" });

    expect(await deleteProxmoxHivraAgent("owner", mockRow)).toEqual({ ok: true });
    expect(mockRunHost.mock.calls[0][0]).toMatch(/^RELEASE omarchy/);
  });

  it("keeps the row when the release is not confirmed", async () => {
    mockRow = preparedRow("windows");
    mockMatch.mockReturnValue({ profile: "windows", slot: SLOT });
    mockRunHost.mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    const result = await deleteProxmoxHivraAgent("owner", mockRow);
    expect(result).toEqual({ ok: false, status: 502, message: "The prepared computer could not be released. Retry Delete." });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith(expect.objectContaining({ markError: true }));
  });

  it("refuses, touching no VM, when the row does not match a configured prepared slot", async () => {
    mockRow = preparedRow("windows");
    mockMatch.mockReturnValue(null);

    const result = await deleteProxmoxHivraAgent("owner", mockRow);
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 409 }));
    expect(mockRunHost).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("still destroys an ordinary computer's own VM", async () => {
    mockRow = { ...preparedRow("windows"), computer_profile: null, allocation_operation_id: "11111111-1111-4111-8111-111111111111" };
    mockRunHost.mockResolvedValue({ ok: true, stdout: "", stderr: "" });

    expect(await deleteProxmoxHivraAgent("owner", mockRow)).toEqual({ ok: true });
    expect(mockMatch).not.toHaveBeenCalled();
    expect(mockRunHost.mock.calls[0][0]).toContain("qm destroy");
    expect(mockRunHost.mock.calls[0][1]).toEqual({ CONTEXT_HOST: "1" });
  });
});
