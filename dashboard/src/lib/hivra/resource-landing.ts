import type { ComputerTemplateId } from "@/lib/hivra/computer-catalog";

/**
 * The one place that decides what a resource opens on.
 *
 * Before this module the decision was made twice and disagreed: the per-agent
 * page computed an `effectiveTab` that landed computers on "desktop", while the
 * workspace hardcoded `surface: "conversation"` in every path that selects an
 * agent. A computer therefore opened on a terminal in the workspace and on its
 * desktop on its own page — the two routes could not both be right, and the
 * workspace's answer was the wrong one for a resource whose whole purpose is the
 * desktop.
 *
 * The fix is not to copy the page's branch into the workspace. It is to move the
 * decision here, so there is one answer and both routes read it.
 *
 * This is presentation-only: it resolves WHICH surface to show and WHICH
 * transport renders it. It never touches a URL, a token, or a lifecycle action.
 */

/** Which desktop component a profile's surface renders through. */
export type DesktopTransport = "remote" | "omarchy" | "windows";

export type ResourceSource = "hermes" | "hivra";

/** The agent-catalog `surface` discriminant, widened so callers need no cast. */
export type ResourceSurfaceKind = "chat" | "dashboard" | "computer" | undefined;

export interface ResourceDescriptor {
  source: ResourceSource;
  /** Raw hivra_agents.type (codex/claude-code/aeon/openclaw/linux-desktop/...). */
  type?: string | null;
  /** Raw hivra_agents.computer_profile, possibly null. */
  computerProfile?: string | null;
  /** Raw lifecycle status. */
  status?: string | null;
  /** HivraAgent.chat_url — the box HTTP endpoint, absent for desktop guests. */
  chatUrl?: string | null;
  /** The catalog definition's `surface` discriminator, when known. */
  surfaceKind?: ResourceSurfaceKind;
  /** The catalog definition's resourceKind, when known. */
  resourceKind?: "agent" | "computer" | undefined;
}

/**
 * A computer profile as the surfaces read it: a known profile, or "unknown" for
 * a stored value Hivra does not recognise. An unknown profile never has a
 * desktop (it fails closed), so it is not guessed to be Ubuntu.
 */
export type NormalizedComputerProfile = ComputerTemplateId | "unknown";

export interface ResourceLanding {
  /** The surface this resource opens on. "workspace" is a running computer with
   * no desktop (a Linux computer): it opens on its files and terminal. */
  landing: "conversation" | "desktop" | "workspace";
  /**
   * True when a conversation exists at all. For a running computer this is
   * false — its conversation was never a real pane, it was a fall-through to a
   * box HTTP endpoint that a desktop guest does not serve.
   */
  conversation: boolean;
  /** True when this resource has a desktop surface. */
  desktop: boolean;
  /** Which component renders the desktop. Null when desktop is false. */
  desktopTransport: DesktopTransport | null;
  /**
   * Whether the desktop should open itself without a user click. Windows routes
   * through a manual "Open fast desktop" affordance it can perform for the user;
   * the others start their stream on mount.
   */
  desktopAutoOpen: boolean;
  /**
   * The normalized profile. Null when this resource is not a computer. A null
   * computer_profile on a linux-desktop row resolves to "ubuntu-desktop" — that
   * was the only computer image before profiles existed, so null is Ubuntu, not
   * a fourth profile. A stored profile Hivra does not know is "unknown".
   */
  profile: NormalizedComputerProfile | null;
}

/** A computer is only a computer when it is actually up. */
function isRunning(status: string | null | undefined): boolean {
  return status === "running";
}

export function normalizeComputerProfile(
  value: string | null | undefined,
): NormalizedComputerProfile {
  // No profile is the original Ubuntu desktop. Any other value must be one
  // Hivra knows; a profile it does not know is never taken for a desktop.
  if (value == null || value === "" || value === "ubuntu-desktop") return "ubuntu-desktop";
  return value === "omarchy" || value === "windows" || value === "ubuntu-server" ? value : "unknown";
}

/** Whether a computer's stored profile has a desktop at all. A Linux computer
 * (ubuntu-server) has none, and neither does a profile Hivra does not know. */
export function computerHasDesktop(value: string | null | undefined): boolean {
  const profile = normalizeComputerProfile(value);
  return profile === "ubuntu-desktop" || profile === "omarchy" || profile === "windows";
}

/** The component a profile's desktop renders through, or null when it has none. */
export function desktopTransportForProfile(
  profile: NormalizedComputerProfile | null,
): DesktopTransport | null {
  if (profile === "omarchy") return "omarchy";
  if (profile === "windows") return "windows";
  if (profile === null || profile === "ubuntu-desktop") return "remote";
  return null;
}

/**
 * Resolve what a resource shows, from the only inputs that may influence it:
 * its source, its kind, its profile, and whether it is running.
 *
 * Every non-computer path returns the conversation landing, so chat agents,
 * dashboard agents, and Hermes instances keep exactly today's behavior.
 */
export function resolveResourceLanding(
  resource: ResourceDescriptor,
): ResourceLanding {
  const isComputer =
    resource.resourceKind === "computer" || resource.surfaceKind === "computer";

  // A stopped, provisioning, or errored computer has no desktop to show — the
  // session cannot be issued. It falls back to the conversation landing so the
  // existing state notice (provisioning/unavailable/recovery) is what renders.
  if (!isComputer || !isRunning(resource.status)) {
    return {
      landing: "conversation",
      conversation: true,
      desktop: false,
      desktopTransport: null,
      desktopAutoOpen: false,
      profile: isComputer ? normalizeComputerProfile(resource.computerProfile) : null,
    };
  }

  const profile = normalizeComputerProfile(resource.computerProfile);
  // A running computer with no desktop opens on its files and terminal. It is
  // never given a desktop, whatever its type says.
  if (!computerHasDesktop(resource.computerProfile)) {
    return {
      landing: "workspace",
      conversation: false,
      desktop: false,
      desktopTransport: null,
      desktopAutoOpen: false,
      profile,
    };
  }
  return {
    landing: "desktop",
    // A running computer has no conversation surface. It used to be handed the
    // box's /terminal/ endpoint, which is why an Ubuntu desktop "opened on a
    // terminal" — the terminal was never its landing, it was the absence of a
    // desktop branch. Shell access belongs in a Terminal *surface*, not here.
    conversation: false,
    desktop: true,
    desktopTransport: desktopTransportForProfile(profile),
    desktopAutoOpen: profile === "windows",
    profile,
  };
}
