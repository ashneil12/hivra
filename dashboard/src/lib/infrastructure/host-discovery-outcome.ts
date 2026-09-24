import type {
  HostDiscoveryEngine,
  HostDiscoverySnapshot,
  HostEngineRequirement,
} from "./host-discovery-contracts";

// One inspection, one outcome: a sentence that says what Hivra found and one
// action that moves the owner forward. The outcome comes from the unmet
// requirements discovery measured for the path this server can take (Proxmox
// when Proxmox is installed, otherwise Linux Sandbox on gVisor). Blockers are
// ordered privilege first, then operating system and processor, then
// virtualization, so a missing root login is never reported as missing
// nested KVM. Raw measurements belong under Technical details.

export type HostDiscoveryPath = "proxmox" | "gvisor";

export type HostDiscoveryAction =
  /** Run the read-only strict Proxmox check. */
  | "check-proxmox"
  /** Open the review dialog that installs Linux Sandbox. Changes the host. */
  | "review-gvisor-setup"
  /** Run the read-only strict check of an installed Linux Sandbox setup. */
  | "check-gvisor"
  /** Change the connection's SSH user. */
  | "connect-as-root"
  /** Inspect again after fixing the server. */
  | "check-again";

export type HostDiscoveryBlocker =
  | "privilege"
  | "operating-system"
  | "architecture"
  | "package-manager"
  | "proxmox-version"
  | "cgroup"
  | "virtualization"
  | "unknown";

export type HostDiscoveryOutcome = {
  path: HostDiscoveryPath;
  ready: boolean;
  blocker: HostDiscoveryBlocker | null;
  /** The one sentence. */
  title: string;
  /** What to do about it, in one or two short sentences. */
  detail: string;
  action: HostDiscoveryAction;
};

/** Checked in this order; the first one present is the outcome. */
const BLOCKER_ORDER: ReadonlyArray<[HostEngineRequirement, HostDiscoveryBlocker]> = [
  ["ROOT_REQUIRED", "privilege"],
  ["LINUX_REQUIRED", "operating-system"],
  ["SUPPORTED_OS_REQUIRED", "operating-system"],
  ["SUPPORTED_ARCH_REQUIRED", "architecture"],
  ["PACKAGE_MANAGER_REQUIRED", "package-manager"],
  ["ENGINE_VERSION_UNSUPPORTED", "proxmox-version"],
  ["CGROUP_V2_REQUIRED", "cgroup"],
  ["KVM_REQUIRED", "virtualization"],
];

const LINUX_SANDBOX_NEEDS = "Linux Sandbox needs Ubuntu 22.04 or 24.04 on x86.";

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function hostOsLabel(snapshot: HostDiscoverySnapshot): string {
  const { os } = snapshot.host;
  if (os.family === "unknown") return "an operating system Hivra couldn't identify";
  const id = os.id ? capitalize(os.id) : "Linux";
  return os.versionId ? `${id} ${os.versionId}` : id;
}

export function hostArchitectureLabel(snapshot: HostDiscoverySnapshot): string {
  switch (snapshot.host.kernel.architecture) {
    case "amd64": return "x86";
    case "arm64": return "ARM";
    default: return "an unsupported processor";
  }
}

/** "Proxmox VE 8.4.1" from "pve-manager/8.4.1/2a5fa54a…". */
export function proxmoxVersionLabel(engine: HostDiscoveryEngine | undefined): string {
  const version = engine?.detectedVersion?.match(/^pve-manager\/([0-9][^/\s]*)/)?.[1];
  return version ? `Proxmox VE ${version}` : "Proxmox VE";
}

/** A root x86 Debian server with KVM is where Proxmox VE itself installs. */
function couldHostProxmox(snapshot: HostDiscoverySnapshot): boolean {
  const { host } = snapshot;
  return host.os.id === "debian" && host.kernel.architecture === "amd64"
    && host.environment.effectivePrivilege === "root" && host.kvm.devicePresent && host.kvm.cpuVirtualization;
}

function engine(snapshot: HostDiscoverySnapshot, id: HostDiscoveryEngine["id"]): HostDiscoveryEngine | undefined {
  return snapshot.engines.find((candidate) => candidate.id === id);
}

export function hostDiscoveryOutcome(
  snapshot: HostDiscoverySnapshot,
  context: { hostName?: string | null; sshUser?: string | null } = {},
): HostDiscoveryOutcome {
  const name = context.hostName?.trim() || "This server";
  // Mid-sentence, an unnamed server reads "this server".
  const named = context.hostName?.trim() || "this server";
  const proxmox = engine(snapshot, "proxmox-kvm");
  const gvisor = engine(snapshot, "gvisor");
  const path: HostDiscoveryPath = proxmox?.availability === "installed" ? "proxmox" : "gvisor";
  const target = path === "proxmox" ? proxmox : gvisor;

  if (path === "proxmox" && proxmox?.supported) {
    return {
      path, ready: true, blocker: null, action: "check-proxmox",
      title: `${name} runs ${proxmoxVersionLabel(proxmox)}.`,
      detail: "Next, check that it's ready for agents. The check only reads the server.",
    };
  }
  if (path === "gvisor" && gvisor?.supported) {
    const installed = gvisor.availability === "installed" && Boolean(gvisor.detectedVersion);
    return installed
      ? {
          path, ready: true, blocker: null, action: "check-gvisor",
          title: `${name} has Linux Sandbox set up.`,
          detail: "Check that it's ready to launch. The check only reads the server.",
        }
      : {
          path, ready: true, blocker: null, action: "review-gvisor-setup",
          title: `${name} can run Linux Sandbox after a short setup.`,
          detail: "Setup installs Docker and Hivra's pinned gVisor release, then tests it. You review every change first.",
        };
  }

  const unmet = new Set(target?.unmetRequirements ?? []);
  const blocker = BLOCKER_ORDER.find(([requirement]) => unmet.has(requirement))?.[1] ?? "unknown";
  const blocked = (title: string, detail: string, action: HostDiscoveryAction = "check-again"): HostDiscoveryOutcome => (
    { path, ready: false, blocker, title, detail, action }
  );
  const os = hostOsLabel(snapshot);
  const arch = hostArchitectureLabel(snapshot);

  switch (blocker) {
    case "privilege": {
      const user = context.sshUser?.trim();
      const title = snapshot.host.environment.effectivePrivilege === "unknown" || !user || user === "root"
        ? `Hivra couldn't confirm root access on ${named}.`
        : `Signed in as ${user} without root access.`;
      return blocked(
        title,
        `Hivra needs a root login on ${named} for now. Let root sign in with your SSH key, then connect as root.`,
        "connect-as-root",
      );
    }
    case "operating-system":
      return path === "proxmox"
        ? blocked(`${name} doesn't report a Linux system.`, "Hivra runs Proxmox servers on Linux. Check the server, then check again.")
        : blocked(
            `${name} runs ${os}. ${LINUX_SANDBOX_NEEDS}`,
            couldHostProxmox(snapshot)
              ? "Rebuild it with a supported image, or install Proxmox VE 8 or 9 on it to run agents and desktops. Then check again."
              : "Rebuild it with a supported image, then check again.",
          );
    case "architecture":
      return path === "proxmox"
        ? blocked(`${name} runs Proxmox on ${arch}. Hivra needs Proxmox VE on x86.`, "Use an x86 server, then check again.")
        : blocked(
            `${name} runs ${os} on ${arch}. ${LINUX_SANDBOX_NEEDS}`,
            "Rebuild it on an x86 server with a supported image, then check again.",
          );
    case "package-manager":
      return blocked(
        `${name} doesn't have the apt package manager. ${LINUX_SANDBOX_NEEDS}`,
        "Rebuild it with a supported image, then check again.",
      );
    case "proxmox-version":
      return blocked(
        `${name} runs ${proxmoxVersionLabel(proxmox)}. Hivra needs Proxmox VE 8 or 9.`,
        "Upgrade Proxmox, then check again.",
      );
    case "cgroup":
      return blocked(
        snapshot.host.environment.cgroupVersion === 1
          ? `${name} uses cgroup v1. Linux Sandbox needs cgroup v2.`
          : `${name} doesn't report cgroup v2. Linux Sandbox needs it.`,
        "Ubuntu 22.04 and 24.04 use cgroup v2 unless it was turned off. Turn it back on and restart the server, then check again.",
      );
    case "virtualization":
      return snapshot.host.environment.virtualization === "virtual-machine"
        ? blocked(
            `${name} is a virtual machine without nested KVM, so Proxmox can't create computers on it.`,
            "Turn on nested virtualization with your provider, or use a bare-metal server, then check again.",
          )
        : blocked(
            `KVM isn't available on ${named}, so Proxmox can't create computers on it.`,
            "Turn on virtualization (VT-x or AMD-V) in the server's firmware, then check again.",
          );
    default:
      return blocked(
        path === "proxmox"
          ? `${name} runs Proxmox, but Hivra can't use it yet.`
          : `${name} can't run Linux Sandbox yet.`,
        "Technical details shows what Hivra found. Fix the server, then check again.",
      );
  }
}
