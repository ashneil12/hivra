/**
 * Legacy compatibility for recognizing an existing Operator OS box.
 *
 * Operator OS is an agent FLAVOR: the same Hermes provisioning lane, but the
 * box booted an operatoros-agent image (autonomous-organs runtime) and carries
 * the autonomy SOUL instead of a welcome persona or the who-am-I onboarding
 * ritual. Six code paths need to recognize that flavor — fresh provision
 * (proxmox + hetzner), dashboard-driven updates (instance-orchestrator), the
 * bootstrap SOUL seeder (webui-instance-builder), the soul-seed reconcile, and
 * stored-instance lifecycle paths.
 * Each had grown its own copy of the same `agentFlavor === "operatoros" ||
 * image.includes("operatoros")` test; this module collapses them so the
 * detection can't drift path-to-path (a drift bug is invisible until a box
 * silently reverts to vanilla or boots the wrong identity).
 *
 * Flavor detection is deliberately belt-and-suspenders — the persisted
 * `config.agentFlavor` OR an image string carrying the marker both count. The
 * two are written together at create time, but a hand-repaired or
 * partially-migrated row may carry only one, and both answers should be
 * "Operator OS" rather than a silent vanilla reversion.
 */

/** Value stored as `config.agentFlavor` for an Operator OS box. */
const OPERATOROS_FLAVOR = "operatoros";

/**
 * Substring that marks a container image as the Operator OS runtime. Matching
 * on a substring (not an exact ref) keeps tag/registry overrides working:
 * `HERMES_OPERATOROS_AGENT_IMAGE` may point at any tag, digest, or mirror.
 */
const OPERATOROS_IMAGE_MARKER = "operatoros";

/**
 * Absolute path INSIDE the operatoros-agent image where the autonomy SOUL
 * ships. The image's own s6 cont-init enforcer (docker/cont-init.d/
 * 03-operatoros-soul) installs SOUL.md from this path — but webfree boxes run
 * the gateway with `entrypoint: []`, which bypasses s6 entirely, so that
 * enforcer NEVER fires on the Hivra fleet. The provision-time seeder in
 * webui-instance-builder.ts extracts this file from the image instead, and is
 * the ONLY writer that installs the autonomy identity on a webfree box.
 */
export const OPERATOROS_AUTONOMY_SOUL_IMAGE_PATH =
  "/opt/hermes/profiles/operatoros/SOUL.autonomy.md";

/**
 * Head marker of the autonomy SOUL, used to assert a box actually carries the
 * Operator OS identity (the deployment DoD check). Kept in lockstep with the
 * first line of profiles/operatoros/SOUL.autonomy.md in the agent image repo
 * and with the image's own cont-init enforcer, which greps this same string.
 */
export const OPERATOROS_AUTONOMY_SOUL_HEAD = "Operator OS — Autonomy Build";

/** True when `image` is an Operator OS runtime image. */
export function isOperatorosAgentImage(image: unknown): boolean {
  return typeof image === "string" && image.includes(OPERATOROS_IMAGE_MARKER);
}

/**
 * The stored `config.webuiAgentImage`, when it is a usable non-blank string.
 * Shared so every reader trims and blank-checks identically.
 */
export function readStoredWebuiAgentImage(
  config: Record<string, unknown> | null | undefined,
): string | undefined {
  const stored = config?.webuiAgentImage;
  return typeof stored === "string" && stored.trim() ? stored : undefined;
}

/**
 * True when a stored instance config describes an Operator OS box, via either
 * the persisted flavor or a stored operatoros image.
 */
export function isOperatorosFlavorConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  return (
    config?.agentFlavor === OPERATOROS_FLAVOR ||
    isOperatorosAgentImage(readStoredWebuiAgentImage(config))
  );
}

/**
 * The agent image an UPDATE/redeploy should run for a stored instance config,
 * or undefined to let the builder's env-default resolution win.
 *
 * The stored image is authoritative when present. New Operator OS deployments
 * are disabled until its source and portable build are public. A legacy row
 * that names the flavor without a pinned image therefore fails closed instead
 * of silently pulling an unreviewed default or reverting to vanilla.
 */
export function resolveAgentImageForStoredConfig(
  config: Record<string, unknown> | null | undefined,
): string | undefined {
  const stored = readStoredWebuiAgentImage(config);
  if (stored) return stored;
  if (isOperatorosFlavorConfig(config)) {
    throw new Error("Legacy Operator OS instance is missing its pinned runtime image.");
  }
  return undefined;
}
