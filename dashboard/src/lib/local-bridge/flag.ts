type EnvLike = Record<string, string | undefined>;

/**
 * The local bridge (an agent runs an owner-approved command on the owner's own
 * computer) is off unless the server sets HIVRA_LOCAL_BRIDGE_ENABLED=true. Every
 * bridge route answers 404 while it is off.
 */
export function isLocalBridgeEnabled(env: EnvLike = process.env): boolean {
  return env.HIVRA_LOCAL_BRIDGE_ENABLED?.trim().toLowerCase() === "true";
}
