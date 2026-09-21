import { spawnSync } from "node:child_process";

import {
  buildRuntimeReceiptInspectionScript,
  inspectHivraRuntimeReceipt,
  parseRuntimeReceiptSummary,
} from "@/lib/hivra/runtime-receipt-inspection";

const AGENT_ID = "00000000-0000-4000-8000-000000001041";
const SUMMARY = {
  schemaVersion: 2,
  provisionerVersion: "2026.08.30.1",
  releaseApproved: false,
  receiptSha256: "a".repeat(64),
  agentKind: "codex",
  browserEnabled: false,
  substrate: "proxmox-kvm",
  architecture: "x86_64",
  operatingSystemId: "ubuntu",
  operatingSystemVersionId: "22.04",
  systemPackageCount: 431,
  npmGlobalPackageCount: 4,
  artifactCount: 7,
  binaryCount: 10,
  serviceCount: 10,
  activeServiceCount: 3,
  gitCheckoutCount: 1,
  containerImageCount: 0,
  gapCount: 3,
  sbomSha256: "b".repeat(64),
  sbomComponentCount: 453,
  noticeManifestSha256: "c".repeat(64),
  systemNoticeCount: 431,
  npmNoticeCount: 4,
  systemPackagesMissingCopyrightCount: 2,
  npmPackagesWithoutDeclaredLicenseCount: 1,
  npmPackagesWithoutLicenseFilesCount: 2,
} as const;

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: "user_123",
    status: "running",
    desired_state: "running",
    operation_id: null,
    operation_kind: null,
    vmid: 1112,
    ip: "10.250.20.62",
    deployment_mode: "hivra-managed",
    proxmox_host: "fixturenode11",
    infrastructure_binding_token_hash: "b".repeat(64),
    infrastructure_binding_token_enforced: true,
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    loadAgent: jest.fn().mockResolvedValue(agent()),
    resolveContext: jest.fn().mockResolvedValue({
      kind: "managed",
      host: "fixturenode11",
      provisionerChannel: "default",
      env: { PROXMOX_SSH_HOST: "192.0.2.11" },
      paths: { vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator" },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(24)}`,
      infrastructureBindingTagEnforced: true,
    }),
    runHostScript: jest.fn().mockResolvedValue({ ok: true, stdout: `HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify(SUMMARY)}\n`, stderr: "" }),
    ...overrides,
  };
}

describe("runtime receipt inspection", () => {
  it("builds a fixed read-only, identity-bound guest inspection", () => {
    const script = buildRuntimeReceiptInspectionScript({ vmid: 1112, guestIp: "10.250.20.62", vmSshKeyPath: "/root/key", infrastructureBindingTag: "hivra-bind-exact" });
    expect(script).toContain("qm status \"$VMID\"");
    expect(script).toContain("grep -Fxq \"$EXPECTED_BINDING_TAG\"");
    expect(script).toContain('grep -Fxq "ip=$GUEST_IP/24"');
    expect(script).toContain('qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub');
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).not.toContain("StrictHostKeyChecking=no");
    expect(script).toContain("sudo -n /usr/bin/python3 -");
    const encodedProgram = script.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encodedProgram).toBeTruthy();
    const program = Buffer.from(encodedProgram!, "base64").toString("utf8");
    expect(program).toContain("checksum mismatch");
    expect(program).toContain("runtime-sbom.cdx.json");
    expect(program).toContain("recursive-node-modules-v1");
    expect(program).toContain("hivra:source-receipt-sha256");
    expect(program).toContain("unsafe evidence file");
    expect(program).toContain("stat.S_IMODE(info.st_mode)!=0o600");
    expect(program).toContain("processenvironment");
    const syntax = spawnSync("/usr/bin/python3", ["-c", "import sys;compile(sys.stdin.read(),'<runtime-evidence-inspection>','exec')"], {
      encoding: "utf8",
      input: program,
    });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
    const hostSyntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: script });
    expect({ status: hostSyntax.status, stderr: hostSyntax.stderr }).toEqual({ status: 0, stderr: "" });
    expect(script).not.toContain("$COMMAND");
  });

  it("parses only one exact summary shape", () => {
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify(SUMMARY)}\n`)).toEqual(SUMMARY);
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify({ ...SUMMARY, schemaVersion: 1 })}\n`))
      .toEqual({ ...SUMMARY, schemaVersion: 1 });
    expect(parseRuntimeReceiptSummary("missing\n")).toBeNull();
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify({ ...SUMMARY, token: "no" })}\n`)).toBeNull();
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify({ ...SUMMARY, systemPackageCount: 0 })}\n`)).toBeNull();
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify({ ...SUMMARY, operatingSystemId: null })}\n`)).toBeNull();
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify({ ...SUMMARY, operatingSystemVersionId: null })}\n`)).toBeNull();
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify({ ...SUMMARY, sbomComponentCount: 452 })}\n`)).toBeNull();
    expect(parseRuntimeReceiptSummary(`HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ${JSON.stringify({ ...SUMMARY, systemPackagesMissingCopyrightCount: 432 })}\n`)).toBeNull();
  });

  it("fails before infrastructure access for unstable or unbound agents", async () => {
    for (const changed of [{ status: "provisioning" }, { operation_kind: "restart" }, { infrastructure_binding_token_enforced: false }, { ip: "not-an-ip" }]) {
      const deps = dependencies({ loadAgent: jest.fn().mockResolvedValue(agent(changed)) });
      const result = await inspectHivraRuntimeReceipt(AGENT_ID, deps as never);
      expect(result.ok).toBe(false);
      expect(deps.resolveContext).not.toHaveBeenCalled();
      expect(deps.runHostScript).not.toHaveBeenCalled();
    }
  });

  it("returns a verified summary only after the exact host receipt marker", async () => {
    const deps = dependencies();
    const result = await inspectHivraRuntimeReceipt(AGENT_ID, deps as never);
    expect(result).toEqual({ ok: true, agentId: AGENT_ID, targetId: "fixturenode11", vmid: 1112, summary: SUMMARY });
    expect(deps.runHostScript).toHaveBeenCalledWith(expect.stringContaining("VMID=1112"), expect.objectContaining({ PROXMOX_SSH_HOST: "192.0.2.11" }), { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
  });

  it("does not expose host output when receipt verification fails", async () => {
    const deps = dependencies({ runHostScript: jest.fn().mockResolvedValue({ ok: false, stdout: "secret output", stderr: "private error" }) });
    await expect(inspectHivraRuntimeReceipt(AGENT_ID, deps as never)).resolves.toEqual({ ok: false, agentId: AGENT_ID, targetId: "fixturenode11", vmid: 1112, error: "Runtime receipt could not be verified." });
  });
});
