/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_PROXMOX_HOST_CAPACITY_POLICY } from "@/lib/infrastructure/host-capacity-policy";
import { phase1Script } from "@/lib/hivra/launch-agent";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_TAG = `hivra-bind-${"a".repeat(32)}`;
const MANAGED_PATHS = {
  provisionerDirectory: "/opt/hivra/provisioner",
  storage: "local-lvm",
  bridge: "hivra0",
  ubuntuImage: "/var/lib/vz/template/iso/hivra-ubuntu-jammy.img",
  vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
  logDirectory: "/var/log/hivra",
};

it("revalidates the selected Canary seal while holding the allocation lock, before VM selection and handoff", () => {
  const script = renderedPhase1(false, "2026.11.25.2");
  const seal = script.indexOf("OBSERVED_MANIFEST_SHA=");
  expect(seal).toBeGreaterThan(script.indexOf("flock -w"));
  expect(seal).toBeLessThan(script.indexOf("local_vmids="));
  expect(seal).toBeLessThan(script.indexOf("SECRET_ENV_FILE="));
  expect(script).toContain("'2026.11.25.2') EXPECTED_MANIFEST_SHA=");
  expect(script).not.toContain("'2026.11.26.1') EXPECTED_MANIFEST_SHA=");
  expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
});

function renderedPhase1(portableRuntime: boolean, canaryProvisionerVersion?: string, agentKind = "codex") {
  return phase1Script({
    cpu: 2,
    cpuLimit: 2,
    memMb: 4096,
    guaranteedMemMb: 4096,
    agentKind,
    tunnelToken: "",
    tunnelUrl: "",
    wantBrowser: false,
    subnetPrefix: "10.251.20",
    gateway: "10.251.20.1",
    vmidStart: 200,
    vmidEnd: 204,
    reservedVmids: [],
    ipLastOctetStart: 50,
    operationId: OPERATION_ID,
    infrastructureBindingTag: BINDING_TAG,
    managedRuntimePaths: MANAGED_PATHS,
    canaryProvisionerVersion,
    portableRuntime: portableRuntime
      ? {
          node: "pve-synthetic",
          bridge: "hivra0",
          storage: "local-lvm",
          vmidStart: 200,
          vmidEnd: 204,
          ipLastOctetStart: 50,
          subnetPrefix: "10.251.20",
          gateway: "10.251.20.1",
          provisionerDirectory: "/opt/hivra/provisioner",
          provisionerVersion: "synthetic",
          ubuntuImage: "/var/lib/vz/template/iso/hivra-ubuntu-jammy.img",
          vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
          logDirectory: "/var/log/hivra",
        }
      : null,
    capacityPolicy: DEFAULT_PROXMOX_HOST_CAPACITY_POLICY,
    catalogAppSpec: null,
  });
}

describe("host allocation lock lifecycle", () => {
  it("enables batched capacity reads only for managed Hermes on the reviewed Canary release", () => {
    const script = renderedPhase1(false, "2026.11.27.3", "hermes");
    const admission = script.indexOf("HIVRA_CAPACITY_BATCH_QEMU=1 bash ");
    expect(admission).toBeGreaterThan(script.indexOf("flock -w"));
    expect(admission).toBeGreaterThan(script.indexOf("OBSERVED_MANIFEST_SHA="));
    expect(admission).toBeLessThan(script.indexOf("claimed_octets="));
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    expect(renderedPhase1(false, "2026.11.27.2", "hermes")).not.toContain("HIVRA_CAPACITY_BATCH_QEMU");
    expect(renderedPhase1(false, "2026.11.27.3", "codex")).not.toContain("HIVRA_CAPACITY_BATCH_QEMU");
    expect(renderedPhase1(true, undefined, "hermes")).not.toContain("HIVRA_CAPACITY_BATCH_QEMU");
  });

  it("reads managed Hermes IP claims in one pmxcfs scan under the allocation lock", () => {
    const script = renderedPhase1(false, undefined, "hermes");
    const start = script.indexOf('claimed_octets="$(');
    const end = script.indexOf('claimed_octets="$(printf', start);
    expect(start).toBeGreaterThan(script.indexOf("flock -w"));
    expect(end).toBeGreaterThan(start);
    expect(script).not.toContain("qm list");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    const root = mkdtempSync(path.join(tmpdir(), "hivra-ip-claims-"));
    try {
      const fragment = script.slice(start, end)
        .replaceAll("/etc/pve/qemu-server", root)
        .replaceAll("/var/lib/hivra/provision-operations", root);
      const run = () => spawnSync("bash", ["-c", `set -euo pipefail
${fragment}
printf '%s' "$claimed_octets"`], { encoding: "utf8" });
      expect(run()).toMatchObject({ status: 0, stdout: "" });
      writeFileSync(path.join(root, "200.conf"), [
        "description: ip=10.251.20.99/24",
        "ipconfig0: ip=10.251.20.50/24,gw=10.251.20.1",
        "ipconfig1: ip6=auto,ip=10.251.20.51/24",
        "[backup]",
        "ipconfig0: ip=10.251.20.98/24",
        "[PENDING]",
        "ipconfig0: gw=10.251.20.1,ip=10.251.20.52/24",
      ].join("\n"));
      writeFileSync(path.join(root, "201.conf"), "ipconfig0: ip=dhcp\n");
      writeFileSync(path.join(root, "operation-one.selected"), "ip=10.251.20.53\n");
      expect(run()).toMatchObject({ status: 0, stdout: "50\n51\n52\n53" });
      rmSync(root, { recursive: true });
      expect(run()).toMatchObject({ status: 1, stdout: "", stderr: expect.stringContaining("inventory is unavailable") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches the managed guardian's exact child argv with the selected VMID expanded at runtime", () => {
    const script = renderedPhase1(false);
    const line = script.split("\n").find(entry => entry.includes('grep -Fq') && entry.includes("hivra-provision-on-host.sh"));
    expect(line?.trim()).toBe('printf \'%s\' "$cmd" | grep -Fq "hivra-provision-on-host.sh $VMID " || return 1');
    const predicate = line!.trim().replace(/ \|\| return 1$/, "");
    for (const [vmid, argvVmid, expected] of [["200", "200", 0], ["200", "201", 1]] as const) {
      const result = spawnSync("bash", ["-c", `set -u
VMID=${vmid}
cmd='bash /opt/hivra/provisioner/hivra-provision-on-host.sh ${argvVmid} 50 2 4096 codex'
check_child() { local cmd="$cmd"; ${predicate}; }
check_child`], { encoding: "utf8" });
      expect({ vmid, argvVmid, status: result.status, stderr: result.stderr }).toEqual({ vmid, argvVmid, status: expected, stderr: "" });
    }
  });

  it.each([
    ["provision", "provisioner/hivra-provision-on-host.sh"],
    ["wake", "provisioner/hivra-start-on-host.sh"],
  ])("closes FD9 as well as FD8 before qm can fork a long-lived guest (%s)", (_name, file) => {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    const line = source.match(/qm start "\$VMID"[^;\n]*/)?.[0];
    expect(line).toContain("8>&- 9>&-");

    const root = mkdtempSync(path.join(tmpdir(), "hivra-lock-fds-"));
    try {
      const bin = path.join(root, "bin");
      writeFileSync(path.join(root, "lock"), "");
      writeFileSync(path.join(root, "qm"), `#!/usr/bin/env bash
if [ -e /dev/fd/9 ]; then echo open > ${JSON.stringify(root)}/fd9-state; else echo closed > ${JSON.stringify(root)}/fd9-state; fi
if [ -e /dev/fd/8 ]; then echo open > ${JSON.stringify(root)}/fd8-state; else echo closed > ${JSON.stringify(root)}/fd8-state; fi
`);
      chmodSync(path.join(root, "qm"), 0o700);
      writeFileSync(path.join(root, "run-qm"), `#!/usr/bin/env bash
set -euo pipefail
export PATH=${JSON.stringify(root)}:$PATH
VMID=200
exec 8>${JSON.stringify(root)}/lock
exec 9>${JSON.stringify(root)}/lock
${line!.trim()}
`);
      chmodSync(path.join(root, "run-qm"), 0o700);
      const result = spawnSync("bash", [path.join(root, "run-qm")], { encoding: "utf8" });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(readFileSync(path.join(root, "fd8-state"), "utf8").trim()).toBe("closed");
      expect(readFileSync(path.join(root, "fd9-state"), "utf8").trim()).toBe("closed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a strict versioned durable resource reservation without changing the serialized lock path", () => {
    const script = renderedPhase1(true);
    for (const line of [
      "printf 'schema_version=%s\\n' 1",
      "printf 'floor_memory_mb=%s\\n' 4096",
      "printf 'maximum_memory_mb=%s\\n' 4096",
      "printf 'maximum_cpu_milli=%s\\n' 2000",
      "printf 'disk_gb=%s\\n' 40",
      "printf 'storage=%s\\n' 'local-lvm'",
    ]) {
      expect(script).toContain(line);
    }
    expect(script.indexOf('mv -f -- "$INTENT_TMP" "$INTENT_FILE"')).toBeLessThan(script.indexOf("nohup env HIVRA_PID_FILE="));
    expect(script).toContain("HIVRA_ALLOCATION_LOCK_FD=8");
    expect(script).toContain("hivra-host-capacity-admission' - 4096 4096 2 2048 0 1000 1000 0 'local-lvm' 40 5");
    expect(script).toContain("STORAGE_REQUIRED_KB=$(((40 + 5) * 1024 * 1024))");
  });

});
