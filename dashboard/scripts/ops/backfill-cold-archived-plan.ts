export {
  parseColdStorageManifest,
  type ColdStorageTier,
  type ParsedColdStorageManifest,
} from "../../src/lib/cold-storage/manifest";

import type { ParsedColdStorageManifest } from "../../src/lib/cold-storage/manifest";

export type ColdArchivedBackfillPatch = {
  lifecycle_state: "cold_archived";
  status: "stopped";
  archive_uri: string;
  archived_at: string;
  archive_size_bytes: number;
  archive_sha256: string;
  archive_count: number;
  lifecycle_substate: null;
  paused_reason: "cold_archived";
  proxmox_node: null;
  proxmox_vmid: null;
  ipv4_address: null;
  last_lifecycle_transition_at: string;
};

export type ColdArchivedBackfillPlanItem = {
  manifest: ParsedColdStorageManifest;
  patch: ColdArchivedBackfillPatch;
};

export type ColdArchivedBackfillPlan = {
  apply: boolean;
  items: ColdArchivedBackfillPlanItem[];
  skippedOlderGenerations: number;
};

export function buildColdArchivedBackfillPatch(
  manifest: ParsedColdStorageManifest,
  options: { nowIso: string; archiveCount?: number }
): ColdArchivedBackfillPatch {
  return {
    lifecycle_state: "cold_archived",
    status: "stopped",
    archive_uri: manifest.archiveUri,
    archived_at: manifest.archivedAt,
    archive_size_bytes: manifest.archiveSizeBytes,
    archive_sha256: manifest.archiveSha256,
    archive_count: options.archiveCount ?? 1,
    lifecycle_substate: null,
    paused_reason: "cold_archived",
    proxmox_node: null,
    proxmox_vmid: null,
    ipv4_address: null,
    last_lifecycle_transition_at: options.nowIso,
  };
}

export function planColdArchivedBackfill(input: {
  manifests: ParsedColdStorageManifest[];
  apply: boolean;
  confirmSourceVmsDestroyed: boolean;
  nowIso: string;
}): ColdArchivedBackfillPlan {
  if (input.apply && !input.confirmSourceVmsDestroyed) {
    throw new Error(
      "Refusing cold-storage backfill apply without --confirm-source-vms-destroyed. Marking rows cold_archived clears Proxmox routing fields."
    );
  }

  const byInstance = new Map<string, ParsedColdStorageManifest[]>();
  for (const manifest of input.manifests) {
    const existing = byInstance.get(manifest.instanceId) ?? [];
    existing.push(manifest);
    byInstance.set(manifest.instanceId, existing);
  }

  const items = Array.from(byInstance.values()).map((generations) => {
    const sorted = [...generations].sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
    const latest = sorted[0];
    return {
      manifest: latest,
      patch: buildColdArchivedBackfillPatch(latest, {
        nowIso: input.nowIso,
        archiveCount: sorted.length,
      }),
    };
  });

  items.sort((a, b) => a.manifest.instanceId.localeCompare(b.manifest.instanceId));

  return {
    apply: input.apply,
    items,
    skippedOlderGenerations: input.manifests.length - items.length,
  };
}
