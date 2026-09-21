const PORTABLE_AGENT_LAUNCH_IDS = [
  "claude-code",
  "codex",
  "aeon",
  "openclaw",
  "agent-zero",
] as const;

export type PortableAgentLaunchId = typeof PORTABLE_AGENT_LAUNCH_IDS[number];
export type PortableLaunchResourceId = PortableAgentLaunchId | "linux-desktop" | "linux-terminal" | "windows";

const PORTABLE_AGENT_LAUNCH_ID_SET: ReadonlySet<string> = new Set(
  PORTABLE_AGENT_LAUNCH_IDS,
);

export function isPortableAgentLaunchId(
  value: string | null | undefined,
): value is PortableAgentLaunchId {
  return Boolean(value && PORTABLE_AGENT_LAUNCH_ID_SET.has(value));
}

export function parsePortableLaunchResourceId(
  value: string | null | undefined,
): PortableLaunchResourceId | null {
  if (value === "linux-desktop" || value === "linux-terminal" || value === "windows") return value;
  return isPortableAgentLaunchId(value) ? value : null;
}

export function buildLaunchSetupHref(
  resourceId: PortableLaunchResourceId,
  targetId?: string | null,
  options: { unified?: boolean } = {},
): string {
  const targetQuery = targetId
    ? `&targetId=${encodeURIComponent(targetId)}`
    : "";
  if (options.unified && (resourceId === "codex" || resourceId === "linux-desktop" || resourceId === "linux-terminal" || resourceId === "windows")) {
    const kind = resourceId === "linux-desktop" || resourceId === "linux-terminal" ? "computer" : "agent";
    const profileQuery = resourceId === "windows" ? "&profile=windows" : resourceId === "linux-terminal" ? "&profile=linux-terminal" : "";
    return `/dashboard/launch?kind=${resourceId === "windows" ? "computer" : kind}${profileQuery}${targetQuery}`;
  }
  if (resourceId === "linux-desktop" || resourceId === "linux-terminal") {
    return `/dashboard/computers?launch=1${targetQuery}`;
  }
  return `/dashboard/welcome?step=deploy&agentType=${encodeURIComponent(resourceId)}${targetQuery}`;
}

export function buildInfrastructureSetupHref(
  resourceId: PortableLaunchResourceId,
  options: { unified?: boolean } = {},
): string {
  return `/dashboard/infrastructure?launch=${encodeURIComponent(resourceId)}${options.unified ? "&returnTo=unified-launch" : ""}`;
}
