import { z } from "zod";

import {
  PortableHivraRuntimeCompatibilitySchema,
  isProxmoxDeploymentTarget,
  type DeploymentTargetDto,
} from "@/lib/infrastructure/contracts";
import { isCompatibleProxmoxProvisionerVersion, providerProvisionerSupportsCatalogRuntime,
  portableProvisionerSupportsCatalogRuntime,
  provisionerSupportsWindowsInstaller,
  supportsModelSettingsProvisionerVersion } from "@/lib/infrastructure/portable-provisioner-contract";
import { ProviderVmDeploymentTargetDtoSchema } from "@/lib/infrastructure/contracts";
import { HIVRA_GVISOR_ADAPTER_VERSION } from "@/lib/hivra/gvisor-computer-contract";

/**
 * Explicit placement selected by the user during agent launch.
 *
 * Every launch must make this choice explicitly. A self-managed launch must
 * name both the durable connection and the exact deployment target discovered
 * by preflight; neither mode nor provider authority may be inferred from an
 * omitted field or a Proxmox node name.
 */
export const AgentDeploymentDestinationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("hivra-managed"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("self-managed"),
      connectionId: z.string().uuid(),
      targetId: z.string().uuid(),
      expectedConnectionRevision: z.number().int().positive(),
    })
    .strict(),
]);

export type AgentDeploymentDestination = z.infer<
  typeof AgentDeploymentDestinationSchema
>;

export const DEFAULT_AGENT_DEPLOYMENT_DESTINATION: AgentDeploymentDestination = {
  mode: "hivra-managed",
};

export function parseAgentDeploymentDestination(
  input: unknown,
): AgentDeploymentDestination | null {
  const parsed = AgentDeploymentDestinationSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Runtime compatibility is launch authority, not advisory UI metadata. The
 * evidence must be structurally valid, describe the exact observed
 * provisioner version, and name the selected catalog runtime.
 */
export function targetSupportsCatalogRuntime(
  target: DeploymentTargetDto | null | undefined,
  catalogRuntimeId: string | null | undefined,
): boolean {
  if (catalogRuntimeId === "windows-installer") return targetSupportsWindowsInstaller(target);
  if (!target || !catalogRuntimeId) return false;
  const gvisor = target.capabilities as unknown as { kind?: string; launchReady?: boolean; adapter?: { version?: string };
    runtimeCompatibility?: { contractVersion?: number; supportedWorkloadKinds?: string[] } };
  if (gvisor.kind === "gvisor") {
    return target.status === "ready" && gvisor.launchReady === true && gvisor.adapter?.version === HIVRA_GVISOR_ADAPTER_VERSION
      && gvisor.runtimeCompatibility?.contractVersion === 1
      && gvisor.runtimeCompatibility.supportedWorkloadKinds?.includes(catalogRuntimeId) === true;
  }
  if (!isProxmoxDeploymentTarget(target)) {
    const provider = ProviderVmDeploymentTargetDtoSchema.safeParse(target);
    return provider.success && provider.data.status === "ready" && provider.data.capabilities.launchReady
      && providerProvisionerSupportsCatalogRuntime(provider.data.capabilities.provisioner.version, catalogRuntimeId);
  }
  const parsed = PortableHivraRuntimeCompatibilitySchema.safeParse(
    target.capabilities?.runtimeCompatibility,
  );
  if (!parsed.success) return false;
  if (
    !isCompatibleProxmoxProvisionerVersion(parsed.data.provisionerVersion) ||
    !portableProvisionerSupportsCatalogRuntime(parsed.data.provisionerVersion, catalogRuntimeId) ||
    !target.capabilities.provisioner?.ready ||
    target.capabilities.provisioner.version !== parsed.data.provisionerVersion
  ) {
    return false;
  }
  return parsed.data.supportedCatalogRuntimeIds.some(
    (runtimeId) => runtimeId === catalogRuntimeId,
  );
}

export function targetSupportsWindowsInstaller(target: DeploymentTargetDto | null | undefined): boolean {
  if (!target || !isProxmoxDeploymentTarget(target)) return false;
  const parsed = PortableHivraRuntimeCompatibilitySchema.safeParse(target.capabilities?.runtimeCompatibility);
  return parsed.success
    && target.status === "ready"
    && target.capabilities.provisioner?.ready === true
    && target.capabilities.provisioner.version === parsed.data.provisionerVersion
    && provisionerSupportsWindowsInstaller(parsed.data.provisionerVersion)
    && parsed.data.supportedHostCapabilities?.includes("windows-installer") === true;
}

/** This is the current guest adapter boundary, not a catalog priority. Native
 * interfaces for other runtimes remain available on their compatible hosts. */
export function targetSupportsLaunchModelSettings(
  target: DeploymentTargetDto | null | undefined,
  catalogRuntimeId: string | null | undefined,
): boolean {
  if (catalogRuntimeId !== "codex" || !targetSupportsCatalogRuntime(target, catalogRuntimeId)) return false;
  if (!target) return false;
  // A provider-vm target carries its provisioner version under the same
  // `capabilities.provisioner` shape, but its compatibility list is the
  // provider-vm one — the Proxmox model-settings list is not evidence for that
  // substrate. Narrowing on `isProxmoxDeploymentTarget` and returning false
  // would reject every provider-vm launch outright, so branch instead.
  if (!isProxmoxDeploymentTarget(target)) {
    const provider = ProviderVmDeploymentTargetDtoSchema.safeParse(target);
    if (!provider.success) return false;
    const version = provider.data.capabilities.provisioner.version;
    // Both gates matter: the bundle must support the catalog runtime AND carry
    // the reviewed model-settings release. A native-compatible bundle that
    // predates model settings must still be refused here — the caller relies on
    // this rejection to avoid loading credentials into a runtime that cannot
    // hold them.
    return providerProvisionerSupportsCatalogRuntime(version, catalogRuntimeId)
      && supportsModelSettingsProvisionerVersion(version);
  }
  return supportsModelSettingsProvisionerVersion(target.capabilities.provisioner?.version);
}
