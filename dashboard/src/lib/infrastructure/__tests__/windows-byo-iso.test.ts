/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SelfManagedProxmoxExecutionContext } from "../proxmox-execution-context";
import { PORTABLE_HIVRA_PROVISIONER_VERSION, PORTABLE_HIVRA_RUNTIME_COMPATIBILITY } from "../portable-provisioner-contract";
import {
  WINDOWS_BYO_ISO_PROTOCOL,
  WINDOWS_ISO_DOWNLOAD_PROTOCOL,
  WINDOWS_ISO_STORAGE_PROTOCOL,
  WINDOWS_BYO_ISO_TERMS_VERSION,
  WindowsIsoDownloadSchema,
  WindowsByoIsoLaunchSchema,
  WindowsByoIsoError,
  buildWindowsIsoInventoryScript,
  buildWindowsIsoDownloadStatusScript,
  buildWindowsIsoProvisionScript,
  buildWindowsIsoReconciliationScript,
  launchWindowsByoIso,
  listWindowsIsoImages,
  getWindowsIsoDownloadStatus,
  startWindowsIsoDownload,
  validateMicrosoftWindowsIsoUrl,
} from "../windows-byo-iso";

const connectionId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const agentId = "55555555-5555-4555-8555-555555555555";
const isoVolume = "local:iso/Win11_24H2_English_x64.iso";
const mediaEvidence = { sizeBytes: 6_123_456_789, modifiedAtSeconds: 1_757_934_000, fileIdentitySha256: "c".repeat(64) };
const bindingHash = "b".repeat(64);
type TestDatabase = NonNullable<NonNullable<Parameters<typeof launchWindowsByoIso>[3]>["database"]>;

function context(): SelfManagedProxmoxExecutionContext {
  return {
    kind: "self-managed", connectionId, targetId, connectionRevision: 7, env: {},
    runtime: { node: "node-a", bridge: "vmbr0", storage: "local-lvm", vmidStart: 200, vmidEnd: 299,
      ipLastOctetStart: 50, subnetPrefix: "10.251.20", gateway: "10.251.20.1", provisionerDirectory: "/opt/hivra/provisioner",
      provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, ubuntuImage: "/unused", vmSshKeyPath: "/unused", logDirectory: "/unused" },
    target: {
      id: targetId, connectionId, evidenceConnectionRevision: 7, externalId: "node-a", displayName: "My Proxmox / node-a",
      status: "ready", capacity: { cpu: { totalCores: 16, utilizationRatio: 0.1 },
        memoryBytes: { total: 64 * 1024 ** 3, available: 48 * 1024 ** 3 },
        storageBytes: { total: 1024 * 1024 ** 3, available: 800 * 1024 ** 3 } },
      capabilities: { proxmoxVersion: "8.4.1", launchReady: true, directRootAccess: true, kvmAvailable: true,
        bridges: ["vmbr0"], selectedBridge: "vmbr0", storages: ["local-lvm"], selectedStorage: "local-lvm",
        template: null, provisioner: { configured: true, ready: true, version: PORTABLE_HIVRA_PROVISIONER_VERSION },
        runtimeCompatibility: { ...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY,
          supportedCatalogRuntimeIds: [...PORTABLE_HIVRA_RUNTIME_COMPATIBILITY.supportedCatalogRuntimeIds] },
        vmidRange: { start: 200, end: 299, freeCount: 100, firstAvailable: 200 }, issues: [] },
      supportedIsolationDrivers: ["proxmox-kvm"], isolationClass: "hardware-vm", lastPreflightAt: "2026-09-15T10:00:00.000Z",
      lastErrorCode: null, createdAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:00:00.000Z",
    },
  };
}

const input = {
  connectionId, targetId, expectedConnectionRevision: 7, launchRequestId: requestId,
  name: "MY_WINDOWS_DESKTOP", isoVolume, cpu: 4, ram: 8, diskGb: 64,
  mediaEvidence,
  mediaSource: "unknown" as const,
  rightsAttested: true as const, termsVersion: WINDOWS_BYO_ISO_TERMS_VERSION,
};

function inventoryOutput() {
  return `${WINDOWS_ISO_STORAGE_PROTOCOL}\t${Buffer.from("local").toString("base64")}\n${WINDOWS_BYO_ISO_PROTOCOL}\t${Buffer.from(isoVolume).toString("base64")}\t${Buffer.from("Win11_24H2_English_x64.iso").toString("base64")}\t${mediaEvidence.sizeBytes}\t${mediaEvidence.modifiedAtSeconds}\t${mediaEvidence.fileIdentitySha256}\tunknown\n`;
}

describe("customer-owned Windows ISO contract", () => {
  it("requires rights attestation and rejects product keys or arbitrary URLs", () => {
    expect(WindowsByoIsoLaunchSchema.safeParse({ ...input, rightsAttested: false }).success).toBe(false);
    expect(WindowsByoIsoLaunchSchema.safeParse({ ...input, productKey: "AAAAA-BBBBB", rightsAttested: true }).success).toBe(false);
    expect(WindowsByoIsoLaunchSchema.safeParse({ ...input, isoVolume: "https://example.test/windows.iso" }).success).toBe(false);
  });

  it("lists only bounded pre-uploaded Proxmox ISO volumes", async () => {
    const runHostScript = jest.fn(async () => ({ ok: true, stdout: inventoryOutput()
      + `${WINDOWS_BYO_ISO_PROTOCOL}\t${Buffer.from("local:iso/../../secret.iso").toString("base64")}\tYmFkLmlzbw==\t10\t1\t${"d".repeat(64)}\n`, stderr: "" }));
    const result = await listWindowsIsoImages("owner", input, { resolveContext: jest.fn(async () => context()), runHostScript });
    expect(result).toMatchObject({ images: [{ volume: isoVolume, name: "Win11_24H2_English_x64.iso", ...mediaEvidence, source: "unknown" }], storages: [{ id: "local", label: "local" }] });
    expect(buildWindowsIsoInventoryScript()).not.toMatch(/curl|wget|https?:\/\//);
  });

  it("accepts inventory provenance only when the conservative filename classification agrees", async () => {
    const line = (volume: string, name: string, source: string) =>
      `${WINDOWS_BYO_ISO_PROTOCOL}\t${Buffer.from(volume).toString("base64")}\t${Buffer.from(name).toString("base64")}\t${mediaEvidence.sizeBytes}\t${mediaEvidence.modifiedAtSeconds}\t${mediaEvidence.fileIdentitySha256}\t${source}\n`;
    const stdout = `${WINDOWS_ISO_STORAGE_PROTOCOL}\t${Buffer.from("local").toString("base64")}\n`
      + line("local:iso/Win11_good.iso", "Win11_good.iso", "windows-11")
      + line("local:iso/Win11_cross-labelled.iso", "Win11_cross-labelled.iso", "windows-server-evaluation")
      + line("local:iso/SERVER_EVAL_x64.iso", "SERVER_EVAL_x64.iso", "windows-server-evaluation");
    const result = await listWindowsIsoImages("owner", input, {
      resolveContext: jest.fn(async () => context()),
      runHostScript: jest.fn(async () => ({ ok: true, stdout, stderr: "" })),
    });
    expect(result.images.map(image => [image.name, image.source])).toEqual([
      ["SERVER_EVAL_x64.iso", "windows-server-evaluation"],
      ["Win11_cross-labelled.iso", "unknown"],
      ["Win11_good.iso", "windows-11"],
    ]);
  });

  it("accepts only final direct Microsoft CDN ISO URLs", () => {
    const accepted = "https://software.download.prss.microsoft.com/dbazure/Win11_24H2_English_x64.iso?t=short-lived";
    expect(validateMicrosoftWindowsIsoUrl(accepted)).toEqual({ url: accepted, filename: "Win11_24H2_English_x64.iso", source: "windows-11" });
    expect(validateMicrosoftWindowsIsoUrl("https://download.microsoft.com/download/Server_EVAL_x64FRE_en-us.iso"))
      .toMatchObject({ filename: "Server_EVAL_x64FRE_en-us.iso", source: "windows-server-evaluation" });
    for (const rejected of [
      "http://software.download.prss.microsoft.com/Windows.iso",
      "https://user:pass@software.download.prss.microsoft.com/Windows.iso",
      "https://software.download.prss.microsoft.com:444/Windows.iso",
      "https://software.download.prss.microsoft.com/Windows.iso#fragment",
      "https://go.microsoft.com/fwlink/?linkid=1",
      "https://aka.ms/WinServ2025iso-enus",
      "https://127.0.0.1/Windows.iso",
      "https://download.microsoft.com/download/not-an-iso.exe",
      "https://download.microsoft.com/download/%2e%2e.iso",
      "https://download.microsoft.com/download/Windows_11.iso",
      "https://download.microsoft.com/download/Server_2025_x64.iso",
    ]) expect(() => validateMicrosoftWindowsIsoUrl(rejected)).toThrow(WindowsByoIsoError);
  });

  it("rejects a client media label that disagrees with the official filename", async () => {
    const resolveContext = jest.fn();
    await expect(startWindowsIsoDownload("owner", {
      connectionId, targetId, expectedConnectionRevision: 7,
      source: "windows-server-evaluation",
      storage: "local",
      directUrl: "https://software.download.prss.microsoft.com/dbazure/Win11_25H2_English_x64.iso?t=expires",
      rightsAttested: true,
      termsVersion: WINDOWS_BYO_ISO_TERMS_VERSION,
    }, { resolveContext })).rejects.toMatchObject({ code: "invalid_request" });
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it("starts one bounded host-side async download and never overwrites the final ISO", async () => {
    const download = {
      connectionId, targetId, expectedConnectionRevision: 7,
      source: "windows-11" as const,
      storage: "local",
      directUrl: "https://software.download.prss.microsoft.com/dbazure/Win11_25H2_English_x64.iso?t=expires",
      rightsAttested: true as const,
      termsVersion: WINDOWS_BYO_ISO_TERMS_VERSION,
    };
    expect(WindowsIsoDownloadSchema.safeParse(download).success).toBe(true);
    const runHostScript = jest.fn().mockResolvedValueOnce({ ok: true, stdout: inventoryOutput(), stderr: "" });
    const runHostScriptWithStdin = jest.fn()
      .mockImplementationOnce(async (script: string) => {
        const taskId = script.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
        return { ok: true, stdout: `${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\t${taskId}\tZmlsZS5pc28=\tbG9jYWw=\n`, stderr: "" };
      });
    const result = await startWindowsIsoDownload("owner", download, { resolveContext: jest.fn(async () => context()), runHostScript, runHostScriptWithStdin });
    expect(result).toMatchObject({ state: "queued", filename: "Win11_25H2_English_x64.iso", storage: "local" });
    const script = runHostScriptWithStdin.mock.calls[0][0] as string;
    expect(runHostScriptWithStdin.mock.calls[0][1]).toBe(`${download.directUrl}\n`);
    expect(script).toContain("systemd-run");
    expect(script).toContain("--no-block");
    expect(script).toContain("--property=RuntimeMaxSec=12h");
    expect(script).toContain("--max-time 43200");
    expect(script).toContain("--unit=hivra-winiso-download");
    expect(script).toContain("--head");
    expect(script).toContain("Content-Length");
    expect(script).toContain("df -PB1");
    expect(script).toContain("ulimit -f 16777216");
    expect(script).toContain("HIVRA_EXPECTED_SIZE");
    expect(script).toContain("mkfifo -- \"$REQUEST\"");
    expect(script).toContain("timeout 15s tee \"$REQUEST\"");
    expect(script).toContain("IFS= read -r URL <\"$REQUEST\"");
    expect(script).toContain("systemctl stop hivra-winiso-download.service");
    expect(script).not.toContain("url = \"$DIRECT_URL\" >\"$REQUEST\"");
    expect(script).toContain("--max-redirs 0");
    expect(script).toMatch(/--proto [^\n]*=https/);
    expect(script).toContain(".part");
    expect(script).toContain("mv -n -- \"$PART\" \"$FINAL\"");
    expect(script).toContain("[ -e \"$PART\" ]");
    expect(script).not.toContain("mv -f \"$PART\" \"$FINAL\"");
    expect(script).not.toContain("pvesm download-url");
    expect(script).not.toContain(download.directUrl);
    expect(spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" })).toMatchObject({ status: 0, stderr: "" });
  });

  it("reads only a UUID-bound host task status", async () => {
    const status = await getWindowsIsoDownloadStatus("owner", {
      connectionId, targetId, expectedConnectionRevision: 7, taskId: requestId,
    }, {
      resolveContext: jest.fn(async () => context()),
      runHostScript: jest.fn(async () => ({ ok: true, stdout: `${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\trunning\t1073741824\t\n`, stderr: "" })),
    });
    expect(status).toEqual({ taskId: requestId, state: "running", bytesDownloaded: 1073741824, message: null });
    expect(buildWindowsIsoDownloadStatusScript(requestId)).not.toMatch(/curl|wget|https?:\/\//);
    expect(buildWindowsIsoDownloadStatusScript(requestId)).toContain("systemctl show");
    expect(buildWindowsIsoDownloadStatusScript(requestId)).toContain("rm -f -- \"$part\"");
    expect(buildWindowsIsoDownloadStatusScript(requestId)).not.toContain("rm -f -- \"$FINAL\"");
  });

  it("parses actual Proxmox list columns and a real tab delimiter into stable media evidence", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "hivra-windows-iso-"));
    const bin = path.join(fixture, "bin");
    const isoPath = path.join(fixture, "Win11_24H2_English_x64.iso");
    mkdirSync(bin); writeFileSync(isoPath, "fixture");
    writeFileSync(path.join(bin, "pvesm"), `#!/bin/sh
case "$1" in
status) printf 'Name Type Status Total Used Available %%\nlocal dir active 1 0 1 0%%\n';;
list) printf 'Volid Format Type Size VMID\n${isoVolume} iso iso ${mediaEvidence.sizeBytes} -\n';;
path) printf '%s\n' '${isoPath}';;
*) exit 1;; esac
`);
    writeFileSync(path.join(bin, "stat"), `#!/bin/sh
printf '2049\t77881\t${mediaEvidence.sizeBytes}\t${mediaEvidence.modifiedAtSeconds}\t${mediaEvidence.modifiedAtSeconds + 12}\n'
`);
    writeFileSync(path.join(bin, "sha256sum"), `#!/bin/sh
cat >/dev/null
printf '${mediaEvidence.fileIdentitySha256}  -\n'
`);
    for (const name of ["pvesm", "stat", "sha256sum"]) chmodSync(path.join(bin, name), 0o755);
    const executed = spawnSync("/bin/bash", ["-c", buildWindowsIsoInventoryScript()], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    });
    rmSync(fixture, { recursive: true, force: true });
    expect({ status: executed.status, stderr: executed.stderr }).toEqual({ status: 0, stderr: "" });
    expect(executed.stdout).toBe(inventoryOutput());
    expect(buildWindowsIsoInventoryScript()).toContain("stat -L --printf='%d");
    expect(buildWindowsIsoInventoryScript()).toContain("%i");
    expect(buildWindowsIsoInventoryScript()).toContain("%Z");
    expect(buildWindowsIsoInventoryScript()).toContain('[ "$source_file_identity" = "$file_identity_sha" ]');
    expect(buildWindowsIsoInventoryScript()).toContain('[ "$observed_source" = "$derived_source" ]');
    expect(buildWindowsIsoInventoryScript()).toContain('"$path" "$device" "$inode" "$size" "$modified_at" "$changed_at"');
  });

  it("fails closed before host access when exact capability evidence is insufficient", async () => {
    const stale = context(); stale.target.capabilities.kvmAvailable = false;
    const runHostScript = jest.fn();
    await expect(listWindowsIsoImages("owner", input, { resolveContext: jest.fn(async () => stale), runHostScript }))
      .rejects.toBeInstanceOf(WindowsByoIsoError);
    expect(runHostScript).not.toHaveBeenCalled();
  });

  it("stamps server identity/time, persists no key, revalidates target and launches idempotently", async () => {
    const insert = jest.fn((value: Record<string, unknown>) => {
      void value;
      return { select: () => ({
        single: async () => ({ data: { id: agentId, name: input.name, status: "provisioning" }, error: null }),
      }) };
    });
    const rpc = jest.fn()
      .mockResolvedValueOnce({ data: { status: "reserved", operationId, agentId, bindingHash }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const database = { from: jest.fn(() => ({ insert })), rpc } as unknown as TestDatabase;
    const resolveContext = jest.fn(async () => context());
    const runHostScript = jest.fn()
      .mockResolvedValueOnce({ ok: true, stdout: inventoryOutput(), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_WINDOWS_RESULT\t200\n", stderr: "" });
    const result = await launchWindowsByoIso("owner", "clerk:owner", input, { database, resolveContext, runHostScript,
      now: () => new Date("2026-09-15T12:00:00.000Z") });
    expect(result).toMatchObject({ id: agentId, vmid: 200 });
    expect(resolveContext).toHaveBeenCalledTimes(2);
    const stored = insert.mock.calls[0][0];
    expect(stored).toMatchObject({ computer_profile: "windows", windows_iso_volume: isoVolume,
      allocation_operation_id: operationId,
      operation_payload: { stage: "windows_owner_installation", windowsMediaSource: "unknown" },
      windows_iso_source: "unknown",
      windows_iso_size_bytes: mediaEvidence.sizeBytes,
      windows_iso_modified_at_seconds: mediaEvidence.modifiedAtSeconds,
      windows_iso_file_identity_sha256: mediaEvidence.fileIdentitySha256,
      windows_rights_attested_by: "clerk:owner", windows_rights_attested_at: "2026-09-15T12:00:00.000Z",
      windows_rights_terms_version: WINDOWS_BYO_ISO_TERMS_VERSION });
    expect(JSON.stringify(stored)).not.toMatch(/product.?key|activation.?key/i);
    const provision = runHostScript.mock.calls[1][0] as string;
    expect(provision).toContain(`hivra-operation-${operationId}`);
    expect(provision).toContain(`hivra-op-${operationId.replace(/-/g, "")}`);
    expect(provision).toContain("--ostype win11");
    expect(provision).not.toMatch(/curl|wget|https?:\/\//);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_operation_id: operationId, p_vmid: 200 });
    expect(JSON.stringify(result)).not.toMatch(/binding|attested_by/i);
  });

  it("rejects a launch when the client media source disagrees with host inventory", async () => {
    const database = {
      from: jest.fn(),
      rpc: jest.fn(async () => ({ data: { status: "reserved", operationId, agentId, bindingHash }, error: null })),
    } as unknown as TestDatabase;
    await expect(launchWindowsByoIso("owner", "owner", { ...input, mediaSource: "windows-server-evaluation" }, {
      database,
      resolveContext: jest.fn(async () => context()),
      runHostScript: jest.fn(async () => ({ ok: true, stdout: inventoryOutput(), stderr: "" })),
    })).rejects.toMatchObject({ code: "iso_unavailable" });
    expect(database.from).not.toHaveBeenCalled();
  });

  it("returns the original computer on an identical retry without touching the host", async () => {
    const original = { id: agentId, name: input.name, status: "provisioning", computer_profile: "windows" };
    const database = { from: jest.fn(), rpc: jest.fn(async () => ({ data: { status: "existing", agent: original }, error: null })) } as unknown as TestDatabase;
    const resolveContext = jest.fn(); const runHostScript = jest.fn();
    await expect(launchWindowsByoIso("owner", "owner", input, { database, resolveContext, runHostScript })).resolves.toEqual(original);
    expect(resolveContext).not.toHaveBeenCalled();
    expect(runHostScript).not.toHaveBeenCalled();
  });

  it("reconciles exactly one owned VM on pending retry without creating another", async () => {
    const rpc = jest.fn()
      .mockResolvedValueOnce({ data: { status: "pending", operationId, agentId, bindingHash }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const database = { from: jest.fn(), rpc } as unknown as TestDatabase;
    const resolveContext = jest.fn(async () => context());
    const runHostScript = jest.fn()
      .mockResolvedValueOnce({ ok: true, stdout: inventoryOutput(), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_WINDOWS_RESULT\t200\n", stderr: "" });
    await expect(launchWindowsByoIso("owner", "owner", input, { database, resolveContext, runHostScript }))
      .resolves.toMatchObject({ id: agentId, vmid: 200 });
    expect(database.from).not.toHaveBeenCalled();
    const reconciliation = runHostScript.mock.calls[1][0] as string;
    expect(reconciliation).toContain(`hivra-operation-${operationId}`);
    expect(reconciliation).toContain(`hivra-agent-${agentId}`);
    expect(reconciliation).not.toContain("qm create");
  });

  it("recovers an accept crash by reconciling the existing VM on the identical retry", async () => {
    const rpc = jest.fn()
      .mockResolvedValueOnce({ data: { status: "reserved", operationId, agentId, bindingHash }, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("accept response lost") })
      .mockResolvedValueOnce({ data: { status: "pending", operationId, agentId, bindingHash }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    const insert = jest.fn(() => ({ select: () => ({ single: async () => ({
      data: { id: agentId, name: input.name, status: "provisioning" }, error: null,
    }) }) }));
    const database = { from: jest.fn(() => ({ insert })), rpc } as unknown as TestDatabase;
    const resolveContext = jest.fn(async () => context());
    const runHostScript = jest.fn()
      .mockResolvedValueOnce({ ok: true, stdout: inventoryOutput(), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_WINDOWS_RESULT\t200\n", stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: inventoryOutput(), stderr: "" })
      .mockResolvedValueOnce({ ok: true, stdout: "HIVRA_WINDOWS_RESULT\t200\n", stderr: "" });

    await expect(launchWindowsByoIso("owner", "owner", input, { database, resolveContext, runHostScript }))
      .rejects.toMatchObject({ code: "provision_uncertain" });
    await expect(launchWindowsByoIso("owner", "owner", input, { database, resolveContext, runHostScript }))
      .resolves.toMatchObject({ id: agentId, vmid: 200 });

    expect(insert).toHaveBeenCalledTimes(1);
    expect((runHostScript.mock.calls[1][0] as string)).toContain("qm create");
    expect((runHostScript.mock.calls[3][0] as string)).not.toContain("qm create");
  });

  it("fails closed when pending host reconciliation is absent or ambiguous", async () => {
    for (const result of [
      { ok: false, stdout: "", stderr: "missing" },
      { ok: false, stdout: "HIVRA_WINDOWS_RESULT\t200\nHIVRA_WINDOWS_RESULT\t201\n", stderr: "ambiguous" },
    ]) {
      const database = { from: jest.fn(), rpc: jest.fn(async () => ({ data: { status: "pending", operationId, agentId, bindingHash }, error: null })) } as unknown as TestDatabase;
      const runHostScript = jest.fn().mockResolvedValueOnce({ ok: true, stdout: inventoryOutput(), stderr: "" }).mockResolvedValueOnce(result);
      await expect(launchWindowsByoIso("owner", "owner", input, { database, resolveContext: jest.fn(async () => context()), runHostScript }))
        .rejects.toMatchObject({ code: "provision_uncertain" });
      expect(database.from).not.toHaveBeenCalled();
      expect(runHostScript.mock.calls[1][0]).not.toContain("qm create");
    }
  });

  it("binds the generated provisioner to one operation and customer ISO", () => {
    const script = buildWindowsIsoProvisionScript(input, operationId, agentId, "a".repeat(64), context());
    expect(script).toContain("flock -x");
    expect(script).toContain("HIVRA_WINDOWS_RESULT");
    expect(script).toContain(`hivra-bind-${"a".repeat(32)}`);
    expect(script).toContain("local:iso/Win11_24H2_English_x64.iso");
    expect(script).toContain(`EXPECTED_MTIME=${mediaEvidence.modifiedAtSeconds}`);
    expect(script).toContain('"$ISO_PATH" "$DEVICE" "$INODE" "$SIZE" "$MTIME" "$CTIME"');
    expect(script.indexOf("verify_iso ||", script.indexOf("flock -x"))).toBeLessThan(script.indexOf("qm create"));
    expect(script).not.toContain("Microsoft.com");
    expect(buildWindowsIsoReconciliationScript(input, operationId, agentId, bindingHash)).not.toContain("qm create");
  });
});
