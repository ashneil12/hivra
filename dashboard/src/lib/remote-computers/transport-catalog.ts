// Remote-computer transport contracts.
//
// A desktop transport is deliberately separate from a computer image and an
// agent runtime. Selection is based on capabilities Hivra has actually observed
// on the guest and client; an attractive catalog entry is never launch proof.

export type RemoteDesktopTransportId =
  | "sunshine-moonlight"
  | "selkies-webrtc"
  | "selkies-websocket"
  | "guacamole-rdp"
  | "recovery-console";

type GuestCompositor = "x11" | "wayland" | "windows";
type DesktopClientKind = "browser" | "native";
export type DesktopAccessPurpose = "daily-driver" | "recovery";
export type RemoteDesktopComputerKind = "hermes-instance" | "hivra-agent";

export interface RemoteDesktopTransportDefinition {
  id: RemoteDesktopTransportId;
  name: string;
  purpose: DesktopAccessPurpose;
  clientKinds: readonly DesktopClientKind[];
  supportedCompositors: readonly GuestCompositor[];
  upstream: {
    repository: string;
    release: string;
    commit: string;
    license: "Apache-2.0" | "GPL-3.0" | "MPL-2.0" | "internal-baseline";
  };
  media: {
    requiresUdp: boolean;
    browserWebCodecs: boolean;
    supportsHardwareEncoding: boolean;
  };
  note: string;
}

export const REMOTE_DESKTOP_TRANSPORTS: readonly RemoteDesktopTransportDefinition[] = [
  {
    id: "sunshine-moonlight",
    name: "Sunshine + Moonlight",
    purpose: "daily-driver",
    clientKinds: ["native"],
    supportedCompositors: ["x11", "wayland", "windows"],
    upstream: {
      repository: "https://github.com/LizardByte/Sunshine",
      release: "v2026.516.143833",
      commit: "14ffa6fdaa53f7b51512be2b3d24f3939695403c",
      license: "GPL-3.0",
    },
    media: {
      requiresUdp: true,
      browserWebCodecs: false,
      supportsHardwareEncoding: true,
    },
    note: "Native performance lane. Omarchy ships an official Sunshine installer, but Hivra still requires measured pairing, revocation, reconnect, and teardown acceptance.",
  },
  {
    id: "selkies-webrtc",
    name: "Selkies WebRTC",
    purpose: "daily-driver",
    clientKinds: ["browser"],
    supportedCompositors: ["x11"],
    upstream: {
      repository: "https://github.com/selkies-project/selkies",
      release: "v1.6.2",
      commit: "7a80d7eea94f7ff5e754407a18364f4008d8b0fd",
      license: "MPL-2.0",
    },
    media: {
      requiresUdp: true,
      browserWebCodecs: true,
      supportsHardwareEncoding: true,
    },
    note: "Zero-install browser lane. Current upstream capture support is X11; it is not admitted for an Omarchy Hyprland/Wayland session without separate capture proof.",
  },
  {
    id: "selkies-websocket",
    name: "Selkies WebSocket",
    purpose: "daily-driver",
    clientKinds: ["browser"],
    supportedCompositors: ["x11", "wayland"],
    upstream: {
      repository: "https://github.com/selkies-project/selkies",
      release: "main-2026-08-17",
      commit: "a1c5d9a8b2b0da0f354228cd0d451034e94b50db",
      license: "MPL-2.0",
    },
    media: {
      requiresUdp: false,
      browserWebCodecs: true,
      supportsHardwareEncoding: true,
    },
    note: "TCP-compatible browser lane for X11 guests and capability-verified wlroots host capture. It must be measured separately and must not be presented as WebRTC performance.",
  },
  {
    id: "guacamole-rdp",
    name: "Apache Guacamole + RDP",
    purpose: "daily-driver",
    clientKinds: ["browser"],
    supportedCompositors: ["windows"],
    upstream: {
      repository: "https://github.com/apache/guacamole-server",
      release: "1.6.0",
      commit: "1f664e08feae6e7d15d8146b78acab2e6fb470ae",
      license: "Apache-2.0",
    },
    media: {
      requiresUdp: false,
      browserWebCodecs: false,
      supportsHardwareEncoding: false,
    },
    note: "Windows browser compatibility lane. Catalog presence is not enablement: Hivra must separately verify the Guacamole client/server bundle, RDP graphics, input, audio, clipboard, files, reconnect, revocation, and teardown.",
  },
  {
    id: "recovery-console",
    name: "Hivra recovery console",
    purpose: "recovery",
    clientKinds: ["browser"],
    supportedCompositors: ["x11", "wayland", "windows"],
    upstream: {
      repository: "internal://hivra/recovery-console",
      release: "current",
      commit: "current",
      license: "internal-baseline",
    },
    media: {
      requiresUdp: false,
      browserWebCodecs: false,
      supportsHardwareEncoding: false,
    },
    note: "Repair and baseline access only. Console reachability is not evidence that a computer is responsive enough for daily work.",
  },
] as const;

export interface RemoteDesktopHostCapabilities {
  compositor: GuestCompositor;
  installedTransports: readonly RemoteDesktopTransportId[];
  /**
   * Transports accepted by a current Hivra capability inspection for this
   * exact computer revision. Installation alone is deliberately insufficient.
   */
  verifiedTransports: readonly RemoteDesktopTransportId[];
  privateNetworkReachable: boolean;
}

export interface RemoteDesktopClientCapabilities {
  kind: DesktopClientKind;
  moonlight: boolean;
  webCodecs: boolean;
  udp: "direct" | "relay" | "blocked";
}

export interface RemoteDesktopSelectionRequest {
  purpose: DesktopAccessPurpose;
  host: RemoteDesktopHostCapabilities;
  client: RemoteDesktopClientCapabilities;
}

type RemoteDesktopSelectionIssueCode =
  | "NOT_INSTALLED"
  | "NOT_VERIFIED"
  | "CLIENT_KIND_UNSUPPORTED"
  | "COMPOSITOR_UNSUPPORTED"
  | "MOONLIGHT_UNAVAILABLE"
  | "WEBCODECS_UNAVAILABLE"
  | "UDP_UNAVAILABLE"
  | "PRIVATE_NETWORK_UNAVAILABLE"
  | "RECOVERY_ONLY"
  | "PURPOSE_MISMATCH";

interface RemoteDesktopSelectionIssue {
  transportId: RemoteDesktopTransportId;
  code: RemoteDesktopSelectionIssueCode;
  message: string;
}

export interface RemoteDesktopSelectionResult {
  selected: RemoteDesktopTransportDefinition | null;
  rejected: RemoteDesktopSelectionIssue[];
}

const PREFERENCE_ORDER: readonly RemoteDesktopTransportId[] = [
  "sunshine-moonlight",
  "selkies-webrtc",
  "selkies-websocket",
  "guacamole-rdp",
  "recovery-console",
];

function getRemoteDesktopTransport(
  id: RemoteDesktopTransportId,
): RemoteDesktopTransportDefinition {
  const transport = REMOTE_DESKTOP_TRANSPORTS.find((candidate) => candidate.id === id);
  if (!transport) {
    throw new Error(`Unknown remote desktop transport: ${id}`);
  }
  return transport;
}

function assessTransport(
  transport: RemoteDesktopTransportDefinition,
  request: RemoteDesktopSelectionRequest,
): RemoteDesktopSelectionIssue[] {
  const issues: RemoteDesktopSelectionIssue[] = [];
  const issue = (code: RemoteDesktopSelectionIssueCode, message: string) => {
    issues.push({ transportId: transport.id, code, message });
  };

  const installed = request.host.installedTransports.includes(transport.id);
  if (!installed) {
    issue("NOT_INSTALLED", `${transport.name} has not been observed on this computer.`);
  } else if (!request.host.verifiedTransports.includes(transport.id)) {
    issue(
      "NOT_VERIFIED",
      `${transport.name} is installed but has no accepted capability evidence for this computer revision.`,
    );
  }
  if (!transport.clientKinds.includes(request.client.kind)) {
    issue("CLIENT_KIND_UNSUPPORTED", `${transport.name} does not support this client type.`);
  }
  if (!transport.supportedCompositors.includes(request.host.compositor)) {
    issue(
      "COMPOSITOR_UNSUPPORTED",
      `${transport.name} has no accepted ${request.host.compositor} capture path.`,
    );
  }
  if (transport.id === "sunshine-moonlight" && !request.client.moonlight) {
    issue("MOONLIGHT_UNAVAILABLE", "The Moonlight native client is not available.");
  }
  if (transport.media.browserWebCodecs && !request.client.webCodecs) {
    issue("WEBCODECS_UNAVAILABLE", "The browser does not expose the required WebCodecs surface.");
  }
  if (transport.media.requiresUdp && request.client.udp === "blocked") {
    issue("UDP_UNAVAILABLE", `${transport.name} needs an accepted direct or relayed UDP path.`);
  }
  if (transport.id === "sunshine-moonlight" && !request.host.privateNetworkReachable) {
    issue(
      "PRIVATE_NETWORK_UNAVAILABLE",
      "Sunshine is not exposed publicly; an approved private path to the computer is required.",
    );
  }
  if (request.purpose === "daily-driver" && transport.purpose === "recovery") {
    issue("RECOVERY_ONLY", "The recovery console is not a daily-driver desktop lane.");
  } else if (request.purpose === "recovery" && transport.purpose !== "recovery") {
    issue("PURPOSE_MISMATCH", `${transport.name} is a daily-driver lane, not a recovery console.`);
  }

  return issues;
}

/**
 * Choose the fastest compatible transport from accepted capabilities. The
 * caller must still issue a scoped access grant; this function never creates
 * authority or treats an installed binary as a verified, reachable session.
 */
export function selectRemoteDesktopTransport(
  request: RemoteDesktopSelectionRequest,
): RemoteDesktopSelectionResult {
  const rejected: RemoteDesktopSelectionIssue[] = [];

  for (const id of PREFERENCE_ORDER) {
    const transport = getRemoteDesktopTransport(id);
    const issues = assessTransport(transport, request);
    if (issues.length === 0) {
      return { selected: transport, rejected };
    }
    rejected.push(...issues);
  }

  return { selected: null, rejected };
}

export interface RemoteDesktopAccessGrant {
  computerKind: RemoteDesktopComputerKind;
  computerId: string;
  userId: string;
  audience: string;
  surface: "desktop";
  inputRole: "controller" | "viewer";
  issuedAtMs: number;
  expiresAtMs: number;
  handoff: "cookie" | "message" | "url";
  activeControllerCount: number;
  relayCredentialExpiresAtMs?: number | null;
}

export function remoteDesktopAudience(
  computerKind: RemoteDesktopComputerKind,
  computerId: string,
): string {
  return `hivra-computer:${computerKind}:${computerId}:desktop`;
}

type RemoteDesktopGrantIssueCode =
  | "AUDIENCE_MISMATCH"
  | "INVALID_TTL"
  | "URL_SECRET_FORBIDDEN"
  | "CONTROLLER_CONFLICT"
  | "RELAY_CREDENTIAL_OUTLIVES_GRANT";

export interface RemoteDesktopGrantIssue {
  code: RemoteDesktopGrantIssueCode;
  message: string;
}

export function assessRemoteDesktopAccessGrant(
  grant: RemoteDesktopAccessGrant,
): { accepted: boolean; issues: RemoteDesktopGrantIssue[] } {
  const issues: RemoteDesktopGrantIssue[] = [];
  const expectedAudience = remoteDesktopAudience(grant.computerKind, grant.computerId);
  const ttlMs = grant.expiresAtMs - grant.issuedAtMs;

  if (grant.audience !== expectedAudience) {
    issues.push({ code: "AUDIENCE_MISMATCH", message: "The grant is not scoped to this computer desktop." });
  }
  if (ttlMs <= 0 || ttlMs > 5 * 60 * 1000) {
    issues.push({ code: "INVALID_TTL", message: "Desktop grants must be positive and expire within five minutes." });
  }
  if (grant.handoff === "url") {
    issues.push({ code: "URL_SECRET_FORBIDDEN", message: "Desktop credentials must not be handed off in a URL." });
  }
  if (grant.inputRole === "controller" && grant.activeControllerCount > 0) {
    issues.push({ code: "CONTROLLER_CONFLICT", message: "Only one input controller may be active." });
  }
  if (
    grant.relayCredentialExpiresAtMs != null
    && grant.relayCredentialExpiresAtMs > grant.expiresAtMs
  ) {
    issues.push({
      code: "RELAY_CREDENTIAL_OUTLIVES_GRANT",
      message: "Relay credentials must not outlive the desktop grant.",
    });
  }

  return { accepted: issues.length === 0, issues };
}
