/** @jest-environment node */

jest.mock("server-only", () => ({}));

import {
  ProxmoxExecutionContextError,
  type SelfManagedProxmoxExecutionContext,
} from "@/lib/infrastructure/proxmox-execution-context";
import {
  checkHivraAgentRecoveryAuthority,
  describeHivraAgentExecutionContextError,
  hivraAgentProvisionLogPath,
  hivraAgentProvisionSecretPath,
  hivraAgentStartLogPath,
  resolveHivraAgentExecutionContext,
  resolveHivraAgentTeardownExecutionContext,
} from "../agent-execution-context";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";

const connectionId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const bindingTokenHash = "b".repeat(64);

function portableContext(): SelfManagedProxmoxExecutionContext {
  return {
    kind: "self-managed",
    connectionId,
    targetId,
    connectionRevision: 7,
    target: {
      id: targetId,
      connectionId,
      evidenceConnectionRevision: 7,
      externalId: "pve-home",
      displayName: "Home / pve-home",
      status: "ready",
      capacity: {
        cpu: { totalCores: 12, utilizationRatio: 0.2 },
        memoryBytes: { total: 64_000, available: 48_000 },
        storageBytes: { total: 1_000_000, available: 800_000 },
      },
      capabilities: {
        proxmoxVersion: "8.4.1",
        launchReady: true,
        directRootAccess: true,
        kvmAvailable: true,
        bridges: ["hivra0"],
        selectedBridge: "hivra0",
        storages: ["fast-zfs"],
        selectedStorage: "fast-zfs",
        template: null,
        provisioner: { configured: true, ready: true, version: "2026.08.26.1" },
        runtimeCompatibility: null,
        vmidRange: { start: 400, end: 499, freeCount: 100, firstAvailable: 400 },
        issues: [],
      },
      supportedIsolationDrivers: ["proxmox-kvm"],
      isolationClass: "hardware-vm",
      lastPreflightAt: "2026-08-26T12:00:00.000Z",
      lastErrorCode: null,
      createdAt: "2026-08-26T12:00:00.000Z",
      updatedAt: "2026-08-26T12:00:00.000Z",
    },
    env: { PROXMOX_NODE: "pve-home", HIVRA_USER_INFRA_CONNECTION: "true" },
    runtime: {
      node: "pve-home",
      bridge: "hivra0",
      storage: "fast-zfs",
      vmidStart: 400,
      vmidEnd: 499,
      ipLastOctetStart: 50,
      subnetPrefix: "10.251.20",
      gateway: "10.251.20.1",
      provisionerDirectory: "/opt/hivra/provisioner",
      provisionerVersion: "2026.08.26.1",
      ubuntuImage: "/var/lib/vz/template/iso/hivra-ubuntu-jammy.img",
      vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      logDirectory: "/var/log/hivra",
    },
  };
}

describe("Hivra agent execution context", () => {
  it.each([
    { computer_substrate: "provider-vm" }, { computer_substrate: "unknown" },
    { provider_capacity_order_id: targetId }, { provider_enrollment_attempt_id: targetId },
    { provider_server_id: "42" },
  ])("refuses provider identity before opening any Proxmox credentials: %j", async (identity) => {
    const dependencies = { resolveManaged: jest.fn(), resolveSelfManaged: jest.fn() };
    for (const resolver of [resolveHivraAgentExecutionContext, resolveHivraAgentTeardownExecutionContext]) {
      await expect(resolver("user_a", { ...identity, deployment_mode: "hivra-managed", proxmox_host: "fixturenode21",
        infrastructure_binding_token_hash: bindingTokenHash }, dependencies)).rejects.toBeInstanceOf(ProxmoxExecutionContextError);
    }
    expect(dependencies.resolveManaged).not.toHaveBeenCalled();
    expect(dependencies.resolveSelfManaged).not.toHaveBeenCalled();
  });

  it("checks SSH authority without reading or mutating provider state", async () => {
    const runner = jest.fn().mockResolvedValue({ ok: true, stdout: "ready\n", stderr: "" });
    const context = {
      kind: "managed" as const,
      host: "fixturenode21",
      env: { PROXMOX_NODE: "fixturenode21" },
      provisionerChannel: "default" as const,
      paths: {
        provisionerDirectory: "/root/hivra-provisioner",
        logDirectory: "/root",
        provisionLogPrefix: "hivra-prov-" as const,
        startLogPrefix: "hivra-start-" as const,
        storage: "local-lvm",
        vmSshKeyPath: null,
      },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
      infrastructureBindingTagEnforced: true,
    };

    await expect(checkHivraAgentRecoveryAuthority(context, runner)).resolves.toMatchObject({ ok: true });

    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining("HIVRA_RECOVERY_AUTHORITY_READY"),
      context.env,
      { timeoutMs: 20_000 },
    );
    const script = runner.mock.calls[0][0] as string;
    expect(script).not.toMatch(/\bqm\b|pvesm|vzdump/);
  });

  it("resolves an explicitly managed row on its stored managed target", async () => {
    const resolveManaged = jest.fn(() => ({
      id: "fixturenode21",
      env: { PROXMOX_NODE: "fixturenode21", PROXMOX_STORAGE: "local-zfs" },
    }));
    const resolveSelfManaged = jest.fn();

    const context = await resolveHivraAgentExecutionContext(
      "user_a",
      {
        deployment_mode: "hivra-managed",
        proxmox_host: "fixturenode21",
        infrastructure_binding_token_hash: bindingTokenHash,
        infrastructure_binding_token_enforced: false,
      },
      { resolveManaged, resolveSelfManaged },
    );

    expect(context).toMatchObject({
      kind: "managed",
      host: "fixturenode21",
      provisionerChannel: "default",
      paths: {
        provisionerDirectory: "/root/hivra-provisioner",
        logDirectory: "/root",
        storage: "local-lvm",
        vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
      infrastructureBindingTagEnforced: false,
    });
    expect(resolveManaged).toHaveBeenCalledWith(expect.anything(), "fixturenode21");
    expect(resolveSelfManaged).not.toHaveBeenCalled();
    expect(hivraAgentProvisionLogPath(context, 2100)).toBe("/root/hivra-prov-2100.log");
    expect(hivraAgentStartLogPath(context, 2100)).toBe("/root/hivra-start-2100.log");
    expect(hivraAgentProvisionSecretPath(context, 2100)).toBe(
      "/var/lib/hivra/provision-results/2100.secret",
    );
  });

  it("resolves a Canary row only through its isolated persisted provisioner path", async () => {
    const resolveManaged = jest.fn(() => ({
      id: "fixturenode21",
      env: { PROXMOX_NODE: "fixturenode21" },
    }));

    const context = await resolveHivraAgentExecutionContext(
      "user_a",
      {
        computer_substrate: "proxmox-kvm",
        deployment_mode: "hivra-managed",
        proxmox_host: "fixturenode21",
        managed_provisioner_channel: "canary",
        infrastructure_binding_token_hash: bindingTokenHash,
        infrastructure_binding_token_enforced: true,
      },
      { resolveManaged, resolveSelfManaged: jest.fn() },
    );

    expect(context).toMatchObject({
      kind: "managed",
      provisionerChannel: "canary",
      paths: { provisionerDirectory: "/root/hivra-provisioner-canary" },
    });
    expect(resolveManaged).toHaveBeenCalledTimes(1);
  });

  it.each([
    { managed_provisioner_channel: "staging", computer_substrate: "proxmox-kvm" },
    { managed_provisioner_channel: "canary" },
  ])("fails closed before credentials for an invalid managed channel binding: %j", async (identity) => {
    const dependencies = { resolveManaged: jest.fn(), resolveSelfManaged: jest.fn() };

    await expect(resolveHivraAgentExecutionContext("user_a", {
      ...identity,
      deployment_mode: "hivra-managed",
      proxmox_host: "fixturenode21",
      infrastructure_binding_token_hash: bindingTokenHash,
    }, dependencies)).rejects.toMatchObject({ code: "binding_invalid" });
    expect(dependencies.resolveManaged).not.toHaveBeenCalled();
    expect(dependencies.resolveSelfManaged).not.toHaveBeenCalled();
  });

  it("resolves a fully bound row only through its owner-scoped target revision", async () => {
    const resolveManaged = jest.fn();
    const resolveSelfManaged = jest.fn(async () => portableContext());

    const context = await resolveHivraAgentExecutionContext(
      "user_a",
      {
        deployment_mode: "self-managed",
        proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
        infrastructure_connection_id: connectionId,
        deployment_target_id: targetId,
        infrastructure_connection_revision: 7,
        infrastructure_binding_token_hash: bindingTokenHash,
        infrastructure_binding_token_enforced: true,
      },
      { resolveManaged, resolveSelfManaged },
    );

    expect(resolveSelfManaged).toHaveBeenCalledWith("user_a", {
      connectionId,
      targetId,
      expectedConnectionRevision: 7,
      purpose: "lifecycle",
    });
    expect(resolveManaged).not.toHaveBeenCalled();
    expect(context).toMatchObject({
      kind: "self-managed",
      host: "pve-home",
      paths: {
        provisionerDirectory: "/opt/hivra/provisioner",
        logDirectory: "/var/log/hivra",
        storage: "fast-zfs",
        vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
      },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
      infrastructureBindingTagEnforced: true,
    });
    expect(hivraAgentProvisionLogPath(context, 400)).toBe("/var/log/hivra/provision-400.log");
    expect(hivraAgentStartLogPath(context, 400)).toBe("/var/log/hivra/start-400.log");
  });

  it.each([
    [{ deployment_mode: "self-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, infrastructure_connection_id: connectionId }, "missing target and revision"],
    [{ deployment_mode: "self-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, infrastructure_connection_id: connectionId, deployment_target_id: targetId }, "missing revision"],
    [{ deployment_mode: "self-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, infrastructure_connection_id: connectionId, deployment_target_id: targetId, infrastructure_connection_revision: 0 }, "invalid revision"],
    [{ deployment_mode: "self-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, infrastructure_connection_id: "", deployment_target_id: targetId, infrastructure_connection_revision: 7 }, "empty connection id"],
    [{ proxmox_host: "fixturenode21" }, "missing explicit mode"],
    [{ deployment_mode: "hivra-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL }, "managed sentinel"],
    [{ deployment_mode: "self-managed", proxmox_host: "pve-home", infrastructure_connection_id: connectionId, deployment_target_id: targetId, infrastructure_connection_revision: 7 }, "missing rollback sentinel"],
    [{ deployment_mode: "self-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, infrastructure_connection_id: connectionId, deployment_target_id: targetId, infrastructure_connection_revision: 7, managed_provisioner_channel: "canary" }, "self-managed Canary channel"],
  ])("fails closed for a partial binding: %s (%s)", async (binding, label) => {
    expect(label).toEqual(expect.any(String));
    await expect(
      resolveHivraAgentExecutionContext("user_a", binding, {
        resolveManaged: jest.fn(),
        resolveSelfManaged: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: "binding_invalid" });
  });

  it("requests teardown authority separately from launch readiness", async () => {
    const resolveSelfManaged = jest.fn(async () => portableContext());
    await resolveHivraAgentTeardownExecutionContext(
      "user_a",
      {
        deployment_mode: "self-managed",
        proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
        infrastructure_connection_id: connectionId,
        deployment_target_id: targetId,
        infrastructure_connection_revision: 7,
        infrastructure_binding_token_hash: bindingTokenHash,
        infrastructure_binding_token_enforced: true,
      },
      { resolveManaged: jest.fn(), resolveSelfManaged },
    );
    expect(resolveSelfManaged).toHaveBeenCalledWith("user_a", expect.objectContaining({
      purpose: "teardown",
    }));
  });

  it("turns stale target evidence into a safe conflict response", () => {
    const mapped = describeHivraAgentExecutionContextError(
      new ProxmoxExecutionContextError("connection_stale"),
    );
    expect(mapped).toEqual({
      status: 409,
      message: "This agent's infrastructure connection changed. Check it again before controlling the agent.",
    });
  });
});
