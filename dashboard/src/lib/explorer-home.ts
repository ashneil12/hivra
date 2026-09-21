const EXPLORER_INSTANCE_ROOT = "/opt/hermes/instances";
const SAFE_INSTANCE_ID = /^[A-Za-z0-9_-]+$/;

export const DEFAULT_EXPLORER_HOME = EXPLORER_INSTANCE_ROOT;
export const DEFAULT_EXPLORER_ROOT = "/opt";
export const ROOT_ACCESS_EXPLORER_ROOT = "/";

export function resolveExplorerHome(instanceId?: string): string {
  if (!instanceId || !SAFE_INSTANCE_ID.test(instanceId)) {
    return DEFAULT_EXPLORER_HOME;
  }

  return `${EXPLORER_INSTANCE_ROOT}/${instanceId}`;
}

export function resolveExplorerRoot(enableRootAccess?: boolean): string {
  return enableRootAccess ? ROOT_ACCESS_EXPLORER_ROOT : DEFAULT_EXPLORER_ROOT;
}
