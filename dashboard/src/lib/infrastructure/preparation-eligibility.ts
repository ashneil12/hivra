import {
  isProxmoxDeploymentTarget,
  type DeploymentTargetDto,
  type InfrastructureConnectionDto,
  type ProxmoxPreflightErrorCode,
  type ProxmoxPreflightResult,
} from "./contracts";

// The current Simple preparation action installs Hivra's versioned host tools,
// required image assets, and its owned network. It cannot add capacity, repair
// KVM/Proxmox, create storage, or free a VMID. Keep this list narrower than the
// server's general preflight vocabulary so the UI never offers mutation for a
// problem that preparation cannot solve.
const PREPARATION_REMEDIABLE_CODES = new Set<ProxmoxPreflightErrorCode>([
  "BRIDGE_UNAVAILABLE",
  "PROVISIONER_UNAVAILABLE",
]);

function onlyPreparationRemediable(
  requirements: ReadonlyArray<{ code: ProxmoxPreflightErrorCode }>,
): boolean {
  return requirements.length > 0
    && requirements.every((requirement) => PREPARATION_REMEDIABLE_CODES.has(requirement.code));
}

export function canPrepareFromPreflight(
  connection: InfrastructureConnectionDto,
  result: ProxmoxPreflightResult,
): boolean {
  if (connection.setupMode !== "simple") return false;
  if (result.ok && result.target.launchReady) return false;
  return onlyPreparationRemediable(result.unmetRequirements);
}

export function canPrepareFromSavedTarget(
  connection: InfrastructureConnectionDto,
  target: DeploymentTargetDto | undefined,
): boolean {
  if (
    !target
    || !isProxmoxDeploymentTarget(target)
    || connection.setupMode !== "simple"
    || connection.status === "pending"
    || connection.status === "checking"
    || connection.status === "disabled"
    || target.capabilities.launchReady
    || !target.supportedIsolationDrivers.includes("proxmox-kvm")
  ) {
    return false;
  }
  return onlyPreparationRemediable(target.capabilities.issues);
}
