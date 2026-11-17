/**
 * The free sandbox archive store: packed sandboxes kept on the Hetzner Storage Box, the box the paid cold storage uses,
 * under a prefix of their own (`free-sandbox/`) that the cold storage jobs never read or sweep. A pool server reaches the
 * box through its `cold` ssh alias with rsync (docs/cold-storage.md). The box's restricted shell has no `du`, `find`,
 * `stat` or `sha256sum`, so every copy is checked by reading it back onto the pool server and hashing it there.
 *
 * Layout on the box (the box's home directory is the root):
 *   free-sandbox/<sandboxId>/<sha256>.tar.zst   the packed workspace
 *   free-sandbox/<sandboxId>/<sha256>.json     the adapter's manifest for that archive, published last
 *
 * Names carry the digest. A name that is already on the box is read back and checked, never replaced, and a script
 * removes only the names it published itself in that run. Presence of the manifest completes a copy, so a copy that
 * died half way (an archive with no manifest) is never offered for a restore.
 *
 * Every box listing is a plain `ls` of one directory. A listing that fails stops the script, and a name counts as absent
 * only when it is missing from a listing that succeeded. Every id and digest is checked before it reaches a script. Each
 * script is built from those checked literals only, is sent with no stdin, and is never given a value the caller did not
 * check. Errors carry a code and a fixed sentence: a script's own output is read for the fixed markers it prints, never
 * copied into an error.
 */
import type { ArchiveCopy, ArchiveStore, SandboxRef } from "./ports";

/** The box prefix for free sandboxes. Outside `free/`, `paid/` and `meta/`, which the paid cold storage jobs own. */
export const FREE_ARCHIVE_PREFIX = "free-sandbox";
/** Where the gVisor adapter keeps a packed sandbox's archive and manifest on a pool server. */
const LOCAL_ARCHIVE_DIR = "/var/lib/hivra-gvisor/archives";
/** The one-line receipt each script prints on success, read by the store. */
const RECEIPT = "HIVRA_FREE_ARCHIVE_V1";
/** Printed by a script when its own failure is a stored or local copy that does not read back to its digest. */
const VERIFY_MARKER = "HIVRA_FREE_ARCHIVE_VERIFY_FAILED";
/** Printed by a script for any other failed step. */
const FAILED_MARKER = "HIVRA_FREE_ARCHIVE_FAILED";
/** An upload reads the archive out and back over the storage box link: a large workspace takes many minutes. */
const TRANSFER_TIMEOUT_MS = 45 * 60_000;
/** Erasure is a few small remote commands. */
const ERASE_TIMEOUT_MS = 2 * 60_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** Lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 characters. */
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOCATION = /^free-sandbox\/([^/]+)\/([^/]+)\.tar\.zst$/;

/** A pool server's host environment, as `runProxmoxHostScriptWithStdin` takes it. */
export type HostEnv = Record<string, string | undefined>;

/** The part of a script run's result the store reads. `runProxmoxHostScriptWithStdin` returns more than this. */
export interface HostScriptOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Limits for one script run. */
export interface HostScriptOptions {
  timeoutMs: number;
  maxOutputBytes?: number;
}

/** The shape of `runProxmoxHostScriptWithStdin`: a script, its stdin, the host environment and the limits. */
export type HostScriptRunner = (
  script: string,
  stdin: string,
  env: HostEnv,
  options: HostScriptOptions,
) => Promise<HostScriptOutcome>;

export type ArchiveErrorCode = "invalid_input" | "host_failed" | "verify_failed" | "receipt_invalid";

/** A failed archive step. The message is fixed text; it never carries a script's output, a code or an address. */
export class ArchiveStoreError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveStoreError";
  }
}

export interface StorageBoxArchiveStoreDeps {
  /** Runs one script on a pool server. Pass `runProxmoxHostScriptWithStdin` (or a fake in tests). */
  runScript: HostScriptRunner;
  /** The host environment for a pool server, by its id. */
  envFor: (serverId: string) => HostEnv | Promise<HostEnv>;
  /**
   * A pool server with the `cold` alias, used for erasures. The port's `erase` takes only the copy, which names no
   * server, so the store asks this for one.
   */
  serverForErase: () => string | Promise<string>;
}

/** The checked ids of one archive. */
interface ArchiveRef {
  sandboxId: string;
  sha256: string;
}

const invalid = (message: string) => new ArchiveStoreError("invalid_input", message);
const hostFailed = (message: string) => new ArchiveStoreError("host_failed", message);

/** Checks a sandbox id and a digest; both are fixed-format, so nothing else can reach a script. */
function refOf(sandboxId: unknown, sha256: unknown): ArchiveRef {
  if (typeof sandboxId !== "string" || !UUID.test(sandboxId)) throw invalid("The sandbox id is not valid.");
  if (typeof sha256 !== "string" || !DIGEST.test(sha256)) throw invalid("The archive digest is not valid.");
  return { sandboxId, sha256 };
}

/** The location of a free archive on the box, relative to the box's home directory. */
export function archiveLocation(sandboxId: string, sha256: string): string {
  const ref = refOf(sandboxId, sha256);
  return `${FREE_ARCHIVE_PREFIX}/${ref.sandboxId}/${ref.sha256}.tar.zst`;
}

/** Reads a stored location back to its ids. Only a location the store itself would have written passes. */
function parseLocation(location: unknown): ArchiveRef {
  if (typeof location !== "string") throw invalid("The archive location is not valid.");
  const match = LOCATION.exec(location);
  if (!match) throw invalid("The archive location is not valid.");
  const ref = refOf(match[1], match[2]);
  if (archiveLocation(ref.sandboxId, ref.sha256) !== location) throw invalid("The archive location is not valid.");
  return ref;
}

/** The ref of a copy, checked against its own location and byte count. */
function refOfCopy(copy: ArchiveCopy): ArchiveRef {
  const ref = parseLocation(copy.location);
  if (copy.sha256 !== ref.sha256) throw invalid("The archive copy does not match its location.");
  if (!Number.isSafeInteger(copy.bytes) || copy.bytes < 0) throw invalid("The archive size is not valid.");
  return ref;
}

function checkServerId(serverId: unknown): string {
  if (typeof serverId !== "string" || !SERVER_ID.test(serverId)) throw invalid("The pool server id is not valid.");
  return serverId;
}

/** The result of reading a script's receipt line: the fields the store checks. */
type Receipt = Record<string, unknown>;

/**
 * Reads the receipt line a script printed. It must name the operation, the archive's digest and location, and version 1.
 * Anything else is refused, so a script that exited cleanly without doing its work is never taken for success.
 */
function parseReceipt(stdout: string, op: "upload" | "fetch" | "erase", ref: ArchiveRef): Receipt {
  const line = String(stdout)
    .split("\n")
    .find((l) => l.startsWith(`${RECEIPT} `));
  if (!line) throw new ArchiveStoreError("receipt_invalid", "The archive step printed no receipt.");
  let receipt: unknown;
  try {
    receipt = JSON.parse(line.slice(RECEIPT.length + 1));
  } catch {
    throw new ArchiveStoreError("receipt_invalid", "The archive step printed an unreadable receipt.");
  }
  const r = receipt as Receipt;
  if (
    !r ||
    typeof r !== "object" ||
    r.version !== 1 ||
    r.op !== op ||
    r.sha256 !== ref.sha256 ||
    r.location !== archiveLocation(ref.sandboxId, ref.sha256)
  ) {
    throw new ArchiveStoreError("receipt_invalid", "The archive step's receipt does not match the request.");
  }
  return r;
}

/**
 * Shell variables and helpers shared by every script, all set from checked literals.
 *
 * `box_entry_exists DIR NAME` lists DIR with a plain `ls` and looks for NAME as a whole word of that listing. The listing
 * must succeed: a failed `ls` ends the script, so an unreachable box is never read as an absent file. The listing is
 * split on spaces and tabs, so a box that prints names in columns is read the same as one that prints a name per line.
 * The grep does not use -q: with pipefail, an early exit by grep would make the pipeline report a failure.
 */
function prelude(ref: ArchiveRef): string {
  return `set -euo pipefail
SID='${ref.sandboxId}'
SHA='${ref.sha256}'
ARCHIVES='${LOCAL_ARCHIVE_DIR}'
LOCAL_ARCHIVE="$ARCHIVES/$SID.tar.zst"
LOCAL_MANIFEST="$ARCHIVES/$SID.json"
BOX_DIR="${FREE_ARCHIVE_PREFIX}/$SID"
BOX_ARCHIVE="$BOX_DIR/$SHA.tar.zst"
BOX_MANIFEST="$BOX_DIR/$SHA.json"
fail() { echo ${FAILED_MARKER} >&2; exit 1; }
verify_fail() { echo ${VERIFY_MARKER} >&2; exit 1; }
sha_of() { sha256sum "$1" | awk '{print $1}'; }
names_sha() { grep -Fq '"sha256": "'"$SHA"'"' "$1"; }
box_entry_exists() {
  local listing
  listing=$(ssh cold "ls $1") || fail
  printf '%s\\n' "$listing" | tr -s ' \\t' '\\n\\n' | grep -Fx -- "$2" >/dev/null
}
box_dir() {
  if ! ssh cold "ls $1" >/dev/null 2>&1; then
    ssh cold "mkdir $1" || fail
    ssh cold "ls $1" >/dev/null 2>&1 || fail
  fi
}`;
}

/**
 * The upload script. It never removes or overwrites a final name it did not publish in this run.
 *
 * 1. Check the local archive and manifest. Nothing is sent before these pass.
 * 2. For each of the two names: if the name is already on the box, read it back and check it (the archive by digest, the
 *    manifest byte for byte) and leave it alone. If it is not, send it to a `.partial` name unique to this run, read it
 *    back and check it.
 * 3. Only when both copies have passed, publish each name this run sent: the archive first, then the manifest, which is
 *    the completion signal. Each publish first re-checks that the final name is still absent.
 *
 * On failure the cleanup removes this run's `.partial` names and the final names this run published, manifest first.
 * It never touches a final name that was already on the box.
 */
export function buildUploadScript(ref: ArchiveRef): string {
  return `${prelude(ref)}
[ -f "$LOCAL_ARCHIVE" ] && [ -f "$LOCAL_MANIFEST" ] || fail
[ "$(sha_of "$LOCAL_ARCHIVE")" = "$SHA" ] || verify_fail
names_sha "$LOCAL_MANIFEST" || verify_fail
BYTES=$(wc -c < "$LOCAL_ARCHIVE" | tr -d ' ')
TMP=$(mktemp -d)
ATTEMPT=$(basename "$TMP")
PARTIAL_ARCHIVE="$BOX_ARCHIVE.partial.$ATTEMPT"
PARTIAL_MANIFEST="$BOX_MANIFEST.partial.$ATTEMPT"
CREATED_ARCHIVE=0
CREATED_MANIFEST=0
on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then
    ssh cold "rm $PARTIAL_ARCHIVE" >/dev/null 2>&1 || true
    ssh cold "rm $PARTIAL_MANIFEST" >/dev/null 2>&1 || true
    if [ "$CREATED_MANIFEST" = 1 ]; then ssh cold "rm $BOX_MANIFEST" >/dev/null 2>&1 || true; fi
    if [ "$CREATED_ARCHIVE" = 1 ]; then ssh cold "rm $BOX_ARCHIVE" >/dev/null 2>&1 || true; fi
  fi
  rm -rf "$TMP" || true
}
trap on_exit EXIT
box_dir free-sandbox
box_dir "$BOX_DIR"
NEED_ARCHIVE=0
NEED_MANIFEST=0
if box_entry_exists "$BOX_DIR" "$SHA.tar.zst"; then
  rsync -a "cold:$BOX_ARCHIVE" "$TMP/stored.tar.zst" || fail
  [ "$(sha_of "$TMP/stored.tar.zst")" = "$SHA" ] || verify_fail
else
  NEED_ARCHIVE=1
  rsync -a "$LOCAL_ARCHIVE" "cold:$PARTIAL_ARCHIVE" || fail
  rsync -a "cold:$PARTIAL_ARCHIVE" "$TMP/archive" || fail
  [ "$(sha_of "$TMP/archive")" = "$SHA" ] || verify_fail
fi
if box_entry_exists "$BOX_DIR" "$SHA.json"; then
  rsync -a "cold:$BOX_MANIFEST" "$TMP/stored.json" || fail
  cmp -s "$TMP/stored.json" "$LOCAL_MANIFEST" || verify_fail
else
  NEED_MANIFEST=1
  rsync -a "$LOCAL_MANIFEST" "cold:$PARTIAL_MANIFEST" || fail
  rsync -a "cold:$PARTIAL_MANIFEST" "$TMP/manifest" || fail
  cmp -s "$TMP/manifest" "$LOCAL_MANIFEST" || verify_fail
fi
if [ "$NEED_ARCHIVE" = 1 ]; then
  if box_entry_exists "$BOX_DIR" "$SHA.tar.zst"; then fail; fi
  ssh cold "mv $PARTIAL_ARCHIVE $BOX_ARCHIVE" || fail
  CREATED_ARCHIVE=1
fi
if [ "$NEED_MANIFEST" = 1 ]; then
  if box_entry_exists "$BOX_DIR" "$SHA.json"; then fail; fi
  ssh cold "mv $PARTIAL_MANIFEST $BOX_MANIFEST" || fail
  CREATED_MANIFEST=1
fi
printf '${RECEIPT} {"bytes":%s,"location":"%s","op":"upload","sha256":"%s","version":1}\\n' "$BYTES" "$BOX_ARCHIVE" "$SHA"
`;
}

/**
 * The fetch script. It downloads the archive and manifest to `.partial` names beside the adapter's paths, checks the
 * size, the digest and the manifest's naming of that digest, and only then renames them into place (archive first,
 * manifest last, as the adapter itself does). A failed check removes what was downloaded.
 */
export function buildFetchScript(ref: ArchiveRef, bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw invalid("The archive size is not valid.");
  return `${prelude(ref)}
BYTES='${bytes}'
PARTIAL_ARCHIVE="$LOCAL_ARCHIVE.partial"
PARTIAL_MANIFEST="$LOCAL_MANIFEST.partial"
on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then rm -f "$PARTIAL_ARCHIVE" "$PARTIAL_MANIFEST"; fi
}
trap on_exit EXIT
mkdir -p -m 700 "$ARCHIVES"
rsync -a "cold:$BOX_ARCHIVE" "$PARTIAL_ARCHIVE"
rsync -a "cold:$BOX_MANIFEST" "$PARTIAL_MANIFEST"
[ "$(wc -c < "$PARTIAL_ARCHIVE" | tr -d ' ')" = "$BYTES" ] || verify_fail
[ "$(sha_of "$PARTIAL_ARCHIVE")" = "$SHA" ] || verify_fail
names_sha "$PARTIAL_MANIFEST" || verify_fail
mv -f "$PARTIAL_ARCHIVE" "$LOCAL_ARCHIVE"
mv -f "$PARTIAL_MANIFEST" "$LOCAL_MANIFEST"
printf '${RECEIPT} {"bytes":%s,"location":"%s","op":"fetch","sha256":"%s","version":1}\\n' "$BYTES" "$BOX_ARCHIVE" "$SHA"
`;
}

/**
 * The erase script. The manifest goes first: without it the copy is a draft and can no longer be restored. Each file is
 * handled the same way. Its parent directory is listed, and the listing must succeed. A file that the listing does not
 * name is already gone. A file it does name is removed, and the directory is listed again, and the file must then be
 * missing from that listing. The receipt is printed only after both files have been confirmed gone.
 */
export function buildEraseScript(ref: ArchiveRef): string {
  return `${prelude(ref)}
remove_box_file() {
  if box_entry_exists "$BOX_DIR" "$1"; then
    ssh cold "rm $BOX_DIR/$1" || fail
    if box_entry_exists "$BOX_DIR" "$1"; then fail; fi
  fi
}
remove_box_file "$SHA.json"
remove_box_file "$SHA.tar.zst"
printf '${RECEIPT} {"location":"%s","op":"erase","sha256":"%s","version":1}\\n' "$BOX_ARCHIVE" "$SHA"
`;
}

/**
 * Stores free sandbox archives on the Storage Box through the pool servers' `cold` alias. Each method builds one script
 * from checked literals, runs it on one pool server, and reads the receipt the script prints. Nothing is reported as done
 * unless the receipt names the same digest and location.
 */
export class StorageBoxArchiveStore implements ArchiveStore {
  constructor(private readonly deps: StorageBoxArchiveStoreDeps) {}

  /**
   * Copies the pool server's local archive to the box and reads it back. Resolves with the copy once the stored bytes hash
   * to `sha256` and the stored manifest matches. A copy already on the box under the same digest is checked and kept, not
   * replaced. Throws otherwise, and publishes nothing that this call did not send.
   */
  async upload(serverId: string, sandbox: SandboxRef, sha256: string): Promise<ArchiveCopy> {
    const ref = refOf(sandbox.sandboxId, sha256);
    const server = checkServerId(serverId);
    const outcome = await this.run(server, buildUploadScript(ref), TRANSFER_TIMEOUT_MS);
    const receipt = parseReceipt(outcome.stdout, "upload", ref);
    if (!Number.isSafeInteger(receipt.bytes) || (receipt.bytes as number) < 0) {
      throw new ArchiveStoreError("receipt_invalid", "The archive step's receipt has no valid size.");
    }
    return { location: archiveLocation(ref.sandboxId, ref.sha256), sha256: ref.sha256, bytes: receipt.bytes as number };
  }

  /**
   * Downloads a stored archive and its manifest to the pool server's adapter paths, checked against the copy's digest and
   * size. A download that does not match is removed and the call throws.
   */
  async fetch(serverId: string, sandbox: SandboxRef, copy: ArchiveCopy): Promise<void> {
    const ref = refOfCopy(copy);
    if (sandbox.sandboxId !== ref.sandboxId) throw invalid("The archive copy belongs to another sandbox.");
    const server = checkServerId(serverId);
    const outcome = await this.run(server, buildFetchScript(ref, copy.bytes), TRANSFER_TIMEOUT_MS);
    parseReceipt(outcome.stdout, "fetch", ref);
  }

  /**
   * Removes a stored copy (its manifest, then its archive) from the box. A copy that is already gone is accepted once the
   * box's listing has succeeded; an unreadable listing fails the erase.
   */
  async erase(copy: ArchiveCopy): Promise<void> {
    const ref = refOfCopy(copy);
    const server = await this.serverForErase();
    const outcome = await this.run(server, buildEraseScript(ref), ERASE_TIMEOUT_MS);
    parseReceipt(outcome.stdout, "erase", ref);
  }

  /** The pool server that erases run on, checked like any other server id. */
  private async serverForErase(): Promise<string> {
    let server: unknown;
    try {
      server = await this.deps.serverForErase();
    } catch {
      throw hostFailed("No pool server is available to erase from.");
    }
    return checkServerId(server);
  }

  /**
   * Runs one script on one pool server. A failure is reported with a fixed sentence: a verification marker becomes
   * `verify_failed`, and any other failure becomes `host_failed`. The output is never copied into the error.
   */
  private async run(serverId: string, script: string, timeoutMs: number): Promise<HostScriptOutcome> {
    let env: HostEnv;
    try {
      env = await this.deps.envFor(serverId);
    } catch {
      throw hostFailed("The pool server's settings could not be read.");
    }
    let outcome: HostScriptOutcome;
    try {
      outcome = await this.deps.runScript(script, "", env, { timeoutMs, maxOutputBytes: OUTPUT_LIMIT_BYTES });
    } catch {
      throw hostFailed("The archive step could not start on the pool server.");
    }
    if (!outcome || !outcome.ok) {
      const output = `${outcome?.stdout ?? ""}\n${outcome?.stderr ?? ""}`;
      if (output.includes(VERIFY_MARKER)) {
        throw new ArchiveStoreError("verify_failed", "The stored archive did not read back to its digest.");
      }
      throw hostFailed("The archive step did not complete on the pool server.");
    }
    return outcome;
  }
}
