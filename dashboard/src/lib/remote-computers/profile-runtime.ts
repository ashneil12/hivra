import type { ComputerTemplateId } from "@/lib/hivra/computer-catalog";

type RemoteDesktopProfileRuntime = {
  profile: ComputerTemplateId;
  compositor: "x11" | "wayland" | "windows";
  transport: "selkies-websocket" | "sunshine-moonlight" | "guacamole-rdp";
  preparation: "selkies-guest-installer" | "not-admitted";
};

export type RemoteDesktopProfileResolution =
  | { ok: true; runtime: RemoteDesktopProfileRuntime }
  | {
      ok: false;
      code: "unsupported_computer" | "computer_profile_not_ready";
      profile: ComputerTemplateId | null;
      message: string;
    };

export type RemoteDesktopInspectionResolution = RemoteDesktopProfileResolution;

type ComputerProfileRow = {
  type?: unknown;
  computer_profile?: unknown;
};

const PROFILE_IDS = new Set<ComputerTemplateId>(["ubuntu-desktop", "omarchy", "windows"]);

/**
 * Resolve the desktop stack for an existing computer without granting launch
 * authority. A null profile on an older linux-desktop row is Ubuntu because
 * that was the only computer image before profiles were introduced.
 */
export function resolveRemoteDesktopProfileRuntime(
  computer: ComputerProfileRow,
): RemoteDesktopProfileResolution {
  if (computer.type !== "linux-desktop") {
    return {
      ok: false,
      code: "unsupported_computer",
      profile: null,
      message: "Desktop preparation is only available for computer resources.",
    };
  }

  const rawProfile = computer.computer_profile == null
    ? "ubuntu-desktop"
    : computer.computer_profile;
  if (typeof rawProfile !== "string" || !PROFILE_IDS.has(rawProfile as ComputerTemplateId)) {
    return {
      ok: false,
      code: "unsupported_computer",
      profile: null,
      message: "This computer has an unsupported operating-system profile.",
    };
  }

  const profile = rawProfile as ComputerTemplateId;
  if (profile === "ubuntu-desktop") {
    return {
      ok: true,
      runtime: {
        profile,
        compositor: "x11",
        transport: "selkies-websocket",
        preparation: "selkies-guest-installer",
      },
    };
  }
  if (profile === "omarchy") {
    return {
      ok: true,
      runtime: {
        profile,
        compositor: "wayland",
        transport: "selkies-websocket",
        preparation: "not-admitted",
      },
    };
  }
  return {
    ok: false,
    code: "computer_profile_not_ready",
    profile,
    message: "Windows desktop access is waiting for its licensed image and RDP gateway.",
  };
}

/**
 * Resolve a read-only capability inspection without granting installation or
 * launch authority. Omarchy and Windows may publish fail-closed prepared
 * descriptors from already-created private lab computers; their public launch
 * profiles remain unavailable until their separate media and gateway acceptance
 * gates exist.
 */
export function resolveRemoteDesktopInspectionRuntime(
  computer: ComputerProfileRow,
): RemoteDesktopInspectionResolution {
  const admitted = resolveRemoteDesktopProfileRuntime(computer);
  if (admitted.ok || admitted.profile !== "windows") return admitted;
  if (admitted.profile === "windows") {
    return {
      ok: true,
      runtime: {
        profile: "windows",
        compositor: "windows",
        transport: "guacamole-rdp",
        preparation: "not-admitted",
      },
    };
  }
  return admitted;
}
