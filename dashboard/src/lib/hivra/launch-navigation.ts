import {
  PROFILE_DETAILS,
  type LaunchAgentProfileId,
  type LaunchProfileId,
  type LaunchResourceKind,
} from "@/lib/launch/contracts";

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

/** Launch is the one front door for starting an agent or a computer. */
export const LAUNCH_ROUTE = "/dashboard/launch";

export type LaunchHrefOptions = {
  /** Which section Choose lists first. A profile implies its own. */
  kind?: LaunchResourceKind | null;
  /** A new launch. An unfinished draft is offered to continue, never
   * silently replaced. Without it the saved draft is picked up again. */
  start?: boolean;
  /** Opens this profile's plan straight away. */
  profile?: LaunchProfileId | null;
  /** A saved template to start from, by id. */
  template?: string | null;
  /** The share token that lets a non-owner read a shared template. */
  templateToken?: string | null;
  /** Ready servers to select (a handoff from Capacity). */
  targetIds?: readonly string[];
};

export function buildLaunchHref(options: LaunchHrefOptions = {}): string {
  const query = new URLSearchParams();
  const kind = options.profile ? PROFILE_DETAILS[options.profile].resourceKind : options.kind;
  if (kind) query.set("kind", kind);
  if (options.start) query.set("start", "1");
  if (options.profile) query.set("profile", options.profile);
  if (options.template) query.set("template", options.template);
  if (options.templateToken) query.set("templateToken", options.templateToken);
  for (const targetId of options.targetIds ?? []) query.append("targetId", targetId);
  const search = query.toString();
  return search ? `${LAUNCH_ROUTE}?${search}` : LAUNCH_ROUTE;
}

/** The Launch profile for an agent named by the older first-run links
 * (`agentType=`), where the general-purpose agent was called "general". */
const AGENT_TYPE_PROFILES: Readonly<Record<string, LaunchAgentProfileId>> = {
  general: "hermes",
  hermes: "hermes",
  "claude-code": "claude-code",
  codex: "codex",
  aeon: "aeon",
  openclaw: "openclaw",
  "agent-zero": "agent-zero",
};

export function launchProfileForAgentType(value: string | null | undefined): LaunchAgentProfileId | null {
  return value && Object.hasOwn(AGENT_TYPE_PROFILES, value) ? AGENT_TYPE_PROFILES[value] : null;
}

/** A new launch of the agent a link named, or of anything when it named
 * none (or one Launch doesn't know). */
export function buildAgentLaunchHref(agentType?: string | null): string {
  const profile = launchProfileForAgentType(agentType);
  return profile ? buildLaunchHref({ start: true, profile }) : buildLaunchHref({ kind: "agent", start: true });
}

const PORTABLE_LAUNCH_PROFILES: Readonly<Record<PortableLaunchResourceId, LaunchProfileId>> = {
  "claude-code": "claude-code",
  codex: "codex",
  aeon: "aeon",
  openclaw: "openclaw",
  "agent-zero": "agent-zero",
  "linux-desktop": "ubuntu-desktop",
  "linux-terminal": "linux-terminal",
  windows: "windows",
};

/** Launch, for a runtime whose capacity is ready. `unified` means Capacity
 * was opened from a launch in progress: that launch continues. Otherwise it
 * is a new launch, and an unfinished one is offered first. */
export function buildLaunchSetupHref(
  resourceId: PortableLaunchResourceId,
  targetId?: string | null,
  options: { unified?: boolean } = {},
): string {
  return buildLaunchHref({
    start: !options.unified,
    profile: PORTABLE_LAUNCH_PROFILES[resourceId],
    targetIds: targetId ? [targetId] : [],
  });
}

export function buildInfrastructureSetupHref(
  resourceId: PortableLaunchResourceId,
  options: { unified?: boolean } = {},
): string {
  return `/dashboard/infrastructure?launch=${encodeURIComponent(resourceId)}${options.unified ? "&returnTo=unified-launch" : ""}`;
}
