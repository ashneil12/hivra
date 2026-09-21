// Hivra computer-image catalog.
//
// Keep this separate from agent-catalog.ts: an operating-system image is the
// computer substrate that can host one or more runtimes, not an agent identity.
// Pure data/logic keeps the catalog usable by the dashboard, API, CLI, and
// provisioner without importing a UI or a database client.

export type ComputerTemplateId = "ubuntu-desktop" | "omarchy" | "windows";
type ComputerTemplateStatus = "planned" | "private-preview" | "available";
type ComputerIsolationDriver = "proxmox-kvm";

export interface ComputerTemplateTarget {
  architecture: string;
  driver: string;
  kvmAvailable: boolean;
  cpu: number;
  ramGb: number;
  diskGb: number;
  preparedImageSha256?: string | null;
}

type ComputerTemplateAdmissionCode =
  | "UNSUPPORTED_ARCHITECTURE"
  | "UNSUPPORTED_DRIVER"
  | "KVM_UNAVAILABLE"
  | "CPU_BELOW_MINIMUM"
  | "RAM_BELOW_MINIMUM"
  | "DISK_BELOW_MINIMUM"
  | "IMAGE_NOT_PREPARED"
  | "IMAGE_MISMATCH"
  | "CONTROL_PLANE_ADAPTER_UNAVAILABLE";

export interface ComputerTemplateAdmissionIssue {
  code: ComputerTemplateAdmissionCode;
  message: string;
}

export interface ComputerTemplateDefinition {
  id: ComputerTemplateId;
  /** Existing computer lifecycle runtime used to materialize this profile. */
  runtimeId?: "linux-desktop";
  name: string;
  kind: "operating-system";
  summary: string;
  status: ComputerTemplateStatus;
  launchable: boolean;
  launchMode: "standard" | "prepared-canary";
  upstream: {
    repository: string;
    release: string;
    commit: string;
    license: string;
    isoUrl: string;
    isoSha256: string;
    publishedAt: string;
  };
  requirements: {
    architectures: readonly ["amd64"];
    drivers: readonly [ComputerIsolationDriver];
    kvm: true;
    cpu: number;
    ramGb: number;
    diskGb: number;
    machine: "q35";
    firmware: "uefi";
    display: "virtio";
  };
  provisioning: {
    mode: "hivra-ubuntu-cloud-image" | "official-unattended-iso";
    configVolumeLabel: "cidata";
    encryptedInstallNeedsInteractiveUnlock: boolean;
    supportsDeferredOwnerSetup: boolean;
  };
  commercialAvailability?: {
    /** A retained machine may be used for acceptance without being a sellable image pipeline. */
    privateCanary: "test-only";
    /** Customer capacity still needs an implemented provider/image adapter before launch is offered. */
    customerCapacity: "adapter-required";
    /** Managed Windows remains closed until the selected AVD commercial lane and adapter are evidenced. */
    hivraManaged: "entitlement-required";
    managedOffering: {
      provider: "azure-virtual-desktop";
      assignment: "personal";
      operatingSystem: "windows-11-enterprise";
      audience: "external-commercial-users";
    };
    requiredManagedEvidence: readonly [
      "enrolled-avd-per-user-access-azure-subscription",
      "implemented-accepted-avd-provider-adapter",
    ];
  };
  access: {
    native: {
      protocol: "sunshine-moonlight";
      status: "guest-prepared" | "planned";
      note: string;
    };
    browser: {
      protocol: "selkies-webrtc" | "selkies-websocket" | "guacamole-rdp";
      status: "accepted-x11" | "planned-x11-only" | "planned-windows";
      note: string;
    };
    administration: {
      protocol: "ssh" | "winrm";
      status: "official-unattended-option" | "planned";
      note: string;
    };
  };
}

export const UBUNTU_DESKTOP_TEMPLATE: ComputerTemplateDefinition = {
  id: "ubuntu-desktop",
  runtimeId: "linux-desktop",
  name: "Ubuntu Desktop",
  kind: "operating-system",
  summary: "An isolated Ubuntu VM with a contained browser desktop, files, and terminal access.",
  status: "available",
  launchable: true,
  launchMode: "standard",
  upstream: {
    repository: "https://cloud-images.ubuntu.com/jammy/current/",
    release: "22.04 LTS",
    commit: "hivra-ubuntu-jammy",
    license: "Ubuntu image terms",
    isoUrl: "",
    isoSha256: "ff271290a23279ce764561dbe2e9c3ec29da899535b571a987c37b47970c2ad9",
    publishedAt: "2026-08-24T00:00:00Z",
  },
  requirements: {
    architectures: ["amd64"],
    drivers: ["proxmox-kvm"],
    kvm: true,
    cpu: 2,
    ramGb: 4,
    diskGb: 40,
    machine: "q35",
    firmware: "uefi",
    display: "virtio",
  },
  provisioning: {
    mode: "hivra-ubuntu-cloud-image",
    configVolumeLabel: "cidata",
    encryptedInstallNeedsInteractiveUnlock: false,
    supportsDeferredOwnerSetup: false,
  },
  access: {
    native: {
      protocol: "sunshine-moonlight",
      status: "guest-prepared",
      note: "Native Sunshine access remains an optional performance lane; the first alpha uses the authenticated browser desktop.",
    },
    browser: {
      protocol: "selkies-websocket",
      status: "accepted-x11",
      note: "The Ubuntu profile uses Hivra's accepted X11 Selkies WebSocket/WebCodecs path. WebRTC remains a separate capability-selected performance lane.",
    },
    administration: {
      protocol: "ssh",
      status: "official-unattended-option",
      note: "Owner-scoped terminal and files remain available through the existing Hivra gateway.",
    },
  },
};

// Pinned from the immutable upstream v4.0.2 release. Updating any artifact
// field requires reviewing the release, updating the checksum, and repeating
// the KVM install + desktop acceptance campaign.
export const OMARCHY_TEMPLATE: ComputerTemplateDefinition = {
  id: "omarchy",
  runtimeId: "linux-desktop",
  name: "Omarchy",
  kind: "operating-system",
  summary: "An opinionated Arch + Hyprland computer for development and AI work.",
  status: "private-preview",
  launchable: true,
  launchMode: "prepared-canary",
  upstream: {
    repository: "https://github.com/omacom/omarchy",
    release: "v4.0.2",
    commit: "346e69e1cec6c4e8924531874af6ba010a1bc99e",
    license: "MIT",
    isoUrl: "https://iso.omarchy.org/omarchy-4.0.2.iso",
    isoSha256: "2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8",
    publishedAt: "2026-08-31T03:42:33Z",
  },
  requirements: {
    architectures: ["amd64"],
    drivers: ["proxmox-kvm"],
    kvm: true,
    cpu: 4,
    ramGb: 8,
    diskGb: 40,
    machine: "q35",
    firmware: "uefi",
    display: "virtio",
  },
  provisioning: {
    mode: "official-unattended-iso",
    configVolumeLabel: "cidata",
    encryptedInstallNeedsInteractiveUnlock: true,
    supportsDeferredOwnerSetup: true,
  },
  access: {
    native: {
      protocol: "sunshine-moonlight",
      status: "guest-prepared",
      note: "Hivra has booted the pinned image and corrected the v4.0.2 Sunshine package/unit handoff. Native launch stays closed until an approved private UDP route, pairing, revocation, input/audio and measured WAN latency pass.",
    },
    browser: {
      protocol: "selkies-webrtc",
      status: "planned-x11-only",
      note: "Browser-native WebRTC is a separate X11 acceptance target. Current Selkies capture is not admitted for Omarchy's Hyprland/Wayland desktop without new upstream or Hivra capture proof.",
    },
    administration: {
      protocol: "ssh",
      status: "official-unattended-option",
      note: "The official cidata contract can install owner public keys without enabling password authentication.",
    },
  },
};

/**
 * Windows is deliberately modeled now so the web app, native app, API, and
 * eventual provisioner share one stable computer-profile identity. Canary can
 * claim the prepared evaluation guest and open its owner-scoped setup console;
 * ordinary target provisioning remains closed until a licensed image pipeline
 * and the complete RDP/Guacamole lifecycle are accepted.
 */
export const WINDOWS_TEMPLATE: ComputerTemplateDefinition = {
  id: "windows",
  runtimeId: "linux-desktop",
  name: "Windows",
  kind: "operating-system",
  summary: "A persistent Windows computer with an interactive browser setup console.",
  status: "private-preview",
  launchable: true,
  launchMode: "prepared-canary",
  upstream: {
    repository: "https://www.microsoft.com/software-download/windows11",
    release: "customer-supplied licensed image",
    commit: "unselected",
    license: "Microsoft Software License Terms",
    isoUrl: "",
    isoSha256: "",
    publishedAt: "",
  },
  requirements: {
    architectures: ["amd64"],
    drivers: ["proxmox-kvm"],
    kvm: true,
    cpu: 4,
    ramGb: 8,
    diskGb: 64,
    machine: "q35",
    firmware: "uefi",
    display: "virtio",
  },
  provisioning: {
    mode: "official-unattended-iso",
    configVolumeLabel: "cidata",
    encryptedInstallNeedsInteractiveUnlock: false,
    supportsDeferredOwnerSetup: true,
  },
  commercialAvailability: {
    privateCanary: "test-only",
    customerCapacity: "adapter-required",
    hivraManaged: "entitlement-required",
    managedOffering: {
      provider: "azure-virtual-desktop",
      assignment: "personal",
      operatingSystem: "windows-11-enterprise",
      audience: "external-commercial-users",
    },
    requiredManagedEvidence: [
      "enrolled-avd-per-user-access-azure-subscription",
      "implemented-accepted-avd-provider-adapter",
    ],
  },
  access: {
    native: {
      protocol: "sunshine-moonlight",
      status: "planned",
      note: "A native performance lane is planned after the Windows guest and scoped private networking are accepted.",
    },
    browser: {
      protocol: "guacamole-rdp",
      status: "planned-windows",
      note: "Windows browser access will use the separately reviewed Guacamole/RDP transport, not the Linux Selkies profile.",
    },
    administration: {
      protocol: "winrm",
      status: "planned",
      note: "Windows administration and recovery require a separate WinRM/RDP contract before launch is enabled.",
    },
  },
};

export const COMPUTER_TEMPLATES: readonly ComputerTemplateDefinition[] = [
  UBUNTU_DESKTOP_TEMPLATE,
  OMARCHY_TEMPLATE,
  WINDOWS_TEMPLATE,
];

export function getComputerTemplate(id: string): ComputerTemplateDefinition | undefined {
  return COMPUTER_TEMPLATES.find((template) => template.id === id);
}

function normalizeArchitecture(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "x86_64" ? "amd64" : normalized;
}

/**
 * Fail-closed target admission. A matching host is not launch permission: the
 * exact verified image and a live control-plane adapter are also required.
 */
export function assessComputerTemplateTarget(
  template: ComputerTemplateDefinition,
  target: ComputerTemplateTarget,
): { launchReady: boolean; issues: ComputerTemplateAdmissionIssue[] } {
  const issues: ComputerTemplateAdmissionIssue[] = [];
  const requirements = template.requirements;

  if (!requirements.architectures.includes(normalizeArchitecture(target.architecture) as "amd64")) {
    issues.push({
      code: "UNSUPPORTED_ARCHITECTURE",
      message: `The ${template.name} preview currently supports amd64 KVM hosts only.`,
    });
  }
  if (!requirements.drivers.includes(target.driver as ComputerIsolationDriver)) {
    issues.push({
      code: "UNSUPPORTED_DRIVER",
      message: `${template.name} currently requires the Proxmox KVM driver.`,
    });
  }
  if (!target.kvmAvailable) {
    issues.push({ code: "KVM_UNAVAILABLE", message: "Hardware virtualization is not available on this target." });
  }
  if (target.cpu < requirements.cpu) {
    issues.push({ code: "CPU_BELOW_MINIMUM", message: `${requirements.cpu} vCPU are required.` });
  }
  if (target.ramGb < requirements.ramGb) {
    issues.push({ code: "RAM_BELOW_MINIMUM", message: `${requirements.ramGb} GB RAM are required.` });
  }
  if (target.diskGb < requirements.diskGb) {
    issues.push({ code: "DISK_BELOW_MINIMUM", message: `${requirements.diskGb} GB storage is required.` });
  }

  const preparedImageSha256 = target.preparedImageSha256?.trim().toLowerCase();
  if (!preparedImageSha256) {
    issues.push({
      code: "IMAGE_NOT_PREPARED",
      message: `The pinned ${template.upstream.release} image has not been verified on this target.`,
    });
  } else if (preparedImageSha256 !== template.upstream.isoSha256) {
    issues.push({
      code: "IMAGE_MISMATCH",
      message: "The prepared image checksum does not match the pinned catalog artifact.",
    });
  }

  if (!template.launchable || template.launchMode !== "standard") {
    issues.push({
      code: "CONTROL_PLANE_ADAPTER_UNAVAILABLE",
      message: "The install contract is pinned, but Hivra launch, access-grant, and teardown acceptance is still in private preview.",
    });
  }

  return { launchReady: issues.length === 0, issues };
}
