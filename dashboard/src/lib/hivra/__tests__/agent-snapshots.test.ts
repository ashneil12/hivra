import {
  buildHivraSnapshotCreateScript,
  buildHivraSnapshotObservationScript,
  buildHivraSnapshotRestoreScript,
  parseHivraSnapshotCreateEvidence,
  parseHivraSnapshotObservation,
  parseHivraSnapshotRestoreEvidence,
} from "../agent-snapshots";

const bindingTag = `hivra-bind-${"a".repeat(32)}`;
const snapshotId = "11111111-1111-4111-8111-111111111111";
const providerSnapshotId = `hivra_${snapshotId.replaceAll("-", "")}`;
const operationId = "22222222-2222-4222-8222-222222222222";
const configHash = "b".repeat(64);

describe("Hivra Proxmox restore-point scripts", () => {
  it("creates a disk restore point only under the shared lifecycle lock and exact binding tag", () => {
    const script = buildHivraSnapshotCreateScript({
      vmid: 1112,
      bindingTag,
      providerSnapshotId,
      snapshotId,
      agentId: "33333333-3333-4333-8333-333333333333",
    });
    expect(script).toContain("flock -w 60 8");
    expect(script).toContain('grep -Fxq "$EXPECTED_BINDING_TAG"');
    expect(script).toContain('qm snapshot "$VMID" "$SNAPSHOT"');
    expect(script).toContain("--vmstate 0");
    expect(script).toContain("SNAPSHOT_CONFIG_SHA256");
    expect(script).toContain("HIVRA_SNAPSHOT_READY");
    expect(script).not.toContain("qm delsnapshot");
  });

  it("restores only an exact immutable snapshot receipt and leaves the VM stopped", () => {
    const script = buildHivraSnapshotRestoreScript({
      vmid: 1112,
      bindingTag,
      providerSnapshotId,
      snapshotConfigSha256: configHash,
      operationId,
    });
    expect(script).toContain('qm rollback "$VMID" "$SNAPSHOT"');
    expect(script).toContain('"$OBSERVED_SNAPSHOT_SHA256" = "$EXPECTED_SNAPSHOT_SHA256"');
    expect(script).toContain('"$CURRENT_CONFIG_SHA256" = "$EXPECTED_SNAPSHOT_SHA256"');
    expect(script).toContain("restored VM lost its exact Hivra binding tag");
    expect(script).toContain("HIVRA_RESTORE_APPLIED");
    expect(script).toContain("HIVRA_RESTORE_COMPLETE");
    expect(script).not.toContain("qm start");
  });

  it("excludes only Proxmox rollback metadata that is expected to change", () => {
    const script = buildHivraSnapshotRestoreScript({
      vmid: 1112,
      bindingTag,
      providerSnapshotId,
      snapshotConfigSha256: configHash,
      operationId,
    });
    expect(script).toContain("running-nets-host-mtu|runningcpu|runningmachine");
    expect(script).toContain("snaptime|vmgenid|vmstate");
    expect(script).not.toMatch(/\^\(cores\|memory\|scsi0\|tags\)/);
  });

  it("uses exact, root-owned operation evidence during crash reconciliation", () => {
    const script = buildHivraSnapshotObservationScript({
      vmid: 1112,
      bindingTag,
      providerSnapshotId,
      operationId,
    });
    expect(script).toContain(`/var/lib/hivra/restore-results/1112-${operationId}.restored`);
    expect(script).toContain(`HIVRA_RESTORE_APPLIED ${operationId} ${providerSnapshotId} $CURRENT_SHA`);
    expect(script).toContain("HIVRA_SNAPSHOT_OBSERVED_PRESENT");
  });

  it("accepts exactly one matching create receipt", () => {
    expect(parseHivraSnapshotCreateEvidence(
      `noise\nHIVRA_SNAPSHOT_READY ${providerSnapshotId} running ${configHash}\n`,
      providerSnapshotId,
    )).toEqual({ providerSnapshotId, providerStatus: "running", snapshotConfigSha256: configHash });
    expect(parseHivraSnapshotCreateEvidence(
      `HIVRA_SNAPSHOT_READY ${providerSnapshotId} running ${configHash}\nHIVRA_SNAPSHOT_READY ${providerSnapshotId} running ${configHash}\n`,
      providerSnapshotId,
    )).toBeNull();
  });

  it("rejects restore receipts for the wrong snapshot or configuration", () => {
    expect(parseHivraSnapshotRestoreEvidence(
      `HIVRA_RESTORE_COMPLETE ${providerSnapshotId} stopped ${configHash}\n`,
      providerSnapshotId,
      configHash,
    )).toEqual({ providerSnapshotId, providerStatus: "stopped", snapshotConfigSha256: configHash });
    expect(parseHivraSnapshotRestoreEvidence(
      `HIVRA_RESTORE_COMPLETE ${providerSnapshotId} stopped ${"c".repeat(64)}\n`,
      providerSnapshotId,
      configHash,
    )).toBeNull();
  });

  it("parses provider observation without inferring a missing receipt", () => {
    expect(parseHivraSnapshotObservation([
      "HIVRA_SNAPSHOT_OBSERVED_STATUS stopped",
      `HIVRA_SNAPSHOT_OBSERVED_PRESENT ${configHash}`,
      `HIVRA_SNAPSHOT_OBSERVED_CURRENT ${configHash}`,
    ].join("\n"))).toEqual({
      providerStatus: "stopped",
      snapshotConfigSha256: configHash,
      currentConfigSha256: configHash,
      restoreReceiptMatches: false,
    });
  });

  it("rejects unbound or malformed provider identities before shell interpolation", () => {
    expect(() => buildHivraSnapshotCreateScript({
      vmid: 1112,
      bindingTag: "",
      providerSnapshotId,
      snapshotId,
      agentId: "agent",
    })).toThrow(/binding tag/i);
    expect(() => buildHivraSnapshotRestoreScript({
      vmid: 1112,
      bindingTag,
      providerSnapshotId: "../../foreign",
      snapshotConfigSha256: configHash,
      operationId,
    })).toThrow(/snapshot id/i);
  });
});
