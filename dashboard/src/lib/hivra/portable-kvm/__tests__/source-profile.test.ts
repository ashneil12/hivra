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

function eligible(config: string, status = "stopped", launchProfile: Parameters<typeof buildPortableKvmSourceProfileCheck>[1] = profile, raw = config) {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-profile-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(root, "9343.conf"), raw);
    writeFileSync(join(root, "current.conf"), config);
    writeFileSync(join(root, "cold-9343"), placement.bindingTag + "\n");
    writeFileSync(join(bin, "hostname"), "#!/bin/sh\nprintf '%s\\n' qa-source\n", { mode: 0o700 });
    writeFileSync(join(bin, "qm"), "#!/bin/sh\ncase \"$1\" in status) echo \"status: $TEST_STATUS\";; config) cat \"$TEST_CONFIG\";; *) exit 65;; esac\n",
      { mode: 0o700 });
    const command = buildPortableKvmSourceProfileCheck(placement, launchProfile)
      .replaceAll("/etc/pve/qemu-server", root).replaceAll("/var/lib/hivra-sleep", root)
      .replaceAll("/run/qemu-server", root).replace("marker.stat().st_uid != 0", `marker.stat().st_uid != ${process.getuid?.() ?? 0}`);
    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf8", timeout: 5000, env: { NODE_ENV: "test", PATH: bin + ":/usr/bin:/bin",
        TEST_STATUS: status, TEST_CONFIG: join(root, "current.conf") },
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
  const allocationOperationId = "33333333-3333-4333-8333-333333333333";
  const allocationTag = "hivra-op-" + allocationOperationId.replaceAll("-", "");
  const ordinary = approved.replace("cpu: x86-64-v2-AES", "cpu: host").replace(",firewall=1", "")
    .replace(placement.bindingTag, placement.bindingTag + ";" + allocationTag) +
    "cpulimit: 2\nserial0: socket\nvga: serial0\n" +
    "ide2: local-lvm:vm-9343-cloudinit,media=cdrom\nciuser: ubuntu\nciupgrade: 0\n" +
    "ipconfig0: ip=192.0.2.43/24,gw=192.0.2.1\nnameserver: 192.0.2.53\n";
  const measured: Parameters<typeof buildPortableKvmSourceProfileCheck>[1] = { ...profile, managed: {
    allocationOperationId,
    cpu: { vendor: "GenuineIntel", requiredFlags: ["aes", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] },
    cpuLimit: 2, cloudInit: { instanceId: "1".repeat(40), gateway: "192.0.2.1", nameservers: ["192.0.2.53"] },
  } };
  expect(eligible(ordinary, "stopped", measured)).toBe(true);
  expect(eligible(ordinary.replace(";" + allocationTag, ""), "stopped", measured)).toBe(false);
  expect(eligible(ordinary.replace(allocationTag, "hivra-op-" + "9".repeat(32)), "stopped", measured)).toBe(false);
  expect(eligible(ordinary.replace(placement.bindingTag, "hivra-bind-" + "9".repeat(32)), "stopped", measured)).toBe(false);
  expect(eligible(ordinary + "cicustom: user=local:snippets/arbitrary.yaml\n", "stopped", measured)).toBe(false);
  expect(eligible(ordinary.replace("serial0: socket", "serial0: /dev/ttyS0"), "stopped", measured)).toBe(false);
  expect(eligible(ordinary.replace("ip=192.0.2.43", "ip=192.0.2.44"), "stopped", measured)).toBe(false);
  const resources = { ...measured, managed: { ...measured.managed!, resources: { balloonMb: 2048, cpuUnits: 100 } } };
  const current = ordinary + "balloon: 2048\ncpuunits: 100\n";
  const cache = "cicustom: vendor=local:snippets/hivra-qga-9343-" + allocationOperationId + ".yaml\n";
  const section = "\n[special:cloudinit]\n" + cache;
  expect(eligible(current, "stopped", resources, current + section)).toBe(true);
  for (const bad of [
    section.replace("9343", "9344"), section.replace(allocationOperationId, "00000000-0000-4000-8000-000000000009"),
    section + "nameserver: 192.0.2.53\n", section + section, section.replace("[special:cloudinit]", "[PENDING]"),
    section.replace("vendor=", "user="), "\n[saved]\nvmstate: local-lvm:vm-9343-state\n",
  ]) {
    expect(eligible(current, "stopped", resources, current + bad)).toBe(false);
  }
  expect(eligible(current + cache, "stopped", resources)).toBe(false);
  expect(eligible(current, "stopped", resources, current.replace("balloon: 2048", "balloon: 1024") + section)).toBe(false);
  expect(eligible(current.replace("cpuunits: 100", "cpuunits: 50"), "stopped", resources)).toBe(false);
  expect(eligible(current.replace("balloon: 2048", "balloon: 1024"), "stopped", resources)).toBe(false);
  expect(eligible(current, "stopped", measured)).toBe(false);
});
