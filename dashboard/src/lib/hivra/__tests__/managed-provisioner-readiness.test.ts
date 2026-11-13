import { spawnSync } from "node:child_process";

import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import { managedHivraHostReadinessScript } from "../managed-provisioner-readiness";

describe("managed Hivra provisioner readiness", () => {
  it.each([["2026.08.26.10", 1], ["2026.08.28.1", 1], ["2026.08.28.2", 0], ["2026.08.28.3", 0], ["2026.08.28.4", 0], ["2026.08.28.5", 1]])(
    "requires the actual model-settings release when requested: %s", (version, status) => {
      const script = managedHivraHostReadinessScript("default", "provision", true);
      const start = script.indexOf('case "$OBSERVED_VERSION" in'), end = script.indexOf("\nesac", start);
      expect(script).toContain('need_file "$PROVISIONER_DIR/hivra-chat/llm-application.js"');
      expect(script).toContain("sha256sum -c --status BUNDLE.sha256");
      expect(spawnSync("bash", ["--noprofile", "--norc", "-s"], { input: script.slice(start, end + 6), encoding: "utf8", timeout: 3_000,
        env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", OBSERVED_VERSION: String(version) } }).status).toBe(status);
      expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
    },
  );
  it.each([
    ["2026.08.26.10", 0], ["2026.08.27.1", 0], ["2026.08.27.2", 0], ["2026.08.27.3", 0], ["2026.08.27.4", 0], [PORTABLE_HIVRA_PROVISIONER_VERSION, 0],
    ["2026.08.26.4", 1], ["2099.01.01.1", 1], ["latest", 1],
  ])("checks the explicit managed release set: %s", (version, expectedStatus) => {
    const script=managedHivraHostReadinessScript("default"),start=script.indexOf('case "$OBSERVED_VERSION" in'),end=script.indexOf("\nesac",start);
    expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
    const result=spawnSync("bash",["--noprofile","--norc","-s"],{input:script.slice(start,end+6),encoding:"utf8",timeout:3_000,
      env:{PATH:"/usr/bin:/bin",NODE_ENV:"test",OBSERVED_VERSION:String(version)}});
    expect(result.status).toBe(expectedStatus);
  });
  function executeOperationReceiptProbe(script: string) {
    const lines = script.split("\n");
    const probeIndex = lines.findIndex((line) =>
      line.startsWith("grep -Fq") && line.includes("HIVRA_OPERATION_ID %s"),
    );
    expect(probeIndex).toBeGreaterThanOrEqual(0);

    const probe = lines.slice(probeIndex, probeIndex + 2).join("\n");
    return spawnSync("bash", [], {
      input: `set -euo pipefail
START_SCRIPT="$(mktemp)"
trap 'rm -f "$START_SCRIPT"' EXIT
cat > "$START_SCRIPT" <<'START_SCRIPT_EOF'
printf 'HIVRA_OPERATION_ID %s\\n' "$OPERATION_ID"
START_SCRIPT_EOF
${probe}
`,
      encoding: "utf8",
    });
  }

  it("keeps launch admission on the full managed provisioning contract", () => {
    const script = managedHivraHostReadinessScript("default", "provision");

    expect(script).toContain(PORTABLE_HIVRA_PROVISIONER_VERSION);
    expect(script).toContain("sha256sum -c --status BUNDLE.sha256");
    expect(script).toContain("/root/jammy-server-cloudimg-amd64.img");
    expect(script).toContain("/etc/hivra/keys/vm-orchestrator.pub");
    expect(script).toContain("ip link show 'vmbr1'");
    expect(script).toContain('pvesm status | awk \'$1=="local-lvm"');
    expect(script).toContain('BINDING_TAG="${HIVRA_BINDING_TAG:-}"');
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it("admits lifecycle on the exact current start contract without provisioning-only host requirements", () => {
    const script = managedHivraHostReadinessScript("default", "lifecycle");

    expect(script).toContain(PORTABLE_HIVRA_PROVISIONER_VERSION);
    expect(script).toContain("sha256sum -c --status BUNDLE.sha256");
    expect(script).toContain("/etc/hivra/keys/vm-orchestrator");
    expect(script).toContain('RESULT_LOG_PATH="${HIVRA_RESULT_LOG_PATH:-${LOG_DIR}/provision-${VMID}.log}"');
    expect(script).toContain("printf 'HIVRA_OPERATION_ID %s\\n' \\\"\\$OPERATION_ID\\\"");
    expect(script).toContain('command -v qm');
    expect(script).not.toContain("/root/jammy-server-cloudimg-amd64.img");
    expect(script).not.toContain("/etc/hivra/keys/vm-orchestrator.pub");
    expect(script).not.toContain("ip link show");
    expect(script).not.toContain("pvesm status");
    expect(script).not.toContain("binding-tag enforcement");
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })).toMatchObject({
      status: 0,
      stderr: "",
    });
    expect(executeOperationReceiptProbe(script)).toMatchObject({
      status: 0,
      stderr: "",
    });
  });

  it("requires the current bundle for new Canary provisions without tightening ordinary lifecycle", () => {
    const provision = managedHivraHostReadinessScript("canary", "provision");
    const lifecycle = managedHivraHostReadinessScript("canary", "lifecycle");

    expect(provision).toContain("PROVISIONER_DIR='/root/hivra-provisioner-canary'");
    expect(provision).toContain(`  '${PORTABLE_HIVRA_PROVISIONER_VERSION}') ;;`);
    expect(provision).not.toContain("'2026.08.26.10'");
    expect(lifecycle).toContain("PROVISIONER_DIR='/root/hivra-provisioner-canary'");
    expect(lifecycle).toContain("'2026.08.26.10'");
    expect(spawnSync("bash", ["-n"], { input: provision, encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("bash", ["-n"], { input: lifecycle, encoding: "utf8" }).status).toBe(0);
  });
});

describe("managed readiness against a host bundle without the capacity admission helper", () => {
  // Prod incident, 25 Oct 2026: one managed host still ran bundle 2026.09.08.3. Readiness
  // admitted it (a compatible version with an intact manifest), placement sent
  // every launch there, and the launch kickoff died with exit 127 on the
  // missing hivra-host-capacity-admission before any VM was created.
  const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
  const os = jest.requireActual<typeof import("node:os")>("node:os");
  const path = jest.requireActual<typeof import("node:path")>("node:path");
  const { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES } = jest.requireActual<
    typeof import("@/lib/infrastructure/portable-provisioner-contract")
  >("@/lib/infrastructure/portable-provisioner-contract");
  const sourceDir = path.join(__dirname, "../../../../provisioner");
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-readiness-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function host(options: { version: string; withAdmission: boolean }) {
    const bundle = path.join(root, "hivra-provisioner");
    for (const file of PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES) {
      if (!options.withAdmission && file === "hivra-host-capacity-admission") continue;
      fs.mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
      fs.copyFileSync(path.join(sourceDir, file), path.join(bundle, file));
    }
    fs.writeFileSync(path.join(bundle, "VERSION"), `${options.version}\n`);
    const manifest = spawnSync("bash", ["-c", "find . -type f ! -name BUNDLE.sha256 | sort | xargs sha256sum"], {
      cwd: bundle, encoding: "utf8",
    });
    expect(manifest.status).toBe(0);
    fs.writeFileSync(path.join(bundle, "BUNDLE.sha256"), manifest.stdout);
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    stub("qm", "exit 0");
    stub("pvesm", "echo 'Name Type Status'; echo 'local-lvm lvmthin active'");
    stub("ip", "exit 0");
    fs.mkdirSync(path.join(root, "keys"));
    fs.writeFileSync(path.join(root, "keys/vm-orchestrator"), "key");
    fs.writeFileSync(path.join(root, "keys/vm-orchestrator.pub"), "key");
    fs.writeFileSync(path.join(root, "jammy.img"), "image");
    return { bundle, bin };
  }

  function run(purpose: "provision" | "lifecycle" | "resize", fixture: { bundle: string; bin: string }) {
    const script = managedHivraHostReadinessScript("default", purpose)
      .replaceAll("'/root/hivra-provisioner'", `'${fixture.bundle}'`)
      .replaceAll("'/root/jammy-server-cloudimg-amd64.img'", `'${path.join(root, "jammy.img")}'`)
      .replaceAll("'/etc/hivra/keys/vm-orchestrator", `'${path.join(root, "keys/vm-orchestrator")}`);
    return spawnSync("bash", ["--noprofile", "--norc", "-s"], {
      input: script, encoding: "utf8", timeout: 10_000,
      env: { PATH: `${fixture.bin}:/usr/bin:/bin`, NODE_ENV: "test" },
    });
  }

  it("refuses new launches and resizes on a 2026.09.08.3 bundle so placement moves on", () => {
    const fixture = host({ version: "2026.09.08.3", withAdmission: false });
    for (const purpose of ["provision", "resize"] as const) {
      const result = run(purpose, fixture);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("HIVRA_HOST_READY");
      expect(result.stderr).toContain("hivra-host-capacity-admission");
    }
  });

  it("keeps Start and Restart available on that host: the start helper never calls the admission helper", () => {
    const result = run("lifecycle", host({ version: "2026.09.08.3", withAdmission: false }));
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("HIVRA_HOST_READY");
  });

  it("admits launches on a current bundle", () => {
    const result = run("provision", host({ version: PORTABLE_HIVRA_PROVISIONER_VERSION, withAdmission: true }));
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("HIVRA_HOST_READY");
  });
});

describe("managed readiness per runtime", () => {
  const versionsIn = (script: string) => {
    const start = script.indexOf('case "$OBSERVED_VERSION" in');
    return [...script.slice(start, script.indexOf("\nesac", start)).matchAll(/'(\d{4}\.\d\d\.\d\d\.\d+)'/g)].map(m => m[1]);
  };

  it.each(["aeon", "openclaw", "agent-zero"])("excludes releases before agent-app-versions.json for %s", (runtime) => {
    const versions = versionsIn(managedHivraHostReadinessScript("default", "provision", false, runtime));
    expect(versions).not.toContain("2026.10.20.1");
    expect(versions).not.toContain("2026.09.24.4");
    expect(versions).toContain("2026.10.20.2");
    expect(versions).toContain(PORTABLE_HIVRA_PROVISIONER_VERSION);
  });

  it("lets only hosts on the release that ships linux-server take it, and keeps Linux Desktop on older hosts", () => {
    for (const purpose of ["provision", "runtime-update"] as const) {
      expect(versionsIn(managedHivraHostReadinessScript("default", purpose, false, "linux-server"))).toEqual(
        purpose === "provision" ? ["2026.11.10.4", "2026.11.10.5", "2026.11.11.1", "2026.11.11.2", "2026.11.11.3", "2026.11.11.4", "2026.11.11.5", "2026.11.11.6", "2026.11.11.7", "2026.11.12.1", "2026.11.12.2", "2026.11.12.3", "2026.11.12.4", "2026.11.12.5", "2026.11.13.1", "2026.11.13.2", "2026.11.13.3", "2026.11.13.4", PORTABLE_HIVRA_PROVISIONER_VERSION] : [PORTABLE_HIVRA_PROVISIONER_VERSION]);
      // DeepSeek Harness needs the release that seeds its launch-time model.
      expect(versionsIn(managedHivraHostReadinessScript("default", purpose, false, "deepseek-harness"))).toEqual(
        purpose === "provision" ? ["2026.11.10.5", "2026.11.11.1", "2026.11.11.2", "2026.11.11.3", "2026.11.11.4", "2026.11.11.5", "2026.11.11.6", "2026.11.11.7", "2026.11.12.1", "2026.11.12.2", "2026.11.12.3", "2026.11.12.4", "2026.11.12.5", "2026.11.13.1", "2026.11.13.2", "2026.11.13.3", "2026.11.13.4", PORTABLE_HIVRA_PROVISIONER_VERSION] : [PORTABLE_HIVRA_PROVISIONER_VERSION]);
    }
    // Hermes is placed only from the release that lets Hivra set its own model (2026.11.12.1) on.
    expect(versionsIn(managedHivraHostReadinessScript("default", "provision", false, "hermes"))).toEqual(["2026.11.12.1", "2026.11.12.2", "2026.11.12.3", "2026.11.12.4", "2026.11.12.5", "2026.11.13.1", "2026.11.13.2", "2026.11.13.3", "2026.11.13.4", PORTABLE_HIVRA_PROVISIONER_VERSION]);
    const desktop = versionsIn(managedHivraHostReadinessScript("default", "provision", false, "linux-desktop"));
    expect(desktop).toContain("2026.11.10.3");
    expect(desktop).toContain(PORTABLE_HIVRA_PROVISIONER_VERSION);
    expect(desktop).toEqual(versionsIn(managedHivraHostReadinessScript("default", "provision", false, null)));
  });

  it("keeps older compatible hosts for other agents", () => {
    for (const runtime of ["claude-code", "codex", null]) {
      expect(versionsIn(managedHivraHostReadinessScript("default", "provision", false, runtime))).toContain("2026.10.20.1");
    }
  });

  it("requires the app version files only for the runtimes that read them", () => {
    expect(managedHivraHostReadinessScript("default", "provision", false, "agent-zero")).toContain('need_file "$PROVISIONER_DIR/agent-app-versions.json"');
    expect(managedHivraHostReadinessScript("default", "provision", false, "agent-zero")).toContain('need_file "$PROVISIONER_DIR/hivra-agent-app-update.sh"');
    expect(managedHivraHostReadinessScript("default", "provision", false, "claude-code")).not.toContain("agent-app-versions.json");
    expect(managedHivraHostReadinessScript("default", "provision")).not.toContain("agent-app-versions.json");
  });

  it("explains that the server needs an update instead of reporting no capacity", async () => {
    const { checkManagedHivraHostReadiness } = await import("../managed-provisioner-readiness");
    const result = await checkManagedHivraHostReadiness(
      { targetId: "t1", env: {}, channel: "default", runtimeId: "agent-zero", runtimeLabel: "Agent Zero" },
      async () => ({ ok: false, stdout: "", stderr: "Hivra provisioner version mismatch", error: "exit 1" }) as never,
    );
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("needs an update before it can run Agent Zero"),
      error: { code: "HIVRA_HOST_NEEDS_UPDATE" } });
  });
});
