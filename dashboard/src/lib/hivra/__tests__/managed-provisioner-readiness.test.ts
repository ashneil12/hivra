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
