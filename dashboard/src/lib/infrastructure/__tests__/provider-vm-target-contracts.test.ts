import {
  DeploymentTargetDtoSchema, ProxmoxDeploymentTargetDtoSchema,
  ProviderVmDeploymentTargetDtoSchema, isProxmoxDeploymentTarget,
} from "../contracts";
import { PORTABLE_HIVRA_RUNTIME_COMPATIBILITY } from "../portable-provisioner-contract";
import { providerVmTarget } from "./provider-vm-target.fixtures";

describe("distinct provider-VM target contract", () => {
  it("retains the real provider identity without inventing a Proxmox node, bridge or VMID", () => {
    const target = providerVmTarget();
    expect(DeploymentTargetDtoSchema.parse(target)).toEqual(target);
    expect(ProviderVmDeploymentTargetDtoSchema.parse(target)).toEqual(target);
    expect(ProxmoxDeploymentTargetDtoSchema.safeParse(target).success).toBe(false);
    expect(isProxmoxDeploymentTarget(target)).toBe(false);
    for (const field of ["vmidRange", "selectedBridge", "selectedStorage", "template", "kvmAvailable"]) {
      expect(target.capabilities).not.toHaveProperty(field);
    }
  });
  it("distinguishes a prepared installer bundle from agent launch authority", () => {
    const target = providerVmTarget();
    target.capabilities.provisioner.ready = true;
    expect(DeploymentTargetDtoSchema.parse(target)).toEqual(target);
    expect(target.capabilities.launchReady).toBe(false);
    expect(target.capabilities.runtimeCompatibility).toBeNull();
  });
  it.each(["status", "launch", "runtimes", "no_error"])("rejects premature %s readiness", change => {
    const target = providerVmTarget();
    if (change === "status") target.status = "ready";
    if (change === "launch") target.capabilities.launchReady = true;
    if (change === "runtimes") target.capabilities.runtimeCompatibility = PORTABLE_HIVRA_RUNTIME_COMPATIBILITY;
    if (change === "no_error") target.lastErrorCode = null;
    expect(DeploymentTargetDtoSchema.safeParse(target).success).toBe(false);
  });
  it("admits only coherent ready evidence for the exact reviewed provider guest bundle", () => {
    const target = providerVmTarget();
    target.status = "ready"; target.lastErrorCode = null;
    target.capabilities.launchReady = true; target.capabilities.provisioner.ready = true;
    expect(ProviderVmDeploymentTargetDtoSchema.parse(target)).toEqual(target);
    for (const version of ["2026.08.27.1", "2026.08.29.6", "custom"]) {
      expect(ProviderVmDeploymentTargetDtoSchema.safeParse({ ...target,
        capabilities: { ...target.capabilities, provisioner: { ...target.capabilities.provisioner, version } } }).success).toBe(false);
    }
    target.capacity.memoryBytes.available = null;
    expect(ProviderVmDeploymentTargetDtoSchema.safeParse(target).success).toBe(false);
  });
  it.each(["0", "-1", "01", "9007199254740992", "42\n", "pve-01"])("rejects invalid provider identity %s", externalId => {
    expect(DeploymentTargetDtoSchema.safeParse({ ...providerVmTarget(), externalId }).success).toBe(false);
  });
  it.each(["proxmox", "shared", "driver", "class", "duplicate", "secret", "nested", "order"])("rejects %s mixed or unscoped evidence", change => {
    const target = providerVmTarget();
    const value: Record<string, unknown> = target;
    if (change === "proxmox") value.capabilities = { ...target.capabilities, provider: "proxmox" };
    if (change === "shared") value.capabilities = { ...target.capabilities, allocation: "shared-pool" };
    if (change === "driver") value.supportedIsolationDrivers = ["proxmox-kvm"];
    if (change === "class") value.isolationClass = "hardware-vm";
    if (change === "duplicate") value.supportedIsolationDrivers = ["provider-vm", "provider-vm"];
    if (change === "secret") value.capabilities = { ...target.capabilities, administratorPrivateKey: "private" };
    if (change === "nested") value.capabilities = { ...target.capabilities, vmidRange: { start: 200, end: 399 } };
    if (change === "order") value.capabilities = { ...target.capabilities, capacityOrderId: undefined };
    expect(DeploymentTargetDtoSchema.safeParse(value).success).toBe(false);
  });
  it("allows absent isolation proof only with no advertised driver", () => {
    const target = providerVmTarget();
    target.isolationClass = null;
    expect(DeploymentTargetDtoSchema.safeParse(target).success).toBe(false);
    target.supportedIsolationDrivers = [];
    expect(DeploymentTargetDtoSchema.safeParse(target).success).toBe(true);
    target.isolationClass = "provider-vm";
    expect(DeploymentTargetDtoSchema.safeParse(target).success).toBe(false);
  });
});
