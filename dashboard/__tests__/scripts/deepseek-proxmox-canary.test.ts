import {
  DEEPSEEK_CANARY_ORIGIN,
  assertDeepSeekCanaryAuthorized,
  buildDeepSeekInventoryScript,
  buildDeepSeekLaunchScript,
  buildDeepSeekReadAccessScript,
  buildDeepSeekRestartScript,
  buildDeepSeekTeardownScript,
  parseDeepSeekCanaryArgs,
  type DeepSeekCanaryLedger,
} from "../../scripts/deepseek-proxmox-canary";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = {
  NEXT_PUBLIC_APP_URL: DEEPSEEK_CANARY_ORIGIN,
  HIVRA_DEEPSEEK_LAB_TARGETS: "fixturenode11",
  HIVRA_DEEPSEEK_LAB_TARGET_FIXTURENODE11_VMID_START: "1180",
  HIVRA_DEEPSEEK_LAB_TARGET_FIXTURENODE11_VMID_END: "1189",
  PROXMOX_EXEC_MODE: "ssh",
  PROXMOX_SSH_HOST_FINGERPRINT: "SHA256:fixture",
};

const ledger: DeepSeekCanaryLedger = {
  schemaVersion: 1,
  phase: "launched",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  target: "fixturenode11",
  expectedHostname: "fixturenode11",
  vmid: 1182,
  ip: "10.252.20.82",
  operationId: "00000000-0000-4000-8000-000000001005",
  bindingTag: "hivra-bind-1234567890abcdef1234567890abcdef",
  tunnel: { tunnelId: "00000000-0000-4000-8000-000000001005", hostname: "deepseek.example.com" },
  launch: { url: "https://deepseek.example.com", cpu: 2, memoryMb: 4096 },
};

function executable(filename: string, content: string): void {
  writeFileSync(filename, content, { mode: 0o755 });
}

function runTeardownFixture(params: { claimPresent: boolean; fail?: "qm" | "pvesm"; strandSnippet?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "deepseek-teardown-test-"));
  const fakeBin = join(root, "bin");
  const paths = {
    lock: join(root, "run/lock"),
    provision: join(root, "run/hivra-provision"),
    results: join(root, "var/lib/hivra/provision-results"),
    claims: join(root, "var/lib/hivra/deepseek-canary-claims"),
    snippets: join(root, "var/lib/vz/snippets"),
  };
  for (const directory of [fakeBin, ...Object.values(paths)]) mkdirSync(directory, { recursive: true });
  const fixtureLedger = { ...ledger, expectedHostname: "fixture-host" };
  const claimFile = join(paths.claims, `${fixtureLedger.vmid}.claim`);
  const snippet = join(paths.snippets, `hivra-qga-${fixtureLedger.vmid}-${fixtureLedger.operationId}.yaml`);
  if (params.claimPresent) {
    writeFileSync(claimFile,
      `${fixtureLedger.operationId}|${fixtureLedger.bindingTag}|${fixtureLedger.expectedHostname}|${fixtureLedger.vmid}|${fixtureLedger.ip}\n`,
      { mode: 0o600 });
  }
  if (params.strandSnippet) writeFileSync(snippet, "# interrupted fixture\n", { mode: 0o600 });
  executable(join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' fixture-host\n");
  executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");
  executable(join(fakeBin, "qm"), `#!/bin/sh
if [ "$1" = list ]; then
  [ "\${HIVRA_TEST_FAIL:-}" != qm ] || exit 71
  printf '%s\\n' ' VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID'
  exit 0
fi
exit 72
`);
  executable(join(fakeBin, "pvesm"), `#!/bin/sh
if [ "$1" = list ]; then
  [ "\${HIVRA_TEST_FAIL:-}" != pvesm ] || exit 73
  printf '%s\\n' 'Volid Format Type Size VMID'
  exit 0
fi
exit 74
`);
  const script = buildDeepSeekTeardownScript(fixtureLedger)
    .replaceAll("/run/lock", paths.lock)
    .replaceAll("/run/hivra-provision", paths.provision)
    .replaceAll("/var/lib/hivra/provision-results", paths.results)
    .replaceAll("/var/lib/hivra/deepseek-canary-claims", paths.claims)
    .replaceAll("/var/lib/vz/snippets", paths.snippets);
  const scriptFile = join(root, "teardown.sh");
  writeFileSync(scriptFile, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptFile], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, HIVRA_TEST_FAIL: params.fail || "" },
  });
  return { root, result, claimFile, snippet };
}

function runLaunchFixture(params: { fail?: "qm" | "pct" | "pvesm"; stoppedQemuMemoryMb?: number }) {
  const root = mkdtempSync(join(tmpdir(), "deepseek-launch-test-"));
  const fakeBin = join(root, "bin");
  const paths = {
    lock: join(root, "run/lock"),
    provision: join(root, "run/hivra-provision"),
    provisioner: join(root, "root/hivra-provisioner"),
    results: join(root, "var/lib/hivra/provision-results"),
    claims: join(root, "var/lib/hivra/deepseek-canary-claims"),
    meminfo: join(root, "proc/meminfo"),
  };
  for (const directory of [fakeBin, paths.lock, paths.provision, paths.provisioner, paths.results, paths.claims, join(root, "proc")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(paths.meminfo, "MemTotal:        8388608 kB\n");
  writeFileSync(join(paths.provisioner, "VERSION"), "2026.09.02.8\n");
  const dispatched = join(root, "provisioner-dispatched");
  executable(join(paths.provisioner, "hivra-provision-on-host.sh"), `#!/bin/sh\ntouch ${JSON.stringify(dispatched)}\nexit 0\n`);
  executable(join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' fixture-host\n");
  executable(join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n");
  executable(join(fakeBin, "pct"), `#!/bin/sh
if [ "$1" = list ]; then
  [ "\${HIVRA_TEST_FAIL:-}" != pct ] || exit 75
  printf '%s\\n' 'VMID Status Lock Name'
  exit 0
fi
exit 76
`);
  executable(join(fakeBin, "qm"), `#!/bin/sh
if [ "$1" = list ]; then
  [ "\${HIVRA_TEST_FAIL:-}" != qm ] || exit 71
  printf '%s\\n' ' VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID'
  if [ -n "\${HIVRA_TEST_STOPPED_QEMU_MEMORY_MB:-}" ]; then
    printf '1170 stopped-reservation stopped %s 32.00 0\\n' "$HIVRA_TEST_STOPPED_QEMU_MEMORY_MB"
  fi
  exit 0
fi
if [ "$1" = config ] && [ "$2" = 1170 ] && [ -n "\${HIVRA_TEST_STOPPED_QEMU_MEMORY_MB:-}" ]; then
  printf 'memory: %s\\n' "$HIVRA_TEST_STOPPED_QEMU_MEMORY_MB"
  exit 0
fi
exit 72
`);
  executable(join(fakeBin, "pvesm"), `#!/bin/sh
if [ "$1" = list ]; then
  [ "\${HIVRA_TEST_FAIL:-}" != pvesm ] || exit 73
  printf '%s\\n' 'Volid Format Type Size VMID'
  exit 0
fi
if [ "$1" = status ]; then
  printf '%s\\n' 'Name Type Status Total Used Available'
  printf '%s\\n' 'local-lvm lvmthin active 200000000 100000000 100000000'
  exit 0
fi
exit 74
`);
  const script = buildDeepSeekLaunchScript({
    expectedHostname: "fixture-host", vmid: ledger.vmid, ip: ledger.ip, octet: 82,
    subnetPrefix: "10.252.20", gateway: "10.252.20.1", operationId: ledger.operationId,
    bindingTag: ledger.bindingTag, cpu: 2, memoryMb: 4096,
    tunnelToken: "fixture-token", tunnelUrl: "https://deepseek.example.com",
  })
    .replaceAll("/run/lock", paths.lock)
    .replaceAll("/run/hivra-provision", paths.provision)
    .replaceAll("/root/hivra-provisioner", paths.provisioner)
    .replaceAll("/var/lib/hivra/provision-results", paths.results)
    .replaceAll("/var/lib/hivra/deepseek-canary-claims", paths.claims)
    .replaceAll("/proc/meminfo", paths.meminfo);
  const scriptFile = join(root, "launch.sh");
  writeFileSync(scriptFile, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptFile], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HIVRA_TEST_FAIL: params.fail || "",
      HIVRA_TEST_STOPPED_QEMU_MEMORY_MB: params.stoppedQemuMemoryMb ? String(params.stoppedQemuMemoryMb) : "",
    },
  });
  return {
    root,
    result,
    claimFile: join(paths.claims, `${ledger.vmid}.claim`),
    secretFile: join(paths.provision, `${ledger.vmid}.env`),
    dispatched,
  };
}

describe("DeepSeek Proxmox Canary operator harness", () => {
  it("ships a runnable operator entrypoint with the server-only preload", () => {
    const packageJson = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["lab:deepseek-proxmox"]).toContain("register-server-only-noop.cjs");
    expect(packageJson.scripts?.["lab:deepseek-proxmox"]).toContain("scripts/deepseek-proxmox-canary.ts");
  });

  it("requires one explicit operation and a specific ledger", () => {
    expect(() => parseDeepSeekCanaryArgs([])).toThrow("Choose exactly one");
    expect(() => parseDeepSeekCanaryArgs(["--inspect", "--target", "fixturenode11", "--expected-hostname", "fixturenode11"])).toThrow("--ledger");
    expect(parseDeepSeekCanaryArgs(["--inspect", "--target", "fixturenode11", "--expected-hostname", "fixturenode11", "--ledger", "/tmp/deepseek-ledger.json"]))
      .toMatchObject({ mode: "inspect", target: "fixturenode11", expectedHostname: "fixturenode11", vmid: null, octet: null });
  });

  it("fails closed outside Canary, the allowlist, exact host, pinned SSH and VMID range", () => {
    expect(() => assertDeepSeekCanaryAuthorized("fixturenode11", "fixturenode11", { ...env, NEXT_PUBLIC_APP_URL: "https://hermesos.cloud" }, 1182)).toThrow("fenced");
    expect(() => assertDeepSeekCanaryAuthorized("fixturenode12", "fixturenode12", env, 1182)).toThrow("not authorized");
    expect(() => assertDeepSeekCanaryAuthorized("fixturenode11", "other", env, 1182)).toThrow("exactly match");
    expect(() => assertDeepSeekCanaryAuthorized("fixturenode11", "fixturenode11", { ...env, PROXMOX_SSH_HOST_FINGERPRINT: "" }, 1182)).toThrow("pinned");
    expect(() => assertDeepSeekCanaryAuthorized("fixturenode11", "fixturenode11", env, 1190)).toThrow("outside");
    expect(() => assertDeepSeekCanaryAuthorized("fixturenode11", "fixturenode11", env, 1182)).not.toThrow();
  });

  it("builds an inventory script that shares the allocation lock and pins the provisioner", () => {
    const script = buildDeepSeekInventoryScript({ expectedHostname: "fixturenode11", vmidStart: 1100, vmidEnd: 1199, ipLastOctetStart: 50, subnetPrefix: "10.252.20" });
    expect(script).toContain("flock -s -w 60 8");
    expect(script).toContain("2026.09.02.8");
    expect(script).toContain("HIVRA_DEEPSEEK_INVENTORY");
    expect(script).toContain("capacityAdmits4Gb");
    expect(script).toContain("HIVRA_DEEPSEEK_LXC_INVENTORY_UNKNOWN");
    expect(script).toContain('pct_inventory="$(pct list');
    expect(script).toContain('qm config "$id"');
    expect(script).toContain('pct config "$id"');
    expect(script).not.toContain("NR>1 && $3==\"running\"");
    expect(script).not.toContain("NR>1 && $2==\"running\"");
    expect(script).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("launches only the pinned native kind with exact tags, fixed IP and secret file handoff", () => {
    const script = buildDeepSeekLaunchScript({
      expectedHostname: "fixturenode11", vmid: 1182, ip: "10.252.20.82", octet: 82, subnetPrefix: "10.252.20", gateway: "10.252.20.1",
      operationId: ledger.operationId, bindingTag: ledger.bindingTag, cpu: 2, memoryMb: 4096,
      tunnelToken: "fixture-token", tunnelUrl: "https://deepseek.example.com",
    });
    expect(script).toContain("flock -w 60 8");
    expect(script).toContain("HIVRA_ALLOCATION_LOCK_FD=8");
    expect(script).toContain("HIVRA_SECRET_ENV_FILE=\"$SECRET_ENV_FILE\"");
    expect(script).toContain("deepseek-harness");
    expect(script).toContain(ledger.bindingTag);
    expect(script).toContain("HIVRA_DEEPSEEK_CLAIM_RACE");
    expect(script).toContain("HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN");
    expect(script).toContain("HIVRA_DEEPSEEK_LXC_INVENTORY_UNKNOWN");
    expect(script).toContain("HIVRA_DEEPSEEK_STORAGE_INVENTORY_UNKNOWN");
    expect(script).toContain('pvesm list \'local-lvm\'');
    expect(script).toContain("HIVRA_DEEPSEEK_INSUFFICIENT_RESERVED_MEMORY");
    expect(script).not.toContain("NR>1 && $3==\"running\"");
    expect(script).not.toContain("NR>1 && $2==\"running\"");
    expect(script).not.toContain("fixture-token");
  });

  it("never creates a claim, stages secrets or dispatches when launch inventory is unknown", () => {
    for (const fail of ["qm", "pct", "pvesm"] as const) {
      const fixture = runLaunchFixture({ fail });
      try {
        expect({ fail, status: fixture.result.status, stdout: fixture.result.stdout, stderr: fixture.result.stderr })
          .toMatchObject({
            fail,
            status: fail === "qm" ? 6 : 7,
            stdout: expect.not.stringContaining("HIVRA_DEEPSEEK_CLEAN"),
            stderr: expect.stringContaining(fail === "qm"
              ? "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN"
              : fail === "pct"
                ? "HIVRA_DEEPSEEK_LXC_INVENTORY_UNKNOWN"
                : "HIVRA_DEEPSEEK_STORAGE_INVENTORY_UNKNOWN"),
          });
        expect(existsSync(fixture.claimFile)).toBe(false);
        expect(existsSync(fixture.secretFile)).toBe(false);
        expect(existsSync(fixture.dispatched)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("reserves stopped non-template guests before creating launch authority", () => {
    const fixture = runLaunchFixture({ stoppedQemuMemoryMb: 4096 });
    try {
      expect({ status: fixture.result.status, stdout: fixture.result.stdout, stderr: fixture.result.stderr })
        .toMatchObject({
          status: 8,
          stdout: expect.not.stringContaining("HIVRA_DEEPSEEK_CLEAN"),
          stderr: expect.stringContaining("HIVRA_DEEPSEEK_INSUFFICIENT_RESERVED_MEMORY"),
        });
      expect(existsSync(fixture.claimFile)).toBe(false);
      expect(existsSync(fixture.secretFile)).toBe(false);
      expect(existsSync(fixture.dispatched)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reads access, restarts and tears down only after exact ownership checks", () => {
    const access = buildDeepSeekReadAccessScript(ledger);
    const restart = buildDeepSeekRestartScript(ledger);
    const teardown = buildDeepSeekTeardownScript(ledger);
    for (const script of [access, restart, teardown]) {
      expect(script).toContain(ledger.operationId);
      expect(script).toContain(ledger.bindingTag);
      expect(script).toContain(`VMID=${ledger.vmid}`);
      expect(script).toContain(`EXPECTED_IP='${ledger.ip}'`);
      expect(script).toContain("vm_owned");
    }
    expect(access).toContain("HIVRA_DEEPSEEK_ACCESS_B64");
    expect(restart).toContain("qm reboot");
    expect(restart).toContain('GSSH=(ssh -n -i "$VM_KEY"');
    expect(restart).toContain("hivra-guest-ssh-known-hosts");
    expect(restart).toContain("StrictHostKeyChecking=yes");
    expect(restart).toContain('HostKeyAlias="hivra-vmid-$VMID"');
    expect(restart).not.toContain("StrictHostKeyChecking=no");
    expect(restart).not.toContain("UserKnownHostsFile=/dev/null");
    expect(restart).toContain("/proc/sys/kernel/random/boot_id");
    expect(restart).toContain('boot_after" != "$boot_before');
    expect(restart).toContain("systemctl is-active --quiet bux-hivra-chat.service");
    expect(restart).toContain("systemctl is-active --quiet hivra-cf-tunnel.service");
    expect(restart).not.toContain("cloudflared.service");
    expect(restart).toContain("http://127.0.0.1:8080/healthz");
    expect(restart).not.toContain('qm status "$VMID" | awk');
    expect(teardown).toContain("qm destroy");
    expect(teardown).toContain("HIVRA_DEEPSEEK_TEARDOWN_VOLUME_SURVIVES");
    expect(teardown).toContain('QGA_SNIPPET="/var/lib/vz/snippets/hivra-qga-$VMID-$OPERATION_ID.yaml"');
    expect(teardown.match(/rm -f(?: --)? "\$QGA_SNIPPET"/g)).toHaveLength(2);
    expect(teardown.match(/"\$QGA_SNIPPET"; do/g)).toHaveLength(2);
    expect(teardown).toContain("HIVRA_DEEPSEEK_CLEAN");
  });

  it("emits Bash accepted by the shell parser for every host operation", () => {
    const launch = buildDeepSeekLaunchScript({
      expectedHostname: "fixturenode11", vmid: 1182, ip: "10.252.20.82", octet: 82, subnetPrefix: "10.252.20", gateway: "10.252.20.1",
      operationId: ledger.operationId, bindingTag: ledger.bindingTag, cpu: 2, memoryMb: 4096,
      tunnelToken: "fixture-token", tunnelUrl: "https://deepseek.example.com",
    });
    const scripts = [
      buildDeepSeekInventoryScript({ expectedHostname: "fixturenode11", vmidStart: 1100, vmidEnd: 1199, ipLastOctetStart: 50, subnetPrefix: "10.252.20" }),
      launch,
      buildDeepSeekReadAccessScript(ledger),
      buildDeepSeekRestartScript(ledger),
      buildDeepSeekTeardownScript(ledger),
    ];
    for (const script of scripts) {
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  it("retains cleanup authority when VM or storage inventory is unknown", () => {
    for (const claimPresent of [false, true]) {
      for (const fail of ["qm", "pvesm"] as const) {
        const fixture = runTeardownFixture({ claimPresent, fail });
        try {
          expect({ claimPresent, fail, status: fixture.result.status, stdout: fixture.result.stdout,
            stderr: fixture.result.stderr }).toMatchObject({
            claimPresent,
            fail,
            status: fail === "qm" ? 6 : claimPresent ? 9 : 6,
            stdout: expect.not.stringContaining("HIVRA_DEEPSEEK_CLEAN"),
            stderr: expect.stringContaining(fail === "qm"
              ? "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN"
              : "HIVRA_DEEPSEEK_STORAGE_INVENTORY_UNKNOWN"),
          });
          expect(existsSync(fixture.claimFile)).toBe(claimPresent);
        } finally {
          rmSync(fixture.root, { recursive: true, force: true });
        }
      }
    }
  });

  it("removes an operation-bound stranded QGA snippet only after authoritative empty inventories", () => {
    const fixture = runTeardownFixture({ claimPresent: false, strandSnippet: true });
    try {
      expect({ status: fixture.result.status, stdout: fixture.result.stdout, stderr: fixture.result.stderr }).toMatchObject({
        status: 0,
        stdout: expect.stringContaining("HIVRA_DEEPSEEK_CLEAN"),
        stderr: "",
      });
      expect(existsSync(fixture.snippet)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
