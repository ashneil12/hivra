import {
  snapshotPrivilegeVia,
  type HostDiscoveryEngine,
  type HostDiscoverySnapshot,
  type HostEngineRequirement,
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
  | "change-ssh-user"
  /** Run host scripts through the user's passwordless sudo (an operational
   * change that raises the revision), then inspect again. */
  | "use-sudo"
  /** Connect the server with the one-line setup command instead. */
  | "use-setup-command"
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

/** A root x86 Debian server with KVM is where Proxmox VE itself installs.
 * (Root through sudo counts: the snapshot's effective privilege is what the
 * inspection itself ran as.) */
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
  context: {
    hostName?: string | null;
    sshUser?: string | null;
    /** Whether Proxmox launches may run through sudo yet (release gate T43). */
    proxmoxSudoAllowed?: boolean;
  } = {},
): HostDiscoveryOutcome {
  const name = context.hostName?.trim() || "This server";
  // Mid-sentence, an unnamed server reads "this server".
  const named = context.hostName?.trim() || "this server";
  const proxmox = engine(snapshot, "proxmox-kvm");
  const gvisor = engine(snapshot, "gvisor");
  const path: HostDiscoveryPath = proxmox?.availability === "installed" ? "proxmox" : "gvisor";
  const target = path === "proxmox" ? proxmox : gvisor;
  // Release gate T43: Proxmox launches can't run through sudo yet, so a sudo
  // connection is never offered Proxmox checks, setup or launch. Through sudo,
  // Hivra sets up Linux Sandbox only for now, which Proxmox VE (Debian) can't
  // run.
  const proxmoxThroughSudo = snapshotPrivilegeVia(snapshot) === "sudo" && !context.proxmoxSudoAllowed;

  if (path === "proxmox" && proxmoxThroughSudo) {
    return {
      path, ready: false, blocker: "privilege", action: "change-ssh-user",
      title: `${name} runs ${proxmoxVersionLabel(proxmox)}. Proxmox launches need a root login for now.`,
      detail: "Through sudo, Hivra sets up only Linux Sandbox for now, and that needs Ubuntu 22.04 or 24.04. Connect as root instead, then check again.",
    };
  }
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
          // Discovery only sees that gVisor is installed, not who installed it;
          // the strict check decides whether it is Hivra's Linux Sandbox setup.
          title: `${name} already has gVisor, which Linux Sandbox runs on.`,
          detail: "Check whether it's ready for Linux Sandbox. The check only reads the server and says if the setup needs reinstalling.",
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
      const { effectivePrivilege, passwordlessSudo } = snapshot.host.environment;
      if (effectivePrivilege === "unknown" || !user || user === "root") {
        return blocked(
          `Hivra couldn't confirm root access on ${named}.`,
          `Run the setup command on ${named} with sudo, or connect as root.`,
          "use-setup-command",
        );
      }
      if (passwordlessSudo === true) {
        // Proxmox launches need a root login until the sudo transport passes
        // release gate T43, so sudo isn't offered on Proxmox VE yet.
        if (path === "proxmox" && !context.proxmoxSudoAllowed) {
          return blocked(
            `${user} can use sudo without a password, but ${name} runs Proxmox VE, which needs a root login for now.`,
            "Connect as root, then check again.",
            "change-ssh-user",
          );
        }
        return blocked(
          `${user} can use sudo without a password.`,
          "Use sudo for setup: Hivra runs its setup and checks through sudo as this user, then inspects again.",
          "use-sudo",
        );
      }
      return blocked(
        `Signed in as ${user} without passwordless sudo.`,
        // sudo logs the check, and mails root an incident for a user it
        // doesn't know at all (mail_no_user), so the copy says Hivra asked.
        "Run the setup command with sudo, or connect as a user who has it. Hivra asked sudo once, without a password; the server's log records that check.",
        "use-setup-command",
      );
    }
    case "operating-system":
      return path === "proxmox"
        ? blocked(`${name} doesn't report a Linux system.`, "Hivra runs Proxmox servers on Linux. Check the server, then check again.")
        : blocked(
            `${name} runs ${os}. ${LINUX_SANDBOX_NEEDS}`,
            couldHostProxmox(snapshot) && !proxmoxThroughSudo
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
