/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { parseHostDiscoveryOutput } from "../host-discovery";
import { HOST_DISCOVERY_PROTOCOL } from "../host-discovery-contracts";
import { hostDiscoveryOutcome } from "../host-discovery-outcome";

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Parsed by the real discovery parser, so the outcome sees real evidence. */
function snapshot(overrides: Record<string, string> = {}, privilegeVia: "login" | "sudo" = "login") {
  const values: Record<string, string> = {
    PROTOCOL: "2", PASSWORDLESS_SUDO: "", OS_FAMILY: "linux", OS_ID_B64: b64("ubuntu"), OS_VERSION_ID_B64: b64("24.04"),
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
    privilegeVia,
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
      title: "Signed in as ubuntu without passwordless sudo.",
      // sudo logs the check (and may mail root a sudo incident for a user it
      // doesn't know), so the copy says Hivra asked (review finding 12).
      detail: "Run the setup command with sudo, or connect as a user who has it. Hivra asked sudo once, without a password; the server's log records that check.",
      action: "use-setup-command",
    });
    // With root fixed, the operating system is next.
    expect(hostDiscoveryOutcome(snapshot({ OS_VERSION_ID_B64: b64("20.04") }), { hostName: "web-1" })).toMatchObject({
      blocker: "operating-system",
      action: "check-again",
    });
  });

  it("gives an unnamed server lower-case mid-sentence", () => {
    expect(hostDiscoveryOutcome(snapshot({ EUID: "" }), { sshUser: "ubuntu" })).toMatchObject({
      title: "Hivra couldn't confirm root access on this server.",
      detail: "Run the setup command on this server with sudo, or connect as root.",
    });
  });

  // INF-04: a default cloud image signs in as a sudo user. Offer sudo for
  // setup when the inspection found passwordless sudo; the nested-KVM message
  // never appears when privilege is the blocker.
  it("offers sudo for setup when a non-root login has passwordless sudo", () => {
    const withSudo = snapshot({ EUID: "1000", PASSWORDLESS_SUDO: "1", KVM_DEVICE: "0" });
    expect(withSudo.host.environment).toMatchObject({ passwordlessSudo: true, privilegeVia: "login" });
    expect(hostDiscoveryOutcome(withSudo, { hostName: "web-1", sshUser: "ubuntu" })).toMatchObject({
      blocker: "privilege",
      title: "ubuntu can use sudo without a password.",
      action: "use-sudo",
    });
    expect(hostDiscoveryOutcome(snapshot({ EUID: "1000", PASSWORDLESS_SUDO: "0" }), { sshUser: "ubuntu" }))
      .toMatchObject({ title: "Signed in as ubuntu without passwordless sudo.", action: "use-setup-command" });
  });

  it("doesn't offer sudo on Proxmox VE while Proxmox launches need root", () => {
    const proxmox = snapshot({ EUID: "1000", PASSWORDLESS_SUDO: "1", PROXMOX_KVM_INSTALLED: "1",
      PROXMOX_KVM_VERSION_B64: b64("pve-manager/8.2.4/abc"), OS_ID_B64: b64("debian"), OS_VERSION_ID_B64: b64("12") });
    expect(hostDiscoveryOutcome(proxmox, { hostName: "pve-1", sshUser: "admin" })).toMatchObject({
      blocker: "privilege",
      title: "admin can use sudo without a password, but pve-1 runs Proxmox VE, which needs a root login for now.",
      action: "change-ssh-user",
    });
    expect(hostDiscoveryOutcome(proxmox, { hostName: "pve-1", sshUser: "admin", proxmoxSudoAllowed: true }))
      .toMatchObject({ action: "use-sudo" });
  });

  it("reads an inspection through sudo as root: the outcome moves on to the server itself", () => {
    const throughSudo = snapshot({ EUID: "0" }, "sudo");
    expect(throughSudo.host.environment).toMatchObject({ effectivePrivilege: "root", privilegeVia: "sudo" });
    expect(hostDiscoveryOutcome(throughSudo, { hostName: "web-1", sshUser: "hivra" }))
      .toMatchObject({ ready: true, action: "review-gvisor-setup" });
  });

  // Review finding 2: while gate T43 is off, a connection that reaches root
  // through sudo is never offered a Proxmox check, setup or launch.
  it("offers no Proxmox path through sudo while Proxmox launches need a root login", () => {
    const pveThroughSudo = snapshot({ OS_ID_B64: b64("debian"), OS_VERSION_ID_B64: b64("12"), VIRTUALIZATION: "bare-metal",
      KVM_DEVICE: "1", PROXMOX_KVM_INSTALLED: "1", PROXMOX_KVM_VERSION_B64: b64("pve-manager/8.2.4/abc") }, "sudo");
    expect(hostDiscoveryOutcome(pveThroughSudo, { hostName: "pve-1", sshUser: "hivra" })).toEqual({
      path: "proxmox", ready: false, blocker: "privilege", action: "change-ssh-user",
      title: "pve-1 runs Proxmox VE 8.2.4. Proxmox launches need a root login for now.",
      detail: "Through sudo, Hivra sets up only Linux Sandbox for now, and that needs Ubuntu 22.04 or 24.04. Connect as root instead, then check again.",
    });
    // The same server over a root login is offered the Proxmox check.
    const pveAsRoot = snapshot({ OS_ID_B64: b64("debian"), OS_VERSION_ID_B64: b64("12"), VIRTUALIZATION: "bare-metal",
      KVM_DEVICE: "1", PROXMOX_KVM_INSTALLED: "1", PROXMOX_KVM_VERSION_B64: b64("pve-manager/8.2.4/abc") });
    expect(hostDiscoveryOutcome(pveAsRoot, { hostName: "pve-1", sshUser: "root" }).action).toBe("check-proxmox");
    // Once the gate opens, sudo reaches the Proxmox check too.
    expect(hostDiscoveryOutcome(pveThroughSudo, { hostName: "pve-1", sshUser: "hivra", proxmoxSudoAllowed: true }).action)
      .toBe("check-proxmox");
    // And no "install Proxmox VE" suggestion through sudo on plain Debian.
    const debianThroughSudo = snapshot({ OS_ID_B64: b64("debian"), OS_VERSION_ID_B64: b64("12"), VIRTUALIZATION: "bare-metal",
      KVM_DEVICE: "1" }, "sudo");
    expect(hostDiscoveryOutcome(debianThroughSudo, { hostName: "metal-1" }).detail).toBe("Rebuild it with a supported image, then check again.");
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
