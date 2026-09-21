/** @jest-environment node */

jest.mock("server-only", () => ({}));

const mockWarn = jest.fn();
jest.mock("@/lib/logger", () => ({ log: { warn: (...args: unknown[]) => mockWarn(...args) } }));

import { BUZZ_SPRIG_RELEASE } from "../buzz-runtime";
import { BuzzRuntimeControlError, installBuzzRuntime, observeBuzzRuntime, removeBuzzRuntime } from "../buzz-runtime-service";
import type { BuzzRuntimeAgentRow } from "../buzz-store";
import type { HivraAgentExecutionContext } from "../agent-execution-context";

const BINDING = "00000000-0000-4000-8000-000000001014";
const AGENT = "00000000-0000-4000-8000-000000001008";
const PUBLIC = "b".repeat(64);
const agent: BuzzRuntimeAgentRow = {
  id: AGENT, user_id: "user_a", name: "Research", type: "codex", status: "running", desired_state: "running",
  ip: "10.241.30.40", vmid: 1112, operation_id: null, operation_kind: null,
  computer_substrate: "proxmox-kvm", provider_capacity_order_id: null,
  provider_enrollment_attempt_id: null, provider_server_id: null, deployment_mode: "hivra-managed", proxmox_host: "fixturenode1",
  infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null,
  infrastructure_binding_token_hash: "9".repeat(64), infrastructure_binding_token_enforced: true,
};
const context = { kind: "managed", host: "fixturenode1", env: { PROXMOX_HOST: "fixture" },
  paths: { vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator" },
  infrastructureBindingTag: `hivra-bind-${"9".repeat(32)}`,
  infrastructureBindingTagEnforced: true } as unknown as HivraAgentExecutionContext;
const installInput = {
  bindingId: BINDING, agentId: AGENT, agentType: "codex", agentIp: agent.ip!, publicKey: PUBLIC,
  privateKey: "1".repeat(64), relayUrl: "wss://buzz.example", provider: "openai" as const,
  model: "gpt-5", apiKey: "sk-fixture", ownerPublicKey: "c".repeat(64),
  operationId: "00000000-0000-4000-8000-000000001017",
  requestDigest: "d".repeat(64), leaseId: "00000000-0000-4000-8000-000000001023",
};
function line(action: "installed" | "observed" | "removed") {
  const base = { protocol: "hivra-buzz-runtime-v1", action, bindingId: BINDING, agentId: AGENT, publicKey: PUBLIC,
    serviceName: `hivra-buzz-${BINDING}.service`, sourceGitSha: BUZZ_SPRIG_RELEASE.sourceGitSha,
    observedAt: "2026-09-01T12:00:00Z" };
  const receipt = action === "installed" ? { ...base, state: "active", architecture: "x86_64",
    archiveSha256: BUZZ_SPRIG_RELEASE.targets.x86_64.archiveSha256,
    binarySha256: BUZZ_SPRIG_RELEASE.targets.x86_64.binarySha256, provider: "openai", model: "gpt-5",
    ownerPublicKey: "c".repeat(64), operationId: installInput.operationId,
    requestDigest: installInput.requestDigest, leaseId: installInput.leaseId, mainPid: 42 }
    : action === "observed" ? { ...base, state: "active", architecture: "x86_64",
      binarySha256: BUZZ_SPRIG_RELEASE.targets.x86_64.binarySha256, mainPid: 42 }
      : { ...base, state: "absent", operationId: installInput.operationId,
        requestDigest: installInput.requestDigest, leaseId: installInput.leaseId };
  return `HIVRA_BUZZ_RUNTIME_V1 ${JSON.stringify(receipt)}\n`;
}

describe("Buzz runtime control", () => {
  beforeEach(() => mockWarn.mockClear());

  it("binds execution to the owned agent context and exact receipt", async () => {
    const resolveContext = jest.fn(async () => context);
    const runHostScript = jest.fn(async () => ({ ok: true, stdout: line("installed"), stderr: "" }));
    await expect(installBuzzRuntime("user_a", agent, installInput, { resolveContext, runHostScript: runHostScript as never }))
      .resolves.toMatchObject({ action: "installed", bindingId: BINDING, agentId: AGENT });
    expect(resolveContext).toHaveBeenCalledWith("user_a", agent);
    expect(runHostScript).toHaveBeenCalledWith(expect.stringContaining('ubuntu@$GUEST_IP'), context.env,
      { timeoutMs: 180_000 });
    const hostScript = (runHostScript as jest.Mock).mock.calls[0]?.[0] as string;
    expect(hostScript).toContain('VMID=1112');
    expect(hostScript).toContain('/etc/hivra/keys/vm-orchestrator');
    expect(hostScript).toContain('hivra-bind-99999999999999999999999999999999');
  });

  it("supports fresh observation and secret-erasing removal without another provider key", async () => {
    const identity = { bindingId: BINDING, agentId: AGENT, agentIp: agent.ip!, publicKey: PUBLIC };
    const resolveContext = jest.fn(async () => context);
    const runHostScript = jest.fn()
      .mockResolvedValueOnce({ ok: true, stdout: line("observed"), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: line("removed"), stderr: "" });
    await expect(observeBuzzRuntime("user_a", agent, identity, { resolveContext, runHostScript: runHostScript as never }))
      .resolves.toMatchObject({ action: "observed" });
    await expect(removeBuzzRuntime("user_a", agent, { ...identity, operationId: installInput.operationId,
      requestDigest: installInput.requestDigest, leaseId: installInput.leaseId }, { resolveContext, runHostScript: runHostScript as never }))
      .resolves.toMatchObject({ action: "removed" });
  });

  it("never treats a transport failure or mismatched receipt as success", async () => {
    const dependencies = { resolveContext: jest.fn(async () => context),
      runHostScript: jest.fn(async () => ({ ok: false, stdout: "",
        stderr: "secret error\nHIVRA_BUZZ_RUNTIME_FAILURE stage=archive_digest code=46\n",
        error: "Remote bash exited with code 46" })) as never };
    await expect(installBuzzRuntime("user_a", agent, installInput, dependencies)).rejects
      .toEqual(expect.objectContaining({ code: "outcome_unknown" }));
    expect(mockWarn).toHaveBeenCalledWith(
      "Buzz runtime host dispatch returned no usable receipt",
      expect.objectContaining({
        source: "hivra/buzz-runtime",
        failureType: "buzz_runtime_host_exit",
        instanceId: AGENT,
        bindingId: BINDING,
        host: "fixturenode1",
        vmid: 1112,
        action: "installed",
        hostExitCode: 46,
        guestStage: "archive_digest",
        guestExitCode: 46,
      }),
    );
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret error");
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(installInput.apiKey);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain(installInput.privateKey);
    dependencies.runHostScript = jest.fn(async () => ({ ok: true, stdout: line("removed"), stderr: "" })) as never;
    await expect(installBuzzRuntime("user_a", agent, installInput, dependencies)).rejects
      .toEqual(expect.objectContaining({ code: "receipt_invalid" }));
    dependencies.runHostScript = jest.fn(async () => ({ ok: true, stdout: line("installed"), stderr: "" })) as never;
    await expect(installBuzzRuntime("user_a", agent, {
      ...installInput, operationId: "00000000-0000-4000-8000-000000001020",
    }, dependencies)).rejects.toEqual(expect.objectContaining({ code: "receipt_invalid" }));
  });

  it("rejects provider-native and stopped targets before any host command", async () => {
    const runHostScript = jest.fn();
    await expect(installBuzzRuntime("user_a", { ...agent, computer_substrate: "provider-vm" }, installInput,
      { resolveContext: jest.fn(), runHostScript: runHostScript as never })).rejects.toBeInstanceOf(BuzzRuntimeControlError);
    await expect(installBuzzRuntime("user_a", { ...agent, status: "stopped" }, installInput,
      { resolveContext: jest.fn(), runHostScript: runHostScript as never })).rejects.toBeInstanceOf(BuzzRuntimeControlError);
    await expect(installBuzzRuntime("user_a", { ...agent, infrastructure_binding_token_enforced: false }, installInput,
      { resolveContext: jest.fn(), runHostScript: runHostScript as never })).rejects.toBeInstanceOf(BuzzRuntimeControlError);
    await expect(installBuzzRuntime("user_a", { ...agent, operation_id: "00000000-0000-4000-8000-000000001029" }, installInput,
      { resolveContext: jest.fn(), runHostScript: runHostScript as never })).rejects.toBeInstanceOf(BuzzRuntimeControlError);
    expect(runHostScript).not.toHaveBeenCalled();
  });
});
