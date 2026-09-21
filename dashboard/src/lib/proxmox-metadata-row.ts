// Shared predicate for the Proxmox stale-metadata recovery paths. Extracted
// from three identical copies in recover-orphan-provisioning.ts,
// recreate-missing-proxmox-instance.ts, and services/instance-service.ts so the
// safety-critical "active states" set stays in sync across all of them.
//
// A row's stale Proxmox metadata is safe to clear only when the row is NOT
// actively in-flight. Widening to "anything not actively in-flight" (rather
// than matching exact terminal states) prevents an orphan class observed
// 2026-05-12: a paused/stopped row whose VM had been reaped, where a fresh
// provision re-allocated the same VMID → conflict → recovery refused.
const ACTIVE_STATES = new Set([
  "running",
  "active",
  "provisioning",
  "redeploying",
]);

export function isClearableStaleProxmoxMetadataRow(row: {
  status?: string | null;
  lifecycle_state?: string | null;
}): boolean {
  const status = (row.status ?? "").toLowerCase();
  const lifecycle = (row.lifecycle_state ?? "").toLowerCase();
  return !ACTIVE_STATES.has(status) && !ACTIVE_STATES.has(lifecycle);
}
