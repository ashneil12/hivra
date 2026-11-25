import "server-only";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ManagedGvisorAuthorityConfig = {
  authorityUserId: string;
  connectionId: string;
  targetId: string;
  connectionRevision: number;
};

function switchEnabled(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

export function managedGvisorAuthorityConfig(env: NodeJS.ProcessEnv): ManagedGvisorAuthorityConfig | null {
  const authorityUserId = env.HIVRA_MANAGED_GVISOR_AUTHORITY_USER_ID?.trim() ?? "";
  const connectionId = env.HIVRA_MANAGED_GVISOR_CONNECTION_ID?.trim() ?? "";
  const targetId = env.HIVRA_MANAGED_GVISOR_TARGET_ID?.trim() ?? "";
  const connectionRevision = Number(env.HIVRA_MANAGED_GVISOR_CONNECTION_REVISION);
  if (!authorityUserId || !UUID.test(connectionId) || !UUID.test(targetId)
    || !Number.isSafeInteger(connectionRevision) || connectionRevision < 1) {
    return null;
  }
  return { authorityUserId, connectionId, targetId, connectionRevision };
}

export function managedGvisorLaunchConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchEnabled(env.HIVRA_MANAGED_GVISOR_LAUNCH_ENABLED) && managedGvisorAuthorityConfig(env) !== null;
}
