/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PVE_QEMU_CONFIG_DIR,
  buildHivraComputerUsageScript,
  parseHivraComputerUsageOutput,
  proxmoxUsageView,
  readStoredUsage,
  statusOnlyUsageView,
  storedUsageFor,
  type HivraComputerUsageIdentity,
  type HivraUsageProbeSample,
} from "../computer-usage";
import { ComputerUsageViewSchema, formatUptime, formatUsageAge, formatUsageGb } from "../computer-usage-contract";
import {
  BINDING_TAG,
  CLUSTER_RESOURCES,
  CONFIG_1109,
  CONFIG_1113,
  CONFIG_2098,
  CONFIG_2099,
  FIXTURE_NODE,
  FSINFO_1113,
  FSINFO_2098,
  FSINFO_2099,
  PREPARED_CLAIM,
  QGA_NOT_RUNNING_1109,
  USAGE_LINE_1113,
} from "./fixtures/proxmox-usage-captures";

// The live-usage host script and its parser, run against what a Proxmox VE 9.2
// host really printed. The script runs here in bash with stub qm, pvesh,
// timeout and hostname commands and the host's own filter (Perl + JSON::PP).

const bound = (vmid: number): HivraComputerUsageIdentity => ({ vmid, bindingTag: BINDING_TAG, legacyName: null, prepared: null });

type Host = {
  config?: string;
  resources?: string;
  fsinfo?: string | null;
  /** Exit code of `qm guest cmd` when there is no fsinfo (2 = not running). */
  guestExit?: number;
  guestMessage?: string;
  node?: string;
  /** The VM's config file exists on the host. */
  present?: boolean;
};

function runOnHost(script: string, vmid: number, host: Host) {
  const work = mkdtempSync(path.join(tmpdir(), "hivra-usage-"));
  try {
    const bin = path.join(work, "bin");
    const confDir = path.join(work, "qemu-server");
    spawnSync("mkdir", ["-p", bin, confDir]);
    if (host.present !== false) writeFileSync(path.join(confDir, `${vmid}.conf`), host.config ?? "");
    writeFileSync(path.join(work, "config"), host.config ?? "");
    writeFileSync(path.join(work, "resources"), host.resources ?? "[]");
    if (host.fsinfo) writeFileSync(path.join(work, "fsinfo"), host.fsinfo);
    const log = path.join(work, "calls.log");
    const stub = (name: string, body: string) => {
      const file = path.join(bin, name);
      writeFileSync(file, `#!/bin/bash\nprintf '%s %s\\n' ${name} "$*" >> ${JSON.stringify(log)}\n${body}\n`);
      chmodSync(file, 0o755);
    };
    stub("qm", `case "$1" in
  config) cat ${JSON.stringify(path.join(work, "config"))} ;;
  guest) if [ -f ${JSON.stringify(path.join(work, "fsinfo"))} ]; then cat ${JSON.stringify(path.join(work, "fsinfo"))}; else echo ${JSON.stringify(host.guestMessage ?? "VM is not running")} >&2; exit ${host.guestExit ?? 2}; fi ;;
  *) exit 99 ;;
esac`);
    stub("pvesh", `cat ${JSON.stringify(path.join(work, "resources"))}`);
    stub("timeout", `shift; exec "$@"`);
    stub("hostname", `echo ${host.node ?? `${FIXTURE_NODE}.example.test`}`);
    const result = spawnSync("bash", ["-s"], {
      input: script.replaceAll(PVE_QEMU_CONFIG_DIR, confDir),
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: work } as unknown as NodeJS.ProcessEnv,
      timeout: 20_000,
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("buildHivraComputerUsageScript", () => {
  it("checks the exact binding tag before printing anything, and never changes the computer", () => {
    const script = buildHivraComputerUsageScript(bound(1113));
    expect(script).toContain(`EXPECTED_BINDING_TAG='${BINDING_TAG}'`);
    expect(script).toContain('grep -Fxq -- "$EXPECTED_BINDING_TAG"');
    expect(script.indexOf("HIVRA_USAGE_BINDING_MISMATCH")).toBeLessThan(script.indexOf("/usr/bin/perl"));
    // Read-only: no lock, no lease, no power, config, guest program or file writes.
    for (const forbidden of ["qm set", "qm stop", "qm shutdown", "qm start", "qm reboot", "flock", "exec 8", "qm guest exec", "mktemp", "rm -", "> /"]) {
      expect(script).not.toContain(forbidden);
    }
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })).toMatchObject({ status: 0, stderr: "" });
  });

  it("guards an older computer without a binding tag by its exact VM name", () => {
    const script = buildHivraComputerUsageScript({ vmid: 1104, bindingTag: null, legacyName: "hivra-cc-1104", prepared: null });
    expect(script).toContain("EXPECTED_BINDING_TAG=''");
    expect(script).toContain("EXPECTED_NAME='hivra-cc-1104'");
    expect(script).toContain('grep -Fxq -- "name: $EXPECTED_NAME"');
  });

  it("guards a prepared computer by its claim marker and VM name", () => {
    const script = buildHivraComputerUsageScript({
      vmid: 2098, bindingTag: BINDING_TAG, legacyName: null,
      prepared: { encodedMarker: `hivra-windows-operation%3A${PREPARED_CLAIM}`, plainMarker: `hivra-windows-operation:${PREPARED_CLAIM}`, name: "hivra-windows-canary" },
    });
    expect(script).toContain(`EXPECTED_MARKER_ENCODED='hivra-windows-operation%3A${PREPARED_CLAIM}'`);
    expect(script).toContain("EXPECTED_NAME='hivra-windows-canary'");
  });

  it.each([
    ["no identity at all", { vmid: 1113, bindingTag: null, legacyName: null, prepared: null }],
    ["a malformed binding tag", { vmid: 1113, bindingTag: "hivra-bind-x'; reboot; '", legacyName: null, prepared: null }],
    ["another VM's legacy name", { vmid: 1113, bindingTag: null, legacyName: "hivra-cc-1104", prepared: null }],
    ["a VMID below the Proxmox range", { vmid: 7, bindingTag: BINDING_TAG, legacyName: null, prepared: null }],
    ["a malformed prepared marker", { vmid: 2098, bindingTag: null, legacyName: null, prepared: { encodedMarker: "x", plainMarker: "y", name: "hivra-windows-canary" } }],
  ])("refuses to build a read with %s", (_case, identity) => {
    expect(() => buildHivraComputerUsageScript(identity as HivraComputerUsageIdentity)).toThrow(/usage_identity/);
  });
});

describe("the usage script on a Proxmox VE 9.2 host (captured output)", () => {
  it("prints exactly one whitelisted line for a running Ubuntu computer", () => {
    const result = runOnHost(buildHivraComputerUsageScript(bound(1113)), 1113, {
      config: CONFIG_1113, resources: CLUSTER_RESOURCES, fsinfo: FSINFO_1113,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${USAGE_LINE_1113}\n`);
    // Only reads ran.
    expect(result.calls.trim().split("\n").map((call) => call.trim()).sort()).toEqual([
      "hostname",
      "pvesh get /cluster/resources --type vm --output-format json",
      "qm config 1113",
      "qm guest cmd 1113 get-fsinfo",
      "timeout 10 pvesh get /cluster/resources --type vm --output-format json",
      "timeout 6 qm guest cmd 1113 get-fsinfo",
    ]);
    // Nothing about another computer, a tag, a disk name or a snap mount leaves the host.
    for (const leaked of ["1130", "other-customer", "hivra-bind", "hivra-op", "local-lvm", "squashfs", "/snap", "QEMU_HARDDISK", FIXTURE_NODE]) {
      expect(result.stdout).not.toContain(leaked);
    }
    const parsed = parseHivraComputerUsageOutput(result.stdout);
    expect(parsed).toEqual({ kind: "sample", sample: JSON.parse(USAGE_LINE_1113.slice("HIVRA_USAGE_V1 ".length)) });
  });

  it("reads a prepared Windows computer's C: drive and its 64G SATA boot disk", () => {
    const script = buildHivraComputerUsageScript({
      vmid: 2098, bindingTag: BINDING_TAG, legacyName: null,
      prepared: { encodedMarker: `hivra-windows-operation%3A${PREPARED_CLAIM}`, plainMarker: `hivra-windows-operation:${PREPARED_CLAIM}`, name: "hivra-windows-canary" },
    });
    const result = runOnHost(script, 2098, { config: CONFIG_2098, resources: CLUSTER_RESOURCES, fsinfo: FSINFO_2098 });
    const parsed = parseHivraComputerUsageOutput(result.stdout);
    expect(parsed.kind).toBe("sample");
    const sample = (parsed as { sample: HivraUsageProbeSample }).sample;
    expect(sample.guest.root).toEqual({ mount: "C:\\", fs: "NTFS", total: 67523047424, used: 27970359296 });
    expect(sample.config).toMatchObject({ diskBytes: 64 * 1024 ** 3, ostype: "win11", agent: true, balloon: null });
    expect(sample.vm).toMatchObject({ status: "running", mem: 3400466432, maxdisk: 68719476736 });
    expect(result.stdout).not.toContain("Volume{");
  });

  it("reads an Omarchy computer's btrfs root and skips its attached ISOs for the disk size", () => {
    const script = buildHivraComputerUsageScript({
      vmid: 2099, bindingTag: null, legacyName: null,
      prepared: { encodedMarker: `hivra-omarchy-operation%3A${PREPARED_CLAIM}`, plainMarker: `hivra-omarchy-operation:${PREPARED_CLAIM}`, name: "hivra-omarchy-canary" },
    });
    const result = runOnHost(script, 2099, { config: CONFIG_2099, resources: CLUSTER_RESOURCES, fsinfo: FSINFO_2099 });
    const sample = (parseHivraComputerUsageOutput(result.stdout) as { sample: HivraUsageProbeSample }).sample;
    expect(sample.guest.root).toEqual({ mount: "/", fs: "btrfs", total: 40353300480, used: 26912878592 });
    expect(sample.config.diskBytes).toBe(40 * 1024 ** 3);
    expect(sample.vm?.cpu).toBeCloseTo(0.1317, 4);
  });

  it("reports a stopped computer without a guest agent answer", () => {
    const script = buildHivraComputerUsageScript(bound(1109));
    const result = runOnHost(script, 1109, {
      config: CONFIG_1109, resources: CLUSTER_RESOURCES, fsinfo: null, guestExit: 2, guestMessage: QGA_NOT_RUNNING_1109,
    });
    const sample = (parseHivraComputerUsageOutput(result.stdout) as { sample: HivraUsageProbeSample }).sample;
    expect(sample.vm).toEqual({ status: "stopped", uptime: 0, cpu: 0, maxcpu: 2, mem: 0, maxmem: 4294967296, maxdisk: 42949672960 });
    expect(sample.guest).toEqual({ rc: 2, readable: false, root: null });
    expect(result.stdout).not.toContain("not running");
  });

  it("reports a guest agent that timed out", () => {
    const result = runOnHost(buildHivraComputerUsageScript(bound(1113)), 1113, {
      config: CONFIG_1113, resources: CLUSTER_RESOURCES, fsinfo: null, guestExit: 124,
    });
    const sample = (parseHivraComputerUsageOutput(result.stdout) as { sample: HivraUsageProbeSample }).sample;
    expect(sample.guest).toEqual({ rc: 124, readable: false, root: null });
    expect(sample.vm?.status).toBe("running");
  });

  it("keeps nothing from /cluster/resources when the entry is on another node", () => {
    const result = runOnHost(buildHivraComputerUsageScript(bound(1113)), 1113, {
      config: CONFIG_1113, resources: CLUSTER_RESOURCES, fsinfo: FSINFO_1113, node: "fixturenode12",
    });
    const sample = (parseHivraComputerUsageOutput(result.stdout) as { sample: HivraUsageProbeSample }).sample;
    expect(sample.vm).toBeNull();
    expect(sample.resources).toBe(true);
  });

  it("says so when /cluster/resources can't be read", () => {
    const result = runOnHost(buildHivraComputerUsageScript(bound(1113)), 1113, {
      config: CONFIG_1113, resources: "pvesh: connection refused", fsinfo: FSINFO_1113,
    });
    const sample = (parseHivraComputerUsageOutput(result.stdout) as { sample: HivraUsageProbeSample }).sample;
    expect(sample).toMatchObject({ vm: null, resources: false });
  });

  it("prints only the mismatch marker when the binding tag isn't on the computer", () => {
    const result = runOnHost(buildHivraComputerUsageScript({ ...bound(1113), bindingTag: `hivra-bind-${"d".repeat(32)}` }), 1113, {
      config: CONFIG_1113, resources: CLUSTER_RESOURCES, fsinfo: FSINFO_1113,
    });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("HIVRA_USAGE_BINDING_MISMATCH\n");
    expect(parseHivraComputerUsageOutput(result.stdout)).toEqual({ kind: "binding_mismatch" });
  });

  it("refuses an older computer whose VM name doesn't match", () => {
    const result = runOnHost(buildHivraComputerUsageScript({ vmid: 1113, bindingTag: null, legacyName: "hivra-cc-1113", prepared: null }), 1113, {
      config: CONFIG_1113.replace("name: hivra-cc-1113", "name: someone-elses-vm"), resources: CLUSTER_RESOURCES, fsinfo: FSINFO_1113,
    });
    expect(result.stdout).toBe("HIVRA_USAGE_BINDING_MISMATCH\n");
  });

  it("refuses a prepared computer without its claim marker", () => {
    const script = buildHivraComputerUsageScript({
      vmid: 2098, bindingTag: null, legacyName: null,
      prepared: { encodedMarker: `hivra-windows-operation%3A${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`, plainMarker: `hivra-windows-operation:${"1".repeat(8)}-1111-4111-8111-${"1".repeat(12)}`, name: "hivra-windows-canary" },
    });
    const result = runOnHost(script, 2098, { config: CONFIG_2098, resources: CLUSTER_RESOURCES, fsinfo: FSINFO_2098 });
    expect(result.stdout).toBe("HIVRA_USAGE_BINDING_MISMATCH\n");
  });

  it("says the computer is missing when the host has no config for it, without reading anything", () => {
    const result = runOnHost(buildHivraComputerUsageScript(bound(1113)), 1113, { present: false, config: CONFIG_1113, resources: CLUSTER_RESOURCES });
    expect(result).toMatchObject({ status: 0, stdout: "HIVRA_USAGE_VM_MISSING\n", calls: "" });
    expect(parseHivraComputerUsageOutput(result.stdout)).toEqual({ kind: "missing" });
  });
});

describe("parseHivraComputerUsageOutput", () => {
  const body = JSON.parse(USAGE_LINE_1113.slice("HIVRA_USAGE_V1 ".length));
  const line = (value: unknown) => `HIVRA_USAGE_V1 ${JSON.stringify(value)}`;

  it("clamps CPU to at most the whole computer", () => {
    const parsed = parseHivraComputerUsageOutput(line({ ...body, vm: { ...body.vm, cpu: 1.4 } }));
    expect((parsed as { sample: HivraUsageProbeSample }).sample.vm?.cpu).toBe(1);
  });

  it.each([
    ["empty output", ""],
    ["an unknown marker", "HIVRA_USAGE_SOMETHING_ELSE"],
    ["two lines", `${USAGE_LINE_1113}\n${USAGE_LINE_1113}`],
    ["a line that isn't JSON", "HIVRA_USAGE_V1 {not json"],
    ["NaN", USAGE_LINE_1113.replace("0.0109749940154479", "NaN")],
    ["a negative number", line({ ...body, vm: { ...body.vm, mem: -1 } })],
    ["an unexpected field", line({ ...body, vm: { ...body.vm, name: "hivra-cc-1113" } })],
    ["another mount point", line({ ...body, guest: { ...body.guest, root: { ...body.guest.root, mount: "/snap/lxd" } } })],
    ["an oversized line", line({ ...body, config: { ...body.config, ostype: "x".repeat(9000) } })],
    ["another version", line({ ...body, v: 2 })],
  ])("rejects %s", (_case, stdout) => {
    expect(() => parseHivraComputerUsageOutput(stdout)).toThrow();
  });
});

describe("proxmoxUsageView", () => {
  const now = new Date("2026-09-25T12:00:30.000Z");
  const observedAt = "2026-09-25T12:00:18.000Z";
  const sample = (parseHivraComputerUsageOutput(USAGE_LINE_1113) as { sample: HivraUsageProbeSample }).sample;
  const view = (overrides: Partial<Parameters<typeof proxmoxUsageView>[0]> = {}) => proxmoxUsageView({
    stored: storedUsageFor({ kind: "sample", sample }, "running"),
    observedAt, recordedStatus: "running", now, refreshing: false, hostUnreachable: false, ...overrides,
  });

  it("derives CPU, memory, disk and uptime from the captured 1113 read", () => {
    const result = view();
    expect(ComputerUsageViewSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      supported: true, source: "proxmox", observedAt, ageSeconds: 12, stale: false,
      power: { observed: "running", recorded: "running", matches: true },
      uptimeSeconds: 688433,
      cpu: { percent: 1.1, vcpus: 4 },
      memory: { usedBytes: 4209631232, maximumBytes: 8589934592, includesCache: true },
      disk: { usedBytes: 21686575104, sizeBytes: 41412915200, allocatedBytes: 42949672960, filesystem: "ext4", guestReported: true },
      notes: [],
    });
    expect(formatUptime(result.uptimeSeconds ?? 0)).toBe("7 days 23 hours");
    expect(formatUsageGb(result.memory?.usedBytes ?? 0)).toBe("3.9");
    expect(formatUsageGb(result.disk?.usedBytes ?? 0)).toBe("20.2");
    expect(formatUsageGb(result.disk?.allocatedBytes ?? 0)).toBe("40");
  });

  it("says the guest agent didn't answer while the computer runs, and still gives the disk size", () => {
    const result = view({ stored: storedUsageFor({ kind: "sample", sample: { ...sample, guest: { rc: 124, readable: false, root: null } } }, "running") });
    expect(result.notes).toEqual(["guest_agent_unavailable"]);
    expect(result.disk).toEqual({ usedBytes: null, sizeBytes: null, allocatedBytes: 42949672960, filesystem: null, guestReported: false });
  });

  it("reports a stopped computer without CPU, memory or uptime, and no guest note", () => {
    const stopped = { ...sample, vm: { ...sample.vm!, status: "stopped", uptime: 0, cpu: 0, mem: 0 }, guest: { rc: 2, readable: false, root: null } };
    const result = view({ stored: storedUsageFor({ kind: "sample", sample: stopped }, "stopped"), recordedStatus: "stopped" });
    expect(result).toMatchObject({ power: { observed: "stopped", matches: true }, uptimeSeconds: null, cpu: null, memory: null, notes: [] });
    expect(result.disk?.allocatedBytes).toBe(42949672960);
  });

  it("flags a computer Hivra records as on but its host has switched off", () => {
    const stopped = { ...sample, vm: { ...sample.vm!, status: "stopped", uptime: 0 } };
    expect(view({ stored: storedUsageFor({ kind: "sample", sample: stopped }, "running") }).power).toEqual({ observed: "stopped", recorded: "running", matches: false });
  });

  it("doesn't compare while the computer is starting or being set up", () => {
    expect(view({ stored: storedUsageFor({ kind: "sample", sample }, "provisioning"), recordedStatus: "provisioning" }).power.matches).toBeNull();
  });

  it("marks an observation from before the computer's last state change as out of date, without claiming a mismatch", () => {
    const result = view({ recordedStatus: "stopped" });
    expect(result).toMatchObject({ stale: true, power: { observed: "running", recorded: "stopped", matches: null } });
    expect(result.notes).toContain("status_changed");
  });

  it("says a missing computer is missing", () => {
    const result = view({ stored: storedUsageFor({ kind: "missing" }, "stopped"), recordedStatus: "stopped" });
    expect(result).toMatchObject({ power: { observed: "missing", matches: true }, cpu: null, disk: null, notes: ["vm_missing"] });
  });

  it("keeps the last read when the host is unreachable, and says it is old", () => {
    const result = view({ hostUnreachable: true, now: new Date("2026-09-25T12:05:18.000Z") });
    expect(result).toMatchObject({ ageSeconds: 300, stale: true, notes: ["host_unreachable"], cpu: { percent: 1.1 } });
    expect(formatUsageAge(result.ageSeconds ?? 0)).toBe("5 min ago");
  });

  it("gives an empty view before the first read", () => {
    expect(view({ stored: null, observedAt: null, refreshing: true })).toMatchObject({
      observedAt: null, ageSeconds: null, stale: true, refreshing: true, power: { observed: "unknown", matches: null }, cpu: null,
    });
  });

  it("re-validates what it reads back from the cache", () => {
    const stored = storedUsageFor({ kind: "sample", sample }, "running");
    expect(readStoredUsage(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readStoredUsage({ ...stored, host: "fixturenode11" })).toBeNull();
    expect(readStoredUsage({ v: 1, result: "sample", recordedStatus: "running", sample: { ...sample, vm: { ...sample.vm, mem: -5 } } })).toBeNull();
    expect(readStoredUsage("HIVRA_USAGE_V1")).toBeNull();
  });
});

describe("statusOnlyUsageView", () => {
  it("says why there is no live usage and gives the size on record", () => {
    const result = statusOnlyUsageView({ source: "hetzner", reason: "Live usage isn't available for My cloud computers yet.", recordedStatus: "running", size: { cpu: 2, ramGb: 4 } });
    expect(ComputerUsageViewSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ supported: false, source: "hetzner", size: { cpu: 2, ramGb: 4 }, cpu: null, power: { observed: "unknown", recorded: "running" } });
  });
});
