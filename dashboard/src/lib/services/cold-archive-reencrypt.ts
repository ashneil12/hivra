/**
 * Re-encryption sweep: turns PLAIN cold archives (archive_uri not ending in ".age")
 * into age-encrypted ones, one instance at a time, and removes the plain copy.
 *
 * Triggered by an operator through POST /api/admin/reencrypt-cold-archives. It is NOT a
 * cron. Gated by HERMES_BACKUP_REENCRYPT_SWEEP (off | dry | on), default off, and it also
 * requires HERMES_BACKUP_ENCRYPTION=on with a valid HERMES_BACKUP_AGE_RECIPIENT.
 *
 * ORDER OF OPERATIONS (chosen so a restore can never find a missing archive):
 *
 *   1. Claim a still-idle `cold_archived` row. Restore and deletion share the claim boundary.
 *   2. Host script `--apply --keep-plain`: download plain, check sha, age-encrypt, upload
 *      `<uri>.age`, verify size + re-download sha, rewrite the manifest. The PLAIN archive is
 *      NOT deleted. The DB row still points at the plain archive, which still exists.
 *   3. DB compare-and-set: UPDATE archive_uri/archive_sha256/archive_size_bytes to the
 *      encrypted values WHERE id AND archive_uri = <old uri> AND lifecycle_state =
 *      'cold_archived'. If a restore or archive moved the row meanwhile the update touches
 *      zero rows and we STOP: the plain copy is left in place.
 *   4. Only after the CAS landed: host script `--delete-plain` (re-confirms the .age copy
 *      and manifest on the Storage Box, then deletes the plain archive). If that fails the
 *      row is still correct (it points at the .age copy); only a stray plain copy remains,
 *      reported as plainDeleted=false and removed on a later `--delete-plain`.
 *
 * So the plain copy is deleted strictly after: encrypted copy verified, manifest written, DB
 * updated. A crash or failure between any two steps leaves a restorable row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AGE_RECIPIENT_RE,
  resolveBackupEncryption,
} from "@/lib/cold-storage/backup-encryption";
import { isValidColdArchiveUri } from "@/lib/cold-storage/manifest";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildColdStorageScriptInstall } from "./cold-storage-host-scripts";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
  type HostScriptResult,
} from "./proxmox-instance-service";

type EnvLike = Record<string, string | undefined>;

export type ReencryptSweepMode =
  | { mode: "off" }
  | { mode: "dry" | "on"; recipient: string }
  | { mode: "error"; error: string };

/** Resolve HERMES_BACKUP_REENCRYPT_SWEEP together with the encryption prerequisites. */
export function resolveReencryptSweep(env: EnvLike = process.env): ReencryptSweepMode {
  const raw = (env.HERMES_BACKUP_REENCRYPT_SWEEP ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return { mode: "off" };
  if (raw !== "dry" && raw !== "on") {
    return {
      mode: "error",
      error: 'HERMES_BACKUP_REENCRYPT_SWEEP has an unrecognised value; use "off", "dry" or "on".',
    };
  }
  const encryption = resolveBackupEncryption(env);
  if (!encryption.enabled) {
    return { mode: "error", error: "HERMES_BACKUP_REENCRYPT_SWEEP requires HERMES_BACKUP_ENCRYPTION=on." };
  }
  if (!encryption.ok) return { mode: "error", error: encryption.error };
  if (!AGE_RECIPIENT_RE.test(encryption.recipient)) {
    return { mode: "error", error: "HERMES_BACKUP_AGE_RECIPIENT is not a valid age public key." };
  }
  return { mode: raw, recipient: encryption.recipient };
}

const LOG_PREFIX = "[cold-archive-reencrypt]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const SCRIPT_PATH = "/usr/local/sbin/reencrypt-cold-archive.sh";

export const REENCRYPT_DEFAULT_LIMIT = 2;
export const REENCRYPT_MAX_LIMIT = 5;
/** Don't start a row with less than this much wall clock left (download + encrypt + upload + verify). */
const MIN_VIABLE_ROW_MS = 120_000;
const TAIL_HEADROOM_MS = 45_000;
const DELETE_STEP_TIMEOUT_MS = 60_000;
const REENCRYPT_CLAIM = "cold_archive_reencrypt";
const REENCRYPT_WRITER_EXITED = "HERMES_COLD_REENCRYPT_WRITER_EXITED";

export type ReencryptOutcome =
  | { instanceId: string; status: "would_reencrypt"; archiveUri: string }
  | {
      instanceId: string;
      status: "reencrypted";
      oldUri: string;
      newUri: string;
      encSha256: string;
      encSizeBytes: number;
      plainDeleted: boolean;
    }
  | {
      instanceId: string;
      status: "skipped_busy" | "skipped_invalid" | "skipped_deadline" | "cas_lost" | "host_script_failed" | "bad_result" | "db_update_failed";
      message: string;
    };

export type ReencryptSweepResult = {
  mode: "dry" | "on";
  scanned: number;
  nextCursor: string | null;
  outcomes: ReencryptOutcome[];
};

export type ReencryptDeps = {
  runHostScript?: (script: string, env: EnvLike, options?: { timeoutMs?: number }) => Promise<HostScriptResult>;
  now?: () => number;
  env?: EnvLike;
};

type CandidateRow = {
  id: string;
  lifecycle_state: string | null;
  archive_uri: string | null;
  archive_sha256: string | null;
  archive_size_bytes: number | null;
};

export function parseReencryptResult(stdout: string): Map<string, string> | null {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("REENCRYPT_RESULT "));
  if (!line) return null;
  const out = new Map<string, string>();
  for (const token of line.trim().split(/\s+/).slice(1)) {
    const eq = token.indexOf("=");
    if (eq > 0) out.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return out;
}

function buildCommand(recipient: string | null, uri: string, args: string[]): string {
  const prefix = recipient ? `HERMES_BACKUP_AGE_RECIPIENT=${recipient} ` : "";
  return `${buildColdStorageScriptInstall("reencrypt-cold-archive.sh")}
${prefix}${SCRIPT_PATH} ${shellQuote(uri)} ${args.join(" ")}`;
}

export async function runReencryptSweep(
  supabase: SupabaseClient,
  sweep: Exclude<ReencryptSweepMode, { mode: "off" } | { mode: "error" }>,
  options: { hostSlug: string; limit?: number; cursor?: string | null; deadlineMs?: number },
  deps: ReencryptDeps = {}
): Promise<ReencryptSweepResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const runHostScript =
    deps.runHostScript ?? ((script, e, o) => runProxmoxHostScript(script, e, o as never));
  const limit = Math.max(1, Math.min(REENCRYPT_MAX_LIMIT, Math.floor(options.limit ?? REENCRYPT_DEFAULT_LIMIT)));
  const deadline = options.deadlineMs ?? now() + 600_000;

  // Keyset page of cold_archived rows whose archive is still plain.
  let query = supabase
    .from("hermes_instances")
    .select("id, lifecycle_state, archive_uri, archive_sha256, archive_size_bytes")
    .eq("lifecycle_state", "cold_archived")
    .not("archive_uri", "is", null)
    .not("archive_uri", "like", "%.age")
    .is("deleted_at", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (options.cursor) query = query.gt("id", options.cursor);
  const { data, error } = await query;
  if (error) throw new Error(`${LOG_PREFIX} candidate query failed: ${error.message}`);
  const rows = (data ?? []) as CandidateRow[];

  const outcomes: ReencryptOutcome[] = [];
  for (const row of rows) {
    outcomes.push(await processRow(row));
  }
  return {
    mode: sweep.mode,
    scanned: rows.length,
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    outcomes,
  };

  async function processRow(row: CandidateRow): Promise<ReencryptOutcome> {
    const id = row.id;
    const uri = row.archive_uri ?? "";
    const sha = row.archive_sha256 ?? "";
    if (
      !UUID_RE.test(id) ||
      !isValidColdArchiveUri(uri) ||
      uri.endsWith(".age") ||
      !uri.includes(`/${id}/`) ||
      !SHA_RE.test(sha)
    ) {
      return { instanceId: id, status: "skipped_invalid", message: "archive_uri/sha failed validation; not touched" };
    }
    if (sweep.mode === "dry") return { instanceId: id, status: "would_reencrypt", archiveUri: uri };

    const remaining = deadline - now();
    if (remaining < MIN_VIABLE_ROW_MS) {
      return { instanceId: id, status: "skipped_deadline", message: "not enough wall-clock left; retry from this cursor" };
    }

    const hostEnv = resolveProxmoxHostEnv(
      { hostId: null, hostSlug: options.hostSlug, envPrefix: null, failClosed: true },
      env
    );
    const claimedAt = new Date(now()).toISOString();
    const claim = await supabase.from("hermes_instances")
      .update({ lifecycle_substate: REENCRYPT_CLAIM, last_lifecycle_transition_at: claimedAt })
      .eq("id", id)
      .eq("lifecycle_state", "cold_archived")
      .eq("archive_uri", uri)
      .eq("archive_sha256", sha)
      .is("lifecycle_substate", null)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (claim.error) return { instanceId: id, status: "db_update_failed", message: "Could not claim this archive for re-encryption." };
    if (!claim.data) return { instanceId: id, status: "skipped_busy", message: "This archive changed or another operation claimed it." };

    const command = buildCommand(sweep.recipient, uri, [`--expected-sha256=${sha}`, "--apply", "--keep-plain"]);
    const writerUnconfirmed = "Writer exit unconfirmed; archive claim retained. Confirm the writer stopped before clearing the claim.";
    let apply: HostScriptResult;
    try {
      // A transport timeout alone does not prove a remote upload has stopped.
      apply = await runHostScript(
        ["(", command, ")", "writer_status=$?", `echo ${REENCRYPT_WRITER_EXITED}`, 'exit "$writer_status"'].join("\n"),
        hostEnv,
        { timeoutMs: Math.max(1_000, remaining - TAIL_HEADROOM_MS - DELETE_STEP_TIMEOUT_MS) }
      );
    } catch {
      return { instanceId: id, status: "host_script_failed", message: writerUnconfirmed };
    }
    if (!apply.ok) {
      const writerExited = apply.stdout.split(/\r?\n/).includes(REENCRYPT_WRITER_EXITED);
      if (writerExited) {
        const releaseFailure = await releaseKnownStoppedWriter();
        if (releaseFailure) return releaseFailure;
      }
      return {
        instanceId: id,
        status: "host_script_failed",
        message: writerExited
          ? `Re-encryption stopped with the plain copy retained. ${apply.error ?? apply.stderr ?? "Unknown error."}`.slice(0, 500)
          : writerUnconfirmed,
      };
    }
    const result = parseReencryptResult(apply.stdout);
    const encSha = result?.get("enc_sha256") ?? "";
    const encSize = Number(result?.get("enc_size"));
    const encUri = `${uri}.age`;
    if (
      !result ||
      result.get("plain") !== uri ||
      result.get("enc") !== encUri ||
      result.get("plain_sha256") !== sha ||
      result.get("plain_deleted") !== "0" ||
      !SHA_RE.test(encSha) ||
      !Number.isSafeInteger(encSize) ||
      encSize <= 0 ||
      !isValidColdArchiveUri(encUri)
    ) {
      const releaseFailure = await releaseKnownStoppedWriter();
      if (releaseFailure) return releaseFailure;
      return { instanceId: id, status: "bad_result", message: "re-encrypt script result line missing or inconsistent; DB and plain copy untouched" };
    }

    // Step 3: compare-and-set. Never clobber a row a restore/archive moved meanwhile.
    const cas = await supabase
      .from("hermes_instances")
      .update({ archive_uri: encUri, archive_sha256: encSha, archive_size_bytes: encSize, lifecycle_substate: null })
      .eq("id", id)
      .eq("archive_uri", uri)
      .eq("lifecycle_state", "cold_archived")
      .eq("lifecycle_substate", REENCRYPT_CLAIM)
      .eq("last_lifecycle_transition_at", claimedAt)
      .select("id")
      .maybeSingle();
    if (cas.error) {
      const releaseFailure = await releaseKnownStoppedWriter();
      if (releaseFailure) return releaseFailure;
      return { instanceId: id, status: "db_update_failed", message: `DB update failed; plain copy kept: ${cas.error.message}`.slice(0, 500) };
    }
    if (!cas.data) {
      return { instanceId: id, status: "cas_lost", message: "row changed (restore/archive in progress?); DB not updated, plain copy kept" };
    }

    // Step 4: the row now points at the verified .age copy; only now remove the plain one.
    const del = await runHostScript(
      buildCommand(null, uri, [
        `--expected-sha256=${sha}`,
        "--delete-plain",
        `--enc-sha256=${encSha}`,
        `--enc-size=${encSize}`,
      ]),
      hostEnv,
      { timeoutMs: DELETE_STEP_TIMEOUT_MS }
    );
    return {
      instanceId: id,
      status: "reencrypted",
      oldUri: uri,
      newUri: encUri,
      encSha256: encSha,
      encSizeBytes: encSize,
      plainDeleted: del.ok,
    };

    async function releaseKnownStoppedWriter(): Promise<ReencryptOutcome | null> {
      const release = await supabase.from("hermes_instances")
        .update({ lifecycle_substate: null })
        .eq("id", id)
        .eq("lifecycle_state", "cold_archived")
        .eq("lifecycle_substate", REENCRYPT_CLAIM)
        .eq("last_lifecycle_transition_at", claimedAt)
        .eq("archive_uri", uri)
        .select("id")
        .maybeSingle();
      return release.error
        ? { instanceId: id, status: "db_update_failed", message: "Writer stopped but its archive claim could not be cleared." }
        : null;
    }
  }
}
