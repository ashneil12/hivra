import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPortableKvmSourceProfileCheck, isPortableKvmSourceProfileEligible } from "../source-profile";

jest.mock("server-only", () => ({}));

const placement = { hostId: "qa-source", vmid: 9343, ip: "192.0.2.43", bindingTag: "hivra-bind-" + "a".repeat(32) };
const profile = {
  machine: "pc-i440fx-8.1", cores: 2, memoryMb: 2048, network: { bridge: "vmbr27", macAddress: "02:11:22:33:44:55" },
  attachment: { discard: true, ssd: true, ioThread: false },
};
const approved = [
  "agent: 1", "bios: seabios", "boot: order=scsi0", "cores: 2", "cpu: x86-64-v2-AES", "machine: pc-i440fx-8.1",
  "memory: 2048", "ostype: l26", "scsihw: virtio-scsi-single", "net0: virtio=02:11:22:33:44:55,bridge=vmbr27,firewall=1",
  "scsi0: local-lvm:vm-9343-disk-0,discard=on,ssd=1", "tags: qa;" + placement.bindingTag,
].join("\n") + "\n";

function eligible(config: string, status = "stopped", launchProfile: Parameters<typeof buildPortableKvmSourceProfileCheck>[1] = profile) {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-profile-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(root, "9343.conf"), config);
    writeFileSync(join(root, "cold-9343"), placement.bindingTag + "\n");
    writeFileSync(join(bin, "hostname"), "#!/bin/sh\nprintf '%s\\n' qa-source\n", { mode: 0o700 });
    writeFileSync(join(bin, "qm"), "#!/bin/sh\ncase \"$1\" in status) echo \"status: $TEST_STATUS\";; config) cat \"$TEST_CONFIG\";; *) exit 65;; esac\n",
      { mode: 0o700 });
    const command = buildPortableKvmSourceProfileCheck(placement, launchProfile)
      .replaceAll("/etc/pve/qemu-server", root).replaceAll("/var/lib/hivra-sleep", root)
      .replaceAll("/run/qemu-server", root).replace("marker.stat().st_uid != 0", `marker.stat().st_uid != ${process.getuid?.() ?? 0}`);
    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf8", timeout: 5000, env: { NODE_ENV: "test", PATH: bin + ":/usr/bin:/bin",
        TEST_STATUS: status, TEST_CONFIG: join(root, "9343.conf") },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    return isPortableKvmSourceProfileEligible(result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("admits the exact cooled Linux fixture profile without emitting configuration", () => {
  expect(eligible(approved)).toBe(true);
  expect(eligible(approved, "running")).toBe(false);
});

it.each([
  "ide2: local-lvm:vm-9343-cloudinit,media=cdrom", "serial0: socket", "args: synthetic", "onboot: 1",
  "lock: backup", "scsi1: local-lvm:vm-9343-disk-1", "[PENDING]", "vmstate: local-lvm:vm-9343-state",
])("refuses an unproven source with %s", field => {
  expect(eligible(approved + field + "\n")).toBe(false);
});

it("refuses the ordinary launch CPU profile and unverified NIC settings", () => {
  expect(eligible(approved.replace("cpu: x86-64-v2-AES", "cpu: host"))).toBe(false);
  expect(eligible(approved.replace("bridge=vmbr27", "bridge=vmbr28"))).toBe(false);
});

it("accepts the ordinary serial console and generated seed only with their qualified settings", () => {
  const ordinary = approved.replace("cpu: x86-64-v2-AES", "cpu: host").replace(",firewall=1", "") +
    "cpulimit: 2\nserial0: socket\nvga: serial0\n" +
    "ide2: local-lvm:vm-9343-cloudinit,media=cdrom\nciuser: ubuntu\nciupgrade: 0\n" +
    "ipconfig0: ip=192.0.2.43/24,gw=192.0.2.1\nnameserver: 192.0.2.53\n";
  const measured: Parameters<typeof buildPortableKvmSourceProfileCheck>[1] = { ...profile, managed: {
    cpu: { vendor: "GenuineIntel", requiredFlags: ["aes", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] },
    cpuLimit: 2, cloudInit: { instanceId: "1".repeat(40), gateway: "192.0.2.1", nameservers: ["192.0.2.53"] },
  } };
  expect(eligible(ordinary, "stopped", measured)).toBe(true);
  expect(eligible(ordinary + "cicustom: user=local:snippets/arbitrary.yaml\n", "stopped", measured)).toBe(false);
  expect(eligible(ordinary.replace("serial0: socket", "serial0: /dev/ttyS0"), "stopped", measured)).toBe(false);
  expect(eligible(ordinary.replace("ip=192.0.2.43", "ip=192.0.2.44"), "stopped", measured)).toBe(false);
});
