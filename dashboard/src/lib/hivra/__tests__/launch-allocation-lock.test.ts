/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function renderedPhase1(
  portableRuntime: boolean, canaryProvisionerVersion?: string, agentKind = "codex",
  preparedImage?: Parameters<typeof phase1Script>[0]["preparedImage"],
) {
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
    preparedImage,
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

it("checks the selected digest, immutable file and standalone qcow2 before any allocation", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "hivra-deepseek-image-"));
  try {
    const content = "fixture image";
    const digest = createHash("sha256").update(content).digest("hex");
    const file = path.join(fixture, `hivra-deepseek-harness-${digest}.qcow2`);
    writeFileSync(file, content);
    const script = renderedPhase1(false, "2026.11.27.4", "deepseek-harness", { kind: "deepseek-harness", digest });
    const begin = script.indexOf("PREPARED_IMAGE=");
    const end = script.indexOf("# Inventory is intentionally", begin);
    expect(begin).toBeGreaterThan(script.indexOf("OBSERVED_MANIFEST_SHA="));
    expect(end).toBeGreaterThan(begin);
    const gate = script.slice(begin, end).replace("/var/lib/vz/template/iso", fixture);
    const run = (info: object, mode = "0:0:444:1") => spawnSync("bash", ["-s"], {
      input: `set -euo pipefail
stat() { echo "$MODE"; }
qemu-img() { printf '%s' "$IMAGE_INFO"; }
${gate}`,
      env: { ...process.env, MODE: mode, IMAGE_INFO: JSON.stringify(info) },
      encoding: "utf8",
    });
    const good = { format: "qcow2", "virtual-size": 8 * 1024 ** 3 };
    expect(run(good).status).toBe(0);
    expect(run(good, "0:0:644:1").status).toBe(1);
    expect(run({ ...good, "backing-filename": "other.img" }).status).toBe(1);
    expect(run({ ...good, "format-specific": { data: { "data-file": "other.img" } } }).status).toBe(1);
    expect(run({ ...good, "virtual-size": 1 }).status).toBe(1);
    writeFileSync(file, "different");
    expect(run(good).status).toBe(1);
    rmSync(file);
    writeFileSync(path.join(fixture, "elsewhere"), content);
    symlinkSync("elsewhere", file);
    expect(run(good).status).toBe(1);
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

it("keeps the prepared Ubuntu disk within the five stock-agent profiles and the managed .4 bundle", () => {
  const image = { kind: "ubuntu-qga", digest: "a".repeat(64) } as const;
  for (const kind of ["claude", "codex", "openclaw", "deepseek-harness", "agent-zero"]) {
    const script = renderedPhase1(false, "2026.11.27.4", kind, image);
    expect(script).toContain(`HIVRA_UBUNTU_IMG='/var/lib/vz/template/iso/hivra-ubuntu-qga-${image.digest}.qcow2'`);
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    expect(renderedPhase1(true, "2026.11.27.4", kind, image)).not.toContain("PREPARED_IMAGE=");
    expect(renderedPhase1(false, "2026.11.27.3", kind, image)).not.toContain("PREPARED_IMAGE=");
  }
  expect(renderedPhase1(false, "2026.11.27.4", "hermes", image)).not.toContain("PREPARED_IMAGE=");
});

describe("host allocation lock lifecycle", () => {
  it.each(["hermes", "claude", "codex", "openclaw", "deepseek-harness", "agent-zero"])(
    "batches capacity and IP reads under the allocation lock for managed %s on the reviewed Canary release", (kind) => {
      for (const version of ["2026.11.27.3", "2026.11.27.4"]) {
        const script = renderedPhase1(false, version, kind);
        const admission = script.indexOf("HIVRA_CAPACITY_BATCH_QEMU=1 bash ");
        expect(admission).toBeGreaterThan(script.indexOf("flock -w"));
        expect(admission).toBeGreaterThan(script.indexOf("OBSERVED_MANIFEST_SHA="));
        expect(admission).toBeLessThan(script.indexOf("claimed_octets="));
        expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
        expect(script).toContain('configs=(/etc/pve/qemu-server/*.conf)');
        expect(script).not.toContain("qm list");
      }
      expect(renderedPhase1(false, "2026.11.27.2", kind)).not.toContain("HIVRA_CAPACITY_BATCH_QEMU");
      expect(renderedPhase1(true, undefined, kind)).not.toContain("HIVRA_CAPACITY_BATCH_QEMU");
    },
  );

  it("keeps the original inventory path for unmeasured profiles", () => {
    const script = renderedPhase1(false, "2026.11.27.3", "linux-desktop");
    expect(script).not.toContain("HIVRA_CAPACITY_BATCH_QEMU");
    expect(script).toContain("qm list");
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

  it("skips both the VMID and private IP of a native portable slot when allocating an ordinary launch", () => {
    const script = renderedPhase1(false, undefined, "hermes");
    const inventoryStart = script.indexOf('cluster_resources="$(');
    const inventoryEnd = script.indexOf('intent_vmids="$(', inventoryStart);
    const pickStart = script.indexOf('claimed_vmids="$(', inventoryEnd);
    const pickEnd = script.indexOf("install -d -m 0750 ", pickStart);
    const root = mkdtempSync(path.join(tmpdir(), "hivra-slot-allocation-"));
    try {
      mkdirSync(path.join(root, "locks"));
      const launch = script.slice(inventoryStart, inventoryEnd) + script.slice(pickStart, pickEnd)
        .replaceAll("/run/lock/hivra-vmids", path.join(root, "locks"))
        .replaceAll("/etc/pve/qemu-server", root)
        .replaceAll("/var/lib/hivra/provision-operations", root);
      const run = (clusterResources: object[]) => spawnSync("bash", ["-s"], {
        input: `set -euo pipefail
pvesh() { printf '%s' "$INVENTORY"; }
RESERVED_VMIDS=
intent_vmids=
${launch}
printf '%s:%s' "$VMID" "$OCTET"`,
        env: { ...process.env, INVENTORY: JSON.stringify(clusterResources) },
        encoding: "utf8",
      });
      expect(run([])).toMatchObject({ status: 0, stdout: "200:50" });
      writeFileSync(path.join(root, "200.conf"), [
        "ipconfig0: ip=10.251.20.51/24", "lock: backup", "name: hivra-slot-200", "onboot: 0",
        `tags: hivra-slot-${"a".repeat(32)}`, "",
      ].join("\n"));
      expect(run([{ vmid: 200, type: "qemu", status: "stopped" }])).toMatchObject({ status: 0, stdout: "201:50" });
      rmSync(path.join(root, "200.conf"));
      expect(run([{ vmid: 200, type: "qemu", status: "stopped" }])).toMatchObject({ status: 0, stdout: "201:51" });
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
