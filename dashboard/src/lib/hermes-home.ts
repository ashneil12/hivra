import { getRuntimeAgentSettings } from "@/lib/instance-settings";

const ROOT_HERMES_HOME = "/root/.hermes";
const NON_ROOT_HERMES_HOME = "/opt/data";

export function resolveHermesHomeDir(enableRootAccess?: boolean): string {
  return enableRootAccess ? ROOT_HERMES_HOME : NON_ROOT_HERMES_HOME;
}

function resolveHermesExecUser(enableRootAccess?: boolean): "root" | "hermes" {
  return enableRootAccess ? "root" : "hermes";
}

export function resolveHermesHomeDirFromConfig(
  config: Record<string, unknown> | undefined
): string {
  const runtime = getRuntimeAgentSettings(config);
  return resolveHermesHomeDir(runtime.enableRootAccess);
}

export function resolveHermesExecUserFromConfig(
  config: Record<string, unknown> | undefined
): "root" | "hermes" {
  const runtime = getRuntimeAgentSettings(config);
  return resolveHermesExecUser(runtime.enableRootAccess);
}

export function resolveTerminalExecUser(enableRootAccess?: boolean): "root" | "hermes" {
  return resolveHermesExecUser(enableRootAccess);
}

export function resolveTerminalCwd(params: {
  enableRootAccess?: boolean;
  mountPersistentSource?: boolean;
  mode?: "shell" | "tui";
}): string {
  const hermesHomeDir = resolveHermesHomeDir(params.enableRootAccess);
  const runtimeCwd = params.enableRootAccess ? "/opt/hermes" : hermesHomeDir;

  if (params.mode === "tui") {
    return runtimeCwd;
  }

  if (params.mountPersistentSource) {
    return `${hermesHomeDir}/hermes-agent`;
  }

  return runtimeCwd;
}
