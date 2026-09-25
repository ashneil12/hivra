import {
  DEEPSEEK_CANARY_ORIGIN,
  DEEPSEEK_CANARY_VERSION,
  assertDeepSeekCanaryAuthorized,
  buildDeepSeekBundleCheckScript,
  buildDeepSeekInventoryScript,
  buildDeepSeekLaunchScript,
  buildDeepSeekReadAccessScript,
  buildDeepSeekRestartScript,
  buildDeepSeekTeardownScript,
  loadDeepSeekCanaryBundleManifest,
  parseDeepSeekCanaryArgs,
  type DeepSeekCanaryLedger,
} from "../../scripts/deepseek-proxmox-canary";
import {
  buildManagedProvisionerBundleSyncScript,
  managedProvisionerBundleManifestFile,
} from "../../src/lib/hivra/managed-provisioner-bundle-sync";
import { loadPortableProvisionerBundle } from "../../src/lib/infrastructure/connection-preparation";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "../../src/lib/infrastructure/portable-provisioner-contract";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The release this harness was hard-pinned to before it tracked Canary.
const STALE_CANARY_PIN = "2026.09.02.8";
// A release that a bundle sync could seal while the harness waits for the lock.
const LATER_CANARY_RELEASE = "2026.09.99.1";
const PROVISIONER_ROOT = join(__dirname, "../../provisioner");

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

type BundleState = "sealed" | "tampered" | "resealed" | "missing" | "empty";
type LockSwap = "version" | "bytes";

const FIXTURE_BUNDLE_FILES = ["VERSION", "hivra-provision-on-host.sh"] as const;

// BUNDLE.sha256 exactly as managed bundle sync writes it for these files.
function fixtureManifest(directory: string): string {
  return managedProvisionerBundleManifestFile(FIXTURE_BUNDLE_FILES.map(relativePath => ({
    relativePath,
    content: readFileSync(join(directory, relativePath)),
  })));
}

// Seals the fixture bundle and returns that manifest as the pinned release,
// then optionally breaks the host copy after sealing.
function sealBundle(directory: string, state: BundleState): string {
  const pinned = fixtureManifest(directory);
  const manifest = join(directory, "BUNDLE.sha256");
  const provisioner = join(directory, "hivra-provision-on-host.sh");
  if (state === "missing") return pinned;
  if (state === "empty") { writeFileSync(manifest, ""); return pinned; }
  writeFileSync(manifest, pinned);
  // A hand edit that keeps the current VERSION string must still be refused.
  if (state === "tampered") appendFileSync(provisioner, "# hand edit\n");
  // Every delivery path reseals the manifest from the bytes it ships, so a
  // changed bundle that kept VERSION verifies against its own manifest.
  if (state === "resealed") {
    appendFileSync(provisioner, "# rebuilt without a release bump\n");
    writeFileSync(manifest, fixtureManifest(directory));
  }
  return pinned;
}

// Stands in for flock and, while "holding" the lock, does what a bundle sync
// holding it exclusively would: swap the bundle and reseal its manifest.
function flockStub(locked: string, directory: string, swap?: LockSwap): string {
  const touch = `touch ${JSON.stringify(locked)}`;
  if (!swap) return `#!/bin/sh\n${touch}\nexit 0\n`;
  const edit = swap === "version"
    ? `printf '%s\\n' ${LATER_CANARY_RELEASE} > VERSION`
    : "printf '%s\\n' '# rebuilt without a release bump' >> hivra-provision-on-host.sh";
  return `#!/bin/sh
${touch}
cd ${JSON.stringify(directory)} || exit 90
${edit}
sha256sum ${FIXTURE_BUNDLE_FILES.join(" ")} > BUNDLE.sha256
exit 0
`;
}

// The integrity check needs a real sha256sum on the fixture PATH. macOS keeps
// it in /sbin, which the fixture PATH deliberately omits.
function linkSha256sum(fakeBin: string): void {
  const real = ["/usr/bin/sha256sum", "/bin/sha256sum", "/sbin/sha256sum", "/usr/local/bin/sha256sum"].find(existsSync);
  executable(join(fakeBin, "sha256sum"), real
    ? `#!/bin/sh\nexec ${real} "$@"\n`
    : "#!/bin/sh\nexec shasum -a 256 \"$@\"\n");
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

function runLaunchFixture(params: {
  fail?: "qm" | "pct" | "pvesm";
  stoppedQemuMemoryMb?: number;
  capacityPolicy?: "reserved" | "active";
  /** Exit status of the sealed capacity helper under the "active" policy. */
  helperExit?: number;
  canaryVersion?: string;
  defaultVersion?: string;
  bundle?: BundleState;
  swapUnderLock?: LockSwap;
}) {
  const root = mkdtempSync(join(tmpdir(), "deepseek-launch-test-"));
  const fakeBin = join(root, "bin");
  // Canary launches run the bundle Canary delivers; the default directory
  // belongs to the production delivery lane on a shared host.
  const paths = {
    lock: join(root, "run/lock"),
    provision: join(root, "run/hivra-provision"),
    canaryProvisioner: join(root, "canary-provisioner"),
    defaultProvisioner: join(root, "default-provisioner"),
    results: join(root, "var/lib/hivra/provision-results"),
    claims: join(root, "var/lib/hivra/deepseek-canary-claims"),
    meminfo: join(root, "proc/meminfo"),
  };
  for (const directory of [fakeBin, paths.lock, paths.provision, paths.canaryProvisioner, paths.defaultProvisioner,
    paths.results, paths.claims, join(root, "proc")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(paths.meminfo, "MemTotal:        8388608 kB\n");
  writeFileSync(join(paths.canaryProvisioner, "VERSION"), `${params.canaryVersion ?? PORTABLE_HIVRA_PROVISIONER_VERSION}\n`);
  writeFileSync(join(paths.defaultProvisioner, "VERSION"), `${params.defaultVersion ?? STALE_CANARY_PIN}\n`);
  const dispatched = join(root, "provisioner-dispatched");
  const wrongLane = join(root, "default-provisioner-dispatched");
  // Records the directory it ran from and the release that directory held.
  executable(join(paths.canaryProvisioner, "hivra-provision-on-host.sh"),
    `#!/bin/sh\nprintf '%s %s\\n' "$HIVRA_PROV_DIR" "$(cat "$HIVRA_PROV_DIR/VERSION")" > ${JSON.stringify(dispatched)}\nexit 0\n`);
  executable(join(paths.defaultProvisioner, "hivra-provision-on-host.sh"), `#!/bin/sh\ntouch ${JSON.stringify(wrongLane)}\nexit 0\n`);
  // Stands in for the sealed helper product launches use; records its argv.
  const helperArgs = join(root, "capacity-helper-args");
  executable(join(paths.canaryProvisioner, "hivra-host-capacity-admission"),
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(helperArgs)}\n[ "\${HIVRA_TEST_HELPER_EXIT:-0}" = 0 ] || { echo "active memory floors plus host reserve exceed physical memory" >&2; exit 1; }\necho HIVRA_CAPACITY_ADMITTED\n`);
  const bundleManifest = sealBundle(paths.canaryProvisioner, params.bundle ?? "sealed");
  sealBundle(paths.defaultProvisioner, "sealed");
  linkSha256sum(fakeBin);
  const locked = join(root, "allocation-lock-taken");
  executable(join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' fixture-host\n");
  executable(join(fakeBin, "flock"), flockStub(locked, paths.canaryProvisioner, params.swapUnderLock));
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
    tunnelToken: "fixture-token", tunnelUrl: "https://deepseek.example.com", bundleManifest,
    capacityPolicy: params.capacityPolicy,
  })
    .replaceAll("/run/lock", paths.lock)
    .replaceAll("/run/hivra-provision", paths.provision)
    .replaceAll("/root/hivra-provisioner-canary", paths.canaryProvisioner)
    .replaceAll("/root/hivra-provisioner", paths.defaultProvisioner)
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
      HIVRA_TEST_HELPER_EXIT: String(params.helperExit ?? 0),
    },
  });
  return {
    root,
    result,
    helperArgs,
    claimFile: join(paths.claims, `${ledger.vmid}.claim`),
    secretFile: join(paths.provision, `${ledger.vmid}.env`),
    dispatched,
    wrongLane,
    locked,
    canaryProvisioner: paths.canaryProvisioner,
  };
}

function runInventoryFixture(params: { bundle?: BundleState; canaryVersion?: string; swapUnderLock?: LockSwap }) {
  const root = mkdtempSync(join(tmpdir(), "deepseek-inventory-test-"));
  const fakeBin = join(root, "bin");
  const paths = {
    lock: join(root, "run/lock"),
    canaryProvisioner: join(root, "canary-provisioner"),
    meminfo: join(root, "proc/meminfo"),
  };
  for (const directory of [fakeBin, paths.lock, paths.canaryProvisioner, join(root, "proc")]) mkdirSync(directory, { recursive: true });
  writeFileSync(paths.meminfo, "MemTotal:        8388608 kB\n");
  writeFileSync(join(paths.canaryProvisioner, "VERSION"), `${params.canaryVersion ?? PORTABLE_HIVRA_PROVISIONER_VERSION}\n`);
  executable(join(paths.canaryProvisioner, "hivra-provision-on-host.sh"), "#!/bin/sh\nexit 0\n");
  const bundleManifest = sealBundle(paths.canaryProvisioner, params.bundle ?? "sealed");
  linkSha256sum(fakeBin);
  const locked = join(root, "allocation-lock-taken");
  executable(join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' fixture-host\n");
  executable(join(fakeBin, "flock"), flockStub(locked, paths.canaryProvisioner, params.swapUnderLock));
  executable(join(fakeBin, "pvesh"), "#!/bin/sh\nprintf '%s\\n' '[]'\n");
  executable(join(fakeBin, "qm"), "#!/bin/sh\n[ \"$1\" = list ] || exit 72\nprintf '%s\\n' ' VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID'\n");
  executable(join(fakeBin, "pct"), "#!/bin/sh\n[ \"$1\" = list ] || exit 76\nprintf '%s\\n' 'VMID Status Lock Name'\n");
  executable(join(fakeBin, "pvesm"), `#!/bin/sh
[ "$1" = status ] || exit 74
printf '%s\\n' 'Name Type Status Total Used Available'
printf '%s\\n' 'local-lvm lvmthin active 200000000 100000000 100000000'
`);
  const script = buildDeepSeekInventoryScript({
    expectedHostname: "fixture-host", vmidStart: 1180, vmidEnd: 1189, ipLastOctetStart: 80, subnetPrefix: "10.252.20",
    bundleManifest,
  })
    .replaceAll("/run/lock", paths.lock)
    .replaceAll("/root/hivra-provisioner-canary", paths.canaryProvisioner)
    .replaceAll("/proc/meminfo", paths.meminfo);
  const scriptFile = join(root, "inventory.sh");
  writeFileSync(scriptFile, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptFile], { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` } });
  return { root, result, locked };
}

function runBundleCheckFixture(params: { bundle?: BundleState; swapUnderLock?: LockSwap }) {
  const root = mkdtempSync(join(tmpdir(), "deepseek-bundle-check-test-"));
  const fakeBin = join(root, "bin");
  const paths = { lock: join(root, "run/lock"), canaryProvisioner: join(root, "canary-provisioner") };
  for (const directory of [fakeBin, paths.lock, paths.canaryProvisioner]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(paths.canaryProvisioner, "VERSION"), `${PORTABLE_HIVRA_PROVISIONER_VERSION}\n`);
  executable(join(paths.canaryProvisioner, "hivra-provision-on-host.sh"), "#!/bin/sh\nexit 0\n");
  const bundleManifest = sealBundle(paths.canaryProvisioner, params.bundle ?? "sealed");
  linkSha256sum(fakeBin);
  const locked = join(root, "allocation-lock-taken");
  executable(join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' fixture-host\n");
  executable(join(fakeBin, "flock"), flockStub(locked, paths.canaryProvisioner, params.swapUnderLock));
  const script = buildDeepSeekBundleCheckScript({ expectedHostname: "fixture-host", bundleManifest })
    .replaceAll("/run/lock", paths.lock)
    .replaceAll("/root/hivra-provisioner-canary", paths.canaryProvisioner);
  const scriptFile = join(root, "bundle-check.sh");
  writeFileSync(scriptFile, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptFile], { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` } });
  return { root, result, locked };
}

describe("DeepSeek Proxmox Canary operator harness", () => {
  let checkoutManifest = "";
  beforeAll(async () => {
    checkoutManifest = await loadDeepSeekCanaryBundleManifest();
  });

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

  it("pins the current Canary provisioner release instead of a hard-coded one", () => {
    expect(DEEPSEEK_CANARY_VERSION).toBe(PORTABLE_HIVRA_PROVISIONER_VERSION);
    expect(DEEPSEEK_CANARY_VERSION).not.toBe(STALE_CANARY_PIN);
  });

  it("seals the pinned release exactly as managed bundle sync seals the Canary directory", async () => {
    const assets = await loadPortableProvisionerBundle(PROVISIONER_ROOT);
    const sync = buildManagedProvisionerBundleSyncScript("canary", assets, "fixturenode11");
    const written = sync.match(/cat > "\$UPLOAD_DIR\/BUNDLE\.sha256" <<'HIVRA_MANAGED_BUNDLE_MANIFEST'\n([\s\S]*?)^HIVRA_MANAGED_BUNDLE_MANIFEST$/m)?.[1];
    expect(written).toBeDefined();
    expect(checkoutManifest).toBe(written);
    const version = createHash("sha256").update(readFileSync(join(PROVISIONER_ROOT, "VERSION"))).digest("hex");
    expect(checkoutManifest).toContain(`${version}  VERSION\n`);
    expect(checkoutManifest.split("\n").filter(Boolean)).toHaveLength(assets.length);
  });

  it("refuses to build host scripts around a malformed pinned manifest", () => {
    for (const bundleManifest of ["", "not a manifest\n", checkoutManifest.replace(/\n$/, "")]) {
      expect(() => buildDeepSeekInventoryScript({ expectedHostname: "fixturenode11", vmidStart: 1100, vmidEnd: 1199, ipLastOctetStart: 50, subnetPrefix: "10.252.20", bundleManifest }))
        .toThrow("malformed");
      expect(() => buildDeepSeekBundleCheckScript({ expectedHostname: "fixturenode11", bundleManifest })).toThrow("malformed");
    }
  });

  it("builds an inventory script that shares the allocation lock and pins the provisioner", () => {
    const script = buildDeepSeekInventoryScript({ expectedHostname: "fixturenode11", vmidStart: 1100, vmidEnd: 1199, ipLastOctetStart: 50, subnetPrefix: "10.252.20", bundleManifest: checkoutManifest });
    expect(script).toContain("flock -s -w 60 8");
    expect(script).toContain(`PROVISIONER_DIR='/root/hivra-provisioner-canary'`);
    expect(script).toContain(`'${PORTABLE_HIVRA_PROVISIONER_VERSION}'`);
    expect(script).toContain(`EXPECTED_BUNDLE_MANIFEST='${checkoutManifest}'`);
    expect(script).toContain('printf \'%s\' "$EXPECTED_BUNDLE_MANIFEST" | cmp -s - "$PROVISIONER_DIR/BUNDLE.sha256"');
    expect(script).toContain('(cd "$PROVISIONER_DIR" && sha256sum -c --status BUNDLE.sha256)');
    expect(script).toMatch(/for command in [^;]*\bsha256sum cmp; do/);
    // Admitted before the lock to fail fast, and again under it before inventory.
    const admissions = [...script.matchAll(/^admit_canary_bundle$/gm)].map(match => match.index ?? -1);
    expect(admissions).toHaveLength(2);
    expect(admissions[0]).toBeLessThan(script.indexOf("flock -s -w 60 8"));
    expect(admissions[1]).toBeGreaterThan(script.indexOf("flock -s -w 60 8"));
    expect(admissions[1]).toBeLessThan(script.indexOf("cluster_json="));
    expect(script).not.toContain(STALE_CANARY_PIN);
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
      tunnelToken: "fixture-token", tunnelUrl: "https://deepseek.example.com", bundleManifest: checkoutManifest,
    });
    expect(script).toContain("flock -w 60 8");
    expect(script).toContain(`EXPECTED_BUNDLE_MANIFEST='${checkoutManifest}'`);
    // Only the admission under the lock binds what the claim and dispatch use.
    const admissions = [...script.matchAll(/^admit_canary_bundle$/gm)].map(match => match.index ?? -1);
    expect(admissions).toHaveLength(2);
    expect(admissions[0]).toBeLessThan(script.indexOf("flock -w 60 8"));
    expect(admissions[1]).toBeGreaterThan(script.indexOf("flock -w 60 8"));
    expect(admissions[1]).toBeLessThan(script.indexOf("HIVRA_DEEPSEEK_CLAIM_RACE"));
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
    expect(script).toContain('(cd "$PROVISIONER_DIR" && sha256sum -c --status BUNDLE.sha256)');
    expect(script).toMatch(/for command in [^;]*\bsha256sum cmp; do/);
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

  it("dispatches from the Canary delivery directory at the current release", () => {
    const fixture = runLaunchFixture({ defaultVersion: PORTABLE_HIVRA_PROVISIONER_VERSION });
    try {
      expect({ status: fixture.result.status, stderr: fixture.result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(readFileSync(fixture.dispatched, "utf8")).toBe(`${fixture.canaryProvisioner} ${PORTABLE_HIVRA_PROVISIONER_VERSION}\n`);
      expect(existsSync(fixture.wrongLane)).toBe(false);
      expect(existsSync(fixture.claimFile)).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a host whose Canary bundle is not the current release before any claim", () => {
    const fixture = runLaunchFixture({ canaryVersion: STALE_CANARY_PIN, defaultVersion: PORTABLE_HIVRA_PROVISIONER_VERSION });
    try {
      expect({ status: fixture.result.status, stderr: fixture.result.stderr })
        .toMatchObject({ status: 4, stderr: expect.stringContaining("HIVRA_DEEPSEEK_VERSION_MISMATCH") });
      expect(existsSync(fixture.claimFile)).toBe(false);
      expect(existsSync(fixture.secretFile)).toBe(false);
      expect(existsSync(fixture.dispatched)).toBe(false);
      expect(existsSync(fixture.wrongLane)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses a Canary bundle whose files no longer match its manifest before the lock or any claim", () => {
    for (const [bundle, code] of [
      ["tampered", "HIVRA_DEEPSEEK_BUNDLE_INTEGRITY_MISMATCH"],
      ["resealed", "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH"],
      ["missing", "HIVRA_DEEPSEEK_BUNDLE_MANIFEST_MISSING"],
      ["empty", "HIVRA_DEEPSEEK_BUNDLE_MANIFEST_MISSING"],
    ] as const) {
      // The production bundle is sealed and current, so only the Canary lane is under test.
      const fixture = runLaunchFixture({ bundle, defaultVersion: PORTABLE_HIVRA_PROVISIONER_VERSION });
      try {
        expect({ bundle, status: fixture.result.status, stderr: fixture.result.stderr })
          .toMatchObject({ bundle, status: 4, stderr: expect.stringContaining(code) });
        expect(existsSync(fixture.locked)).toBe(false);
        expect(existsSync(fixture.claimFile)).toBe(false);
        expect(existsSync(fixture.secretFile)).toBe(false);
        expect(existsSync(fixture.dispatched)).toBe(false);
        expect(existsSync(fixture.wrongLane)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("re-admits the Canary bundle once the allocation lock is held, before any claim", () => {
    for (const [swapUnderLock, code] of [
      ["version", "HIVRA_DEEPSEEK_VERSION_MISMATCH"],
      ["bytes", "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH"],
    ] as const) {
      // Admission before the lock passes; a bundle sync then swaps and reseals
      // the directory while this launch waits for the lock.
      const fixture = runLaunchFixture({ swapUnderLock, defaultVersion: PORTABLE_HIVRA_PROVISIONER_VERSION });
      try {
        expect({ swapUnderLock, status: fixture.result.status, stderr: fixture.result.stderr })
          .toMatchObject({ swapUnderLock, status: 4, stderr: expect.stringContaining(code) });
        expect(existsSync(fixture.locked)).toBe(true);
        expect(existsSync(fixture.claimFile)).toBe(false);
        expect(existsSync(fixture.secretFile)).toBe(false);
        expect(existsSync(fixture.dispatched)).toBe(false);
        expect(existsSync(fixture.wrongLane)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("inventories only the bundle that is still pinned once the shared lock is held", () => {
    for (const [swapUnderLock, code] of [
      ["version", "HIVRA_DEEPSEEK_VERSION_MISMATCH"],
      ["bytes", "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH"],
    ] as const) {
      const fixture = runInventoryFixture({ swapUnderLock });
      try {
        expect({ swapUnderLock, status: fixture.result.status, stdout: fixture.result.stdout, stderr: fixture.result.stderr })
          .toMatchObject({ swapUnderLock, status: 4, stdout: "", stderr: expect.stringContaining(code) });
        expect(existsSync(fixture.locked)).toBe(true);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("confirms after launch that the pinned bundle is still the one in place", () => {
    const sealed = runBundleCheckFixture({});
    try {
      expect({ status: sealed.result.status, stderr: sealed.result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(sealed.result.stdout)
        .toBe(`HIVRA_DEEPSEEK_BUNDLE_ADMITTED {"provisionerVersion":"${PORTABLE_HIVRA_PROVISIONER_VERSION}"}\n`);
      expect(existsSync(sealed.locked)).toBe(true);
    } finally {
      rmSync(sealed.root, { recursive: true, force: true });
    }
    for (const [params, code] of [
      [{ bundle: "resealed" }, "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH"],
      [{ bundle: "tampered" }, "HIVRA_DEEPSEEK_BUNDLE_INTEGRITY_MISMATCH"],
      [{ swapUnderLock: "version" }, "HIVRA_DEEPSEEK_VERSION_MISMATCH"],
      [{ swapUnderLock: "bytes" }, "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH"],
    ] as const) {
      const fixture = runBundleCheckFixture(params);
      try {
        expect({ params, status: fixture.result.status, stdout: fixture.result.stdout, stderr: fixture.result.stderr })
          .toMatchObject({ params, status: 4, stdout: "", stderr: expect.stringContaining(code) });
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("inventories only a Canary bundle that matches its manifest, before taking the lock", () => {
    const sealed = runInventoryFixture({});
    try {
      expect({ status: sealed.result.status, stderr: sealed.result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(sealed.result.stdout).toContain(`"provisionerVersion":"${PORTABLE_HIVRA_PROVISIONER_VERSION}"`);
      expect(sealed.result.stdout).toContain('"candidateVmid":1180');
      expect(existsSync(sealed.locked)).toBe(true);
    } finally {
      rmSync(sealed.root, { recursive: true, force: true });
    }
    for (const [bundle, code] of [
      ["tampered", "HIVRA_DEEPSEEK_BUNDLE_INTEGRITY_MISMATCH"],
      ["resealed", "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH"],
      ["missing", "HIVRA_DEEPSEEK_BUNDLE_MANIFEST_MISSING"],
    ] as const) {
      const fixture = runInventoryFixture({ bundle });
      try {
        expect({ bundle, status: fixture.result.status, stdout: fixture.result.stdout, stderr: fixture.result.stderr })
          .toMatchObject({ bundle, status: 4, stdout: "", stderr: expect.stringContaining(code) });
        expect(existsSync(fixture.locked)).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
    const stale = runInventoryFixture({ canaryVersion: STALE_CANARY_PIN });
    try {
      expect({ status: stale.result.status, stderr: stale.result.stderr })
        .toMatchObject({ status: 4, stderr: expect.stringContaining("HIVRA_DEEPSEEK_VERSION_MISMATCH") });
      expect(existsSync(stale.locked)).toBe(false);
    } finally {
      rmSync(stale.root, { recursive: true, force: true });
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

  it("admits a lab computer like a product launch only when the operator asks for the active policy", () => {
    // A stopped guest another owner holds would block the default reserved rule...
    const active = runLaunchFixture({ stoppedQemuMemoryMb: 4096, capacityPolicy: "active" });
    try {
      expect({ status: active.result.status, stderr: active.result.stderr }).toMatchObject({ status: 0 });
      expect(existsSync(active.dispatched)).toBe(true);
      // ...but the active rule is the sealed helper product launches run: the
      // requested floor and maximum, CPU, 2048 MB reserve, observe mode, 1x density.
      expect(readFileSync(active.helperArgs, "utf8").trim()).toBe("- 4096 4096 2 2048 0 1000 1000");
    } finally {
      rmSync(active.root, { recursive: true, force: true });
    }
    const refused = runLaunchFixture({ capacityPolicy: "active", helperExit: 1 });
    try {
      expect({ status: refused.result.status, stderr: refused.result.stderr }).toMatchObject({
        status: 8, stderr: expect.stringContaining("HIVRA_DEEPSEEK_INSUFFICIENT_RESERVED_MEMORY active memory floors plus host reserve exceed physical memory"),
      });
      expect(existsSync(refused.claimFile)).toBe(false);
      expect(existsSync(refused.dispatched)).toBe(false);
    } finally {
      rmSync(refused.root, { recursive: true, force: true });
    }
    // The default never consults the helper.
    const reserved = runLaunchFixture({ stoppedQemuMemoryMb: 4096 });
    try {
      expect(reserved.result.status).toBe(8);
      expect(existsSync(reserved.helperArgs)).toBe(false);
    } finally {
      rmSync(reserved.root, { recursive: true, force: true });
    }
  });

  it("parses the capacity policy, defaulting to reserved", () => {
    const base = ["--launch", "--target", "fixturenode11", "--expected-hostname", "fixturenode11", "--ledger", "/tmp/fixture-ledger.json", "--vmid", "1190", "--octet", "90"];
    expect(parseDeepSeekCanaryArgs(base).capacityPolicy).toBe("reserved");
    expect(parseDeepSeekCanaryArgs([...base, "--capacity-policy", "active"]).capacityPolicy).toBe("active");
    expect(() => parseDeepSeekCanaryArgs([...base, "--capacity-policy", "overcommit"])).toThrow("--capacity-policy");
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
    expect(restart).toContain("'/root/hivra-provisioner-canary/hivra-guest-ssh-known-hosts'");
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
      tunnelToken: "fixture-token", tunnelUrl: "https://deepseek.example.com", bundleManifest: checkoutManifest,
    });
    const scripts = [
      buildDeepSeekInventoryScript({ expectedHostname: "fixturenode11", vmidStart: 1100, vmidEnd: 1199, ipLastOctetStart: 50, subnetPrefix: "10.252.20", bundleManifest: checkoutManifest }),
      launch,
      buildDeepSeekBundleCheckScript({ expectedHostname: "fixturenode11", bundleManifest: checkoutManifest }),
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
