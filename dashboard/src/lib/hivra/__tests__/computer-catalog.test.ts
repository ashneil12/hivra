import {
  COMPUTER_TEMPLATES,
  OMARCHY_TEMPLATE,
  UBUNTU_DESKTOP_TEMPLATE,
  WINDOWS_TEMPLATE,
  assessComputerTemplateTarget,
  getComputerTemplate,
} from "../computer-catalog";

describe("Hivra computer-image catalog", () => {
  it("offers Ubuntu Desktop as the first launchable computer profile", () => {
    expect(COMPUTER_TEMPLATES.map((template) => template.id)).toEqual(["ubuntu-desktop", "omarchy", "windows"]);
    expect(getComputerTemplate("ubuntu-desktop")).toBe(UBUNTU_DESKTOP_TEMPLATE);
    expect(UBUNTU_DESKTOP_TEMPLATE).toMatchObject({
      kind: "operating-system",
      status: "available",
      launchable: true,
      runtimeId: "linux-desktop",
      requirements: { cpu: 2, ramGb: 4, diskGb: 40 },
      access: {
        browser: {
          protocol: "selkies-websocket",
          status: "accepted-x11",
        },
      },
    });
  });

  it("keeps Ubuntu admission aligned with the provisioner's 40 GB disk", () => {
    expect(assessComputerTemplateTarget(UBUNTU_DESKTOP_TEMPLATE, {
      architecture: "amd64",
      driver: "proxmox-kvm",
      kvmAvailable: true,
      cpu: 2,
      ramGb: 4,
      diskGb: 30,
      preparedImageSha256: UBUNTU_DESKTOP_TEMPLATE.upstream.isoSha256,
    }).issues).toContainEqual(expect.objectContaining({ code: "DISK_BELOW_MINIMUM" }));
  });

  it("models Omarchy as a computer image, not an agent identity", () => {
    expect(COMPUTER_TEMPLATES).toHaveLength(3);
    expect(getComputerTemplate("omarchy")).toBe(OMARCHY_TEMPLATE);
    expect(OMARCHY_TEMPLATE).toMatchObject({
      kind: "operating-system",
      status: "private-preview",
      launchable: true,
      launchMode: "prepared-canary",
      runtimeId: "linux-desktop",
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
    });
  });

  it("models Windows as a prepared Canary profile without granting ordinary target launch authority", () => {
    expect(getComputerTemplate("windows")).toBe(WINDOWS_TEMPLATE);
    expect(WINDOWS_TEMPLATE).toMatchObject({
      kind: "operating-system",
      status: "private-preview",
      launchable: true,
      launchMode: "prepared-canary",
      requirements: { cpu: 4, ramGb: 8, diskGb: 64 },
    });
    expect(WINDOWS_TEMPLATE.runtimeId).toBe("linux-desktop");
    expect(WINDOWS_TEMPLATE.access).toMatchObject({
      native: { protocol: "sunshine-moonlight", status: "planned" },
      browser: { protocol: "guacamole-rdp", status: "planned-windows" },
      administration: { protocol: "winrm", status: "planned" },
    });
    expect(WINDOWS_TEMPLATE.commercialAvailability).toEqual({
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
    });
  });

  it("pins the immutable upstream release, commit, ISO and checksum", () => {
    expect(OMARCHY_TEMPLATE.upstream).toEqual({
      repository: "https://github.com/omacom/omarchy",
      release: "v4.0.2",
      commit: "346e69e1cec6c4e8924531874af6ba010a1bc99e",
      license: "MIT",
      isoUrl: "https://iso.omarchy.org/omarchy-4.0.2.iso",
      isoSha256: "2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8",
      publishedAt: "2026-08-31T03:42:33Z",
    });
  });

  it("uses the official unattended ISO and native Sunshine/Moonlight lane", () => {
    expect(OMARCHY_TEMPLATE.provisioning).toMatchObject({
      mode: "official-unattended-iso",
      configVolumeLabel: "cidata",
      encryptedInstallNeedsInteractiveUnlock: true,
    });
    expect(OMARCHY_TEMPLATE.access.native).toMatchObject({
      protocol: "sunshine-moonlight",
      status: "guest-prepared",
    });
    expect(OMARCHY_TEMPLATE.access.browser).toMatchObject({
      protocol: "selkies-webrtc",
      status: "planned-x11-only",
    });
  });

  it("fails closed even when target resources and image match until the adapter is accepted", () => {
    const admission = assessComputerTemplateTarget(OMARCHY_TEMPLATE, {
      architecture: "x86_64",
      driver: "proxmox-kvm",
      kvmAvailable: true,
      cpu: 4,
      ramGb: 8,
      diskGb: 40,
      preparedImageSha256: OMARCHY_TEMPLATE.upstream.isoSha256,
    });

    expect(admission.launchReady).toBe(false);
    expect(admission.issues).toEqual([
      expect.objectContaining({ code: "CONTROL_PLANE_ADAPTER_UNAVAILABLE" }),
    ]);
  });

  it("reports every incompatible target boundary instead of degrading silently", () => {
    const admission = assessComputerTemplateTarget(OMARCHY_TEMPLATE, {
      architecture: "arm64",
      driver: "docker",
      kvmAvailable: false,
      cpu: 2,
      ramGb: 4,
      diskGb: 20,
      preparedImageSha256: "0".repeat(64),
    });

    expect(admission.launchReady).toBe(false);
    expect(admission.issues.map((issue) => issue.code)).toEqual([
      "UNSUPPORTED_ARCHITECTURE",
      "UNSUPPORTED_DRIVER",
      "KVM_UNAVAILABLE",
      "CPU_BELOW_MINIMUM",
      "RAM_BELOW_MINIMUM",
      "DISK_BELOW_MINIMUM",
      "IMAGE_MISMATCH",
      "CONTROL_PLANE_ADAPTER_UNAVAILABLE",
    ]);
  });
});
