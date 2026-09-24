/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { parseHostDiscoveryOutput } from "../host-discovery";
import { HOST_DISCOVERY_PROTOCOL } from "../host-discovery-contracts";
import { hostDiscoveryOutcome } from "../host-discovery-outcome";

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Parsed by the real discovery parser, so the outcome sees real evidence. */
function snapshot(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    PROTOCOL: "1", OS_FAMILY: "linux", OS_ID_B64: b64("ubuntu"), OS_VERSION_ID_B64: b64("24.04"),
    KERNEL_RELEASE_B64: b64("6.8.0"), ARCH_B64: b64("x86_64"), EUID: "0", VIRTUALIZATION: "virtual-machine",
    CGROUP_VERSION: "2", CPU_LOGICAL_CORES: "4", MEMORY_TOTAL_BYTES: "8589934592", MEMORY_AVAILABLE_BYTES: "6442450944",
    ROOT_STORAGE_TOTAL_BYTES: "68719476736", ROOT_STORAGE_AVAILABLE_BYTES: "51539607552",
    KVM_DEVICE: "0", CPU_VIRTUALIZATION: "1", PACKAGE_MANAGERS: "apt", MACHINE_ID_DIGEST: "c".repeat(64),
    PROXMOX_KVM_INSTALLED: "0", PROXMOX_KVM_VERSION_B64: "", QEMU_KVM_INSTALLED: "0", QEMU_KVM_VERSION_B64: "",
    GVISOR_INSTALLED: "0", GVISOR_VERSION_B64: "", DOCKER_INSTALLED: "0", DOCKER_VERSION_B64: "",
    CONTAINERD_INSTALLED: "0", CONTAINERD_VERSION_B64: "", PODMAN_INSTALLED: "0", PODMAN_VERSION_B64: "",
    OCI_RUNC_INSTALLED: "0", OCI_RUNC_VERSION_B64: "", OCI_CRUN_INSTALLED: "0", OCI_CRUN_VERSION_B64: "",
    LXC_INSTALLED: "0", LXC_VERSION_B64: "", END: "1",
    ...overrides,
  };
  return parseHostDiscoveryOutput({
    output: Object.entries(values).map(([key, value]) => `${HOST_DISCOVERY_PROTOCOL}\t${key}\t${value}`).join("\n"),
    discoveryId: "22222222-2222-4222-8222-222222222222",
    connectionId: "11111111-1111-4111-8111-111111111111",
    connectionRevision: 1,
    connectionProvider: "host",
    normalizedHostFingerprint: "ab".repeat(32),
    observedAt: new Date("2026-09-24T12:00:00.000Z"),
  });
}

describe("hostDiscoveryOutcome", () => {
  it("orders blockers privilege, then operating system, then virtualization", () => {
    // Non-root, unsupported Ubuntu and no KVM at once: root is named first.
    const everything = snapshot({ EUID: "1000", OS_VERSION_ID_B64: b64("20.04") });
    expect(hostDiscoveryOutcome(everything, { hostName: "web-1", sshUser: "ubuntu" })).toMatchObject({
      blocker: "privilege",
      title: "Signed in as ubuntu without root access.",
      action: "connect-as-root",
    });
    // With root fixed, the operating system is next.
    expect(hostDiscoveryOutcome(snapshot({ OS_VERSION_ID_B64: b64("20.04") }), { hostName: "web-1" })).toMatchObject({
      blocker: "operating-system",
      action: "check-again",
    });
  });

  it("gives an unnamed server lower-case mid-sentence", () => {
    expect(hostDiscoveryOutcome(snapshot({ EUID: "1000" }), { sshUser: "ubuntu" }).detail)
      .toBe("Hivra needs a root login on this server for now. Let root sign in with your SSH key, then connect as root.");
  });

  it("suggests Proxmox on a root x86 Debian server with KVM", () => {
    const debian = snapshot({ OS_ID_B64: b64("debian"), OS_VERSION_ID_B64: b64("12"), VIRTUALIZATION: "bare-metal", KVM_DEVICE: "1" });
    expect(hostDiscoveryOutcome(debian, { hostName: "metal-1" })).toMatchObject({
      title: "metal-1 runs Debian 12. Linux Sandbox needs Ubuntu 22.04 or 24.04 on x86.",
      detail: expect.stringContaining("install Proxmox VE 8 or 9 on it"),
    });
  });

  it("names cgroup v1 and an unsupported Proxmox release plainly", () => {
    expect(hostDiscoveryOutcome(snapshot({ CGROUP_VERSION: "1" }), { hostName: "web-1" })).toMatchObject({
      blocker: "cgroup",
      title: "web-1 uses cgroup v1. Linux Sandbox needs cgroup v2.",
    });
    const oldProxmox = snapshot({
      OS_ID_B64: b64("debian"), OS_VERSION_ID_B64: b64("11"), VIRTUALIZATION: "bare-metal", KVM_DEVICE: "1",
      PROXMOX_KVM_INSTALLED: "1", PROXMOX_KVM_VERSION_B64: b64("pve-manager/7.4-3/9002ab8a"),
    });
    expect(hostDiscoveryOutcome(oldProxmox, { hostName: "pve-old" })).toMatchObject({
      path: "proxmox",
      blocker: "proxmox-version",
      title: "pve-old runs Proxmox VE 7.4-3. Hivra needs Proxmox VE 8 or 9.",
    });
  });
});
