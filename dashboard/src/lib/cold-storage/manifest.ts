/**
 * Canonical manifest schema for Hermes cold-storage archives.
 *
 * One JSON file per archive lives at
 *   <storage box>/meta/<instance-id>/<ts>.json
 *
 * The file is written LAST by the archive script (after the data payload)
 * and is considered the source of truth for "archive completed and
 * verifiable". See docs/cold-storage.md §"Manifest schema" and
 * docs/cold-storage-orchestration.md §"Anti-corruption invariants" I1.
 *
 * Both the dashboard runtime (`src/lib/services/cold-storage-service.ts`)
 * and the offline backfill tool (`scripts/ops/backfill-cold-archived.ts`)
 * import from this module.
 */

export type ColdStorageTier = "free" | "paid";

export type ParsedColdStorageManifest = {
  instanceId: string;
  archivedAt: string;
  archiveUri: string;
  archiveSizeBytes: number;
  archiveSha256: string;
  tier: ColdStorageTier;
  sourceProxmoxNode: string;
  sourceProxmoxVmid: number;
  manifestPath: string;
};

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * SEC-02 path-safety character sets. archive_uri values and the compact `ts`
 * token emitted by archive-vm-cold.sh's MANIFEST line both end up
 * interpolated into remote shell commands (`ssh cold "..."`, rsync,
 * restore-vm-cold.sh argv) by cold-storage-service.ts, so the accepted
 * charset must exclude whitespace, quotes, '$', backticks, ';' and '.'
 * entirely — anything a shell could reinterpret — while still accepting
 * every value the scripts legitimately emit.
 */
const COLD_TS_COMPACT_RE = /^[0-9A-Za-z_-]{8,32}$/;
const COLD_ARCHIVE_URI_RE =
  /^(?:free|paid)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/data-([0-9A-Za-z_-]{8,32})\.tar\.zst$/i;

/** True iff `ts` is a safe compact timestamp segment (no shell metacharacters). */
export function isValidColdTimestampCompact(ts: string): boolean {
  return COLD_TS_COMPACT_RE.test(ts);
}

/**
 * True iff `archiveUri` exactly matches the canonical archive layout
 * free|paid/<instance-uuid>/data-<ts>.tar.zst with both segments inside the
 * shell-safe charsets above. Anything else (extra path segments, traversal,
 * metacharacters) must be treated as tampered and never reach a shell.
 */
export function isValidColdArchiveUri(archiveUri: string): boolean {
  return COLD_ARCHIVE_URI_RE.test(archiveUri);
}

function fail(manifestPath: string, field: string, reason: string): never {
  throw new Error(`Invalid cold-storage manifest ${manifestPath}: ${field} ${reason}`);
}

function readObject(raw: string, manifestPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new Error(
      `Invalid cold-storage manifest ${manifestPath}: JSON parse failed (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }

  throw new Error(`Invalid cold-storage manifest ${manifestPath}: expected a JSON object`);
}

function readString(
  manifest: Record<string, unknown>,
  manifestPath: string,
  field: string
): string {
  const value = manifest[field];
  if (typeof value !== "string" || !value.trim()) {
    fail(manifestPath, field, "must be a non-empty string");
  }
  return value.trim();
}

function readPositiveInteger(
  manifest: Record<string, unknown>,
  manifestPath: string,
  field: string
): number {
  const value = manifest[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(manifestPath, field, "must be a positive safe integer");
  }
  return value as number;
}

function canonicalIso(value: string, manifestPath: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail(manifestPath, field, "must be a valid timestamp");
  }
  return new Date(timestamp).toISOString();
}

function assertArchivePath(value: string, manifestPath: string): void {
  if (value.startsWith("/") || value.includes("..") || value.includes("\\")) {
    fail(manifestPath, "archive_path", "must be a relative Storage Box path without traversal");
  }
  if (!/^(free|paid)\/[^/]+\/[^/]+$/.test(value)) {
    fail(
      manifestPath,
      "archive_path",
      "must look like free/<instance-id>/<archive> or paid/<instance-id>/<archive>"
    );
  }
}

export function parseColdStorageManifest(
  raw: string,
  manifestPath: string
): ParsedColdStorageManifest {
  const manifest = readObject(raw, manifestPath);

  if (manifest.schema_version !== 1) {
    fail(manifestPath, "schema_version", "must be 1");
  }

  const instanceId = readString(manifest, manifestPath, "instance_id");
  if (!UUID_RE.test(instanceId)) {
    fail(manifestPath, "instance_id", "must be a UUID");
  }

  const archiveUri = readString(manifest, manifestPath, "archive_path");
  assertArchivePath(archiveUri, manifestPath);

  const archiveSha256 = readString(manifest, manifestPath, "archive_sha256").toLowerCase();
  if (!SHA256_RE.test(archiveSha256)) {
    fail(manifestPath, "archive_sha256", "must be 64 lowercase hex characters");
  }

  const tier = readString(manifest, manifestPath, "tier");
  if (tier !== "free" && tier !== "paid") {
    fail(manifestPath, "tier", "must be free or paid");
  }

  return {
    instanceId,
    archivedAt: canonicalIso(
      readString(manifest, manifestPath, "archived_at"),
      manifestPath,
      "archived_at"
    ),
    archiveUri,
    archiveSizeBytes: readPositiveInteger(manifest, manifestPath, "archive_size_bytes"),
    archiveSha256,
    tier,
    sourceProxmoxNode: readString(manifest, manifestPath, "pve_host"),
    sourceProxmoxVmid: readPositiveInteger(manifest, manifestPath, "vmid"),
    manifestPath,
  };
}

/**
 * Derive the manifest's storage-box path from an archive_uri. Used when the
 * dashboard only stored the archive path (typical post-Phase-1 state) and
 * needs to re-fetch the manifest for integrity checks.
 */
export function manifestPathFromArchiveUri(archiveUri: string): string | null {
  // archive_uri layout: free/<id>/data-<ts>.tar.zst → manifest at meta/<id>/<ts>.json.
  // The segments are pinned to shell-safe charsets (SEC-02): the returned
  // path is interpolated into `ssh cold "cat <path>"` by the service, so a
  // poisoned archive_uri must fail closed to null rather than smuggle
  // metacharacters into the remote command.
  const match = archiveUri.match(COLD_ARCHIVE_URI_RE);
  if (!match) return null;
  const [, id, ts] = match;
  return `meta/${id}/${ts}.json`;
}
