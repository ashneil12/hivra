import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { targetSupportsCatalogRuntime } from "@/lib/hivra/agent-placement";
import { hivraInfrastructureBindingTag } from "@/lib/hivra/agent-authority";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import {
  resolveSelfManagedProxmoxExecutionContext,
  type SelfManagedProxmoxExecutionContext,
} from "./proxmox-execution-context";

export const WINDOWS_BYO_ISO_TERMS_VERSION = "windows-byo-iso-v1" as const;
export const WINDOWS_BYO_ISO_PROTOCOL = "HIVRA_WINDOWS_BYO_ISO_V1" as const;
export const WINDOWS_ISO_STORAGE_PROTOCOL = "HIVRA_WINDOWS_ISO_STORAGE_V1" as const;
export const WINDOWS_ISO_DOWNLOAD_PROTOCOL = "HIVRA_WINDOWS_ISO_DOWNLOAD_V1" as const;
export const WINDOWS_ISO_SOURCE_PROTOCOL = "HIVRA_WINDOWS_ISO_SOURCE_V1" as const;

export const WINDOWS_11_DOWNLOAD_PAGE = "https://www.microsoft.com/software-download/windows11" as const;
export const WINDOWS_SERVER_EVALUATION_PAGE = "https://www.microsoft.com/evalcenter/download-windows-server-2025" as const;
const WINDOWS_ISO_CDN_HOSTS = new Set([
  "software.download.prss.microsoft.com",
  "download.microsoft.com",
]);

const Id = z.string().uuid();
const IsoVolume = z.string().trim().min(8).max(256).regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:iso\/[A-Za-z0-9][A-Za-z0-9._+@() -]{0,190}\.iso$/i,
);
const IsoStorage = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const DownloadTaskId = z.string().uuid();
export const WindowsIsoMediaEvidenceSchema = z.object({
  sizeBytes: z.number().int().positive().safe(),
  modifiedAtSeconds: z.number().int().nonnegative().safe(),
  fileIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const WindowsIsoSelectionSchema = z.object({
  connectionId: Id,
  targetId: Id,
  expectedConnectionRevision: z.number().int().positive().safe(),
}).strict();

export const WindowsIsoDownloadSchema = WindowsIsoSelectionSchema.extend({
  source: z.enum(["windows-11", "windows-server-evaluation"]),
  storage: IsoStorage,
  directUrl: z.string().min(1).max(4096),
  rightsAttested: z.literal(true),
  termsVersion: z.literal(WINDOWS_BYO_ISO_TERMS_VERSION),
}).strict();

export const WindowsIsoDownloadStatusSchema = WindowsIsoSelectionSchema.extend({
  taskId: DownloadTaskId,
}).strict();

export const WindowsByoIsoLaunchSchema = WindowsIsoSelectionSchema.extend({
  launchRequestId: Id,
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  isoVolume: IsoVolume,
  mediaEvidence: WindowsIsoMediaEvidenceSchema,
  mediaSource: z.enum(["unknown", "windows-11", "windows-server-evaluation"]),
  cpu: z.number().int().min(4).max(64),
  ram: z.number().int().min(8).max(256),
  diskGb: z.number().int().min(64).max(2048),
  rightsAttested: z.literal(true),
  termsVersion: z.literal(WINDOWS_BYO_ISO_TERMS_VERSION),
}).strict();

export type WindowsByoIsoLaunch = z.infer<typeof WindowsByoIsoLaunchSchema>;
export type WindowsIsoSource = "unknown" | "windows-11" | "windows-server-evaluation";
export type WindowsIsoImage = { volume: string; name: string; source: WindowsIsoSource } & z.infer<typeof WindowsIsoMediaEvidenceSchema>;
export type WindowsIsoStorage = { id: string; label: string };
export type WindowsIsoDownloadStatus = {
  taskId: string;
  state: "queued" | "running" | "succeeded" | "failed";
  bytesDownloaded: number;
  message: string | null;
};

export class WindowsByoIsoError extends Error {
  constructor(
    readonly code: "invalid_request" | "target_unavailable" | "target_incompatible" | "iso_unavailable" | "download_conflict" | "request_conflict" | "database_unavailable" | "provision_uncertain",
    message: string,
  ) {
    super(message);
    this.name = "WindowsByoIsoError";
  }
}

type DbResult = { data: unknown; error: unknown };
type Database = {
  from(table: string): {
    insert(value: Record<string, unknown>): { select(columns?: string): { single(): PromiseLike<DbResult> } };
  };
  rpc(name: string, args: Record<string, unknown>): PromiseLike<DbResult>;
};

type Dependencies = {
  resolveContext: typeof resolveSelfManagedProxmoxExecutionContext;
  runHostScript: typeof runProxmoxHostScript;
  runHostScriptWithStdin: typeof runProxmoxHostScriptWithStdin;
  database: Database | null;
  now: () => Date;
};

const defaults: Dependencies = {
  resolveContext: resolveSelfManagedProxmoxExecutionContext,
  runHostScript: runProxmoxHostScript,
  runHostScriptWithStdin: runProxmoxHostScriptWithStdin,
  database: supabaseAdmin as unknown as Database | null,
  now: () => new Date(),
};

function exactContextSupportsWindows(context: SelfManagedProxmoxExecutionContext): boolean {
  const freeVmids = context.target.capabilities.vmidRange.freeCount;
  const storageAvailable = context.target.capacity.storageBytes?.available ?? null;
  return targetSupportsCatalogRuntime(context.target, "windows-installer")
    && context.target.capabilities.directRootAccess
    && context.target.capabilities.kvmAvailable
    && freeVmids !== null && freeVmids > 0
    && context.target.capacity.cpu.totalCores !== null
    && context.target.capacity.cpu.totalCores >= 4
    && context.target.capacity.memoryBytes.available !== null
    && context.target.capacity.memoryBytes.available >= 8 * 1024 ** 3
    && storageAvailable !== null && storageAvailable >= 64 * 1024 ** 3;
}

function parseIsoInventory(stdout: string): WindowsIsoImage[] {
  const images: WindowsIsoImage[] = [];
  for (const line of stdout.split("\n")) {
    const [protocol, encodedVolume, encodedName, size, modifiedAt, fileIdentitySha256, rawSource] = line.split("\t");
    if (protocol !== WINDOWS_BYO_ISO_PROTOCOL) continue;
    try {
      const volume = Buffer.from(encodedVolume, "base64").toString("utf8");
      const name = Buffer.from(encodedName, "base64").toString("utf8");
      const sizeBytes = Number(size);
      const modifiedAtSeconds = Number(modifiedAt);
      if (!IsoVolume.safeParse(volume).success || !name || name.length > 191
        || !WindowsIsoMediaEvidenceSchema.safeParse({ sizeBytes, modifiedAtSeconds, fileIdentitySha256 }).success) continue;
      const derivedSource = classifyMicrosoftWindowsIsoFilename(name);
      const source: WindowsIsoSource = rawSource === derivedSource ? rawSource : "unknown";
      images.push({ volume, name, sizeBytes, modifiedAtSeconds, fileIdentitySha256, source });
    } catch { /* malformed host evidence is ignored */ }
  }
  return images.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}

function parseIsoStorages(stdout: string): WindowsIsoStorage[] {
  const seen = new Set<string>();
  const storages: WindowsIsoStorage[] = [];
  for (const line of stdout.split("\n")) {
    const [protocol, encodedStorage] = line.split("\t");
    if (protocol !== WINDOWS_ISO_STORAGE_PROTOCOL) continue;
    try {
      const id = Buffer.from(encodedStorage, "base64").toString("utf8");
      if (!IsoStorage.safeParse(id).success || seen.has(id)) continue;
      seen.add(id);
      storages.push({ id, label: id });
    } catch { /* malformed host evidence is ignored */ }
  }
  return storages.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 20);
}

export function classifyMicrosoftWindowsIsoFilename(filename: string): "windows-11" | "windows-server-evaluation" | null {
  return /^Win11_[A-Za-z0-9._+() -]{1,180}\.iso$/i.test(filename)
    ? "windows-11"
    : /^(?=[A-Za-z0-9._+() -]*SERVER)(?=[A-Za-z0-9._+() -]*EVAL)[A-Za-z0-9][A-Za-z0-9._+() -]{0,190}\.iso$/i.test(filename)
      ? "windows-server-evaluation"
      : null;
}

export function validateMicrosoftWindowsIsoUrl(raw: string): { url: string; filename: string; source: "windows-11" | "windows-server-evaluation" } {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new WindowsByoIsoError("invalid_request", "Paste the final direct Microsoft ISO download link."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.port
    || !WINDOWS_ISO_CDN_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new WindowsByoIsoError("invalid_request", "Use a direct HTTPS ISO link from the approved Microsoft download service.");
  }
  let filename: string;
  try { filename = decodeURIComponent(parsed.pathname.split("/").pop() ?? ""); }
  catch { throw new WindowsByoIsoError("invalid_request", "The Microsoft ISO filename is not valid."); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+() -]{0,190}\.iso$/i.test(filename) || filename.includes("..")) {
    throw new WindowsByoIsoError("invalid_request", "The Microsoft link must end in a conventional .iso filename.");
  }
  const source = classifyMicrosoftWindowsIsoFilename(filename);
  if (!source) {
    throw new WindowsByoIsoError("invalid_request", "This Microsoft filename cannot be safely identified. Use the Windows 11 or Windows Server Evaluation guide to generate a fresh final ISO link.");
  }
  return { url: parsed.toString(), filename, source };
}

export function buildWindowsIsoInventoryScript(): string {
  return `set -eu
export LC_ALL=C
command -v pvesm >/dev/null
pvesm status --content iso 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }' | head -20 | while IFS= read -r storage; do
  case "$storage" in ''|*[!A-Za-z0-9._-]*) continue;; esac
  printf '${WINDOWS_ISO_STORAGE_PROTOCOL}\\t%s\\n' "$(printf %s "$storage" | base64 | tr -d '\\r\\n')"
  pvesm list "$storage" --content iso 2>/dev/null | awk 'NR > 1 && tolower($2) == "iso" && tolower($3) == "iso" && $4 ~ /^[0-9]+$/ { print $1 "\\t" $4 }' | head -100 | while IFS="$(printf '\t')" read -r volume listed_size; do
    case "$volume" in "$storage":iso/*.iso|"$storage":iso/*.ISO) ;; *) continue;; esac
    path=$(pvesm path "$volume" 2>/dev/null) || continue
    [ -f "$path" ] || continue
    stat_line=$(stat -L --printf='%d\t%i\t%s\t%Y\t%Z\n' -- "$path" 2>/dev/null) || continue
    IFS="$(printf '\t')" read -r device inode size modified_at changed_at <<EOF
$stat_line
EOF
    [ "$size" = "$listed_size" ] || continue
    # Bounded replacement evidence; it does not hash ISO bytes and is not
    # presented as protection from a malicious owner with root on this host.
    file_identity_sha=$(printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s' "$path" "$device" "$inode" "$size" "$modified_at" "$changed_at" | sha256sum | awk '{print $1}')
    name=\${volume#*:iso/}
    source=unknown
    derived_source=unknown
    case "$name" in [Ww][Ii][Nn]11_*.iso|[Ww][Ii][Nn]11_*.ISO) derived_source=windows-11;; esac
    upper_name=$(printf %s "$name" | tr '[:lower:]' '[:upper:]')
    case "$upper_name" in *SERVER*EVAL*.ISO|*EVAL*SERVER*.ISO) derived_source=windows-server-evaluation;; esac
    if [ -f "$path.hivra-source" ]; then
      IFS="$(printf '\t')" read -r source_protocol observed_source source_file_identity <"$path.hivra-source" || true
      if [ "$source_protocol" = "${WINDOWS_ISO_SOURCE_PROTOCOL}" ] && [ "$source_file_identity" = "$file_identity_sha" ] && [ "$observed_source" = "$derived_source" ]; then case "$observed_source" in windows-11|windows-server-evaluation) source="$observed_source";; esac; fi
    fi
    printf '${WINDOWS_BYO_ISO_PROTOCOL}\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(printf %s "$volume" | base64 | tr -d '\\r\\n')" "$(printf %s "$name" | base64 | tr -d '\\r\\n')" "$size" "$modified_at" "$file_identity_sha" "$source"
  done
done`;
}

export async function listWindowsIsoImages(
  userId: string,
  selection: unknown,
  dependencies: Partial<Dependencies> = {},
): Promise<{ targetId: string; connectionRevision: number; images: WindowsIsoImage[]; storages: WindowsIsoStorage[] }> {
  const value = selection && typeof selection === "object" && !Array.isArray(selection)
    ? selection as Record<string, unknown> : {};
  const parsed = WindowsIsoSelectionSchema.safeParse({
    connectionId: value.connectionId,
    targetId: value.targetId,
    expectedConnectionRevision: value.expectedConnectionRevision,
  });
  if (!userId || !parsed.success) throw new WindowsByoIsoError("invalid_request", "Choose a valid connected Proxmox host.");
  const deps = { ...defaults, ...dependencies };
  let context: SelfManagedProxmoxExecutionContext;
  try { context = await deps.resolveContext(userId, parsed.data); }
  catch { throw new WindowsByoIsoError("target_unavailable", "The selected host changed. Run its check again."); }
  if (!exactContextSupportsWindows(context)) {
    throw new WindowsByoIsoError("target_incompatible", "This host does not have current Windows setup capability and capacity.");
  }
  const result = await deps.runHostScript(buildWindowsIsoInventoryScript(), context.env, { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (!result.ok) throw new WindowsByoIsoError("target_unavailable", "The host ISO inventory could not be confirmed.");
  return {
    targetId: context.targetId,
    connectionRevision: context.connectionRevision,
    images: parseIsoInventory(result.stdout),
    storages: parseIsoStorages(result.stdout),
  };
}

export function buildWindowsIsoDownloadStartScript(input: Pick<z.infer<typeof WindowsIsoDownloadSchema>, "storage">, taskId: string, filename: string, observedSource: "windows-11" | "windows-server-evaluation"): string {
  const taskRoot = "/var/lib/hivra/windows-iso-downloads";
  const requestPath = `${taskRoot}/${taskId}.request`;
  const statusPath = `${taskRoot}/${taskId}.status`;
  const partPathFile = `${taskRoot}/${taskId}.partpath`;
  const activePath = `${taskRoot}/active`;
  const worker = `set -euo pipefail
export LC_ALL=C
REQUEST=${shellQuote(requestPath)}
STATUS=${shellQuote(statusPath)}
PART_PATH_FILE=${shellQuote(partPathFile)}
ACTIVE=${shellQuote(activePath)}
FINAL="$HIVRA_FINAL"
EXPECTED_SIZE="$HIVRA_EXPECTED_SIZE"
SOURCE="$HIVRA_SOURCE"
PART="$FINAL.hivra-${taskId}.part"
SOURCE_TMP="$FINAL.hivra-source.${taskId}.part"
write_status() { tmp="$STATUS.tmp.$$"; printf '${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\\t%s\\t%s\\t%s\\n' "$1" "$2" "$(printf %s "$3" | base64 | tr -d '\\r\\n')" >"$tmp"; chmod 600 "$tmp"; mv -f "$tmp" "$STATUS"; }
completed=0
cleanup() { code=$?; if [ "$code" -ne 0 ] && [ "$completed" -eq 0 ]; then bytes=$(stat -c %s -- "$PART" 2>/dev/null || printf 0); rm -f -- "$PART" "$SOURCE_TMP"; write_status failed "$bytes" 'The host download task stopped before completion. Generate a fresh Microsoft link and retry.' || true; fi; rm -f -- "$REQUEST" "$PART_PATH_FILE"; if [ "$(cat "$ACTIVE" 2>/dev/null || true)" = ${shellQuote(taskId)} ]; then rm -f -- "$ACTIVE"; fi; }
trap cleanup EXIT
ulimit -f 16777216
if ! IFS= read -r URL <"$REQUEST"; then write_status failed 0 'The secure download handoff timed out. Retry with a fresh Microsoft link.'; completed=1; exit 1; fi
rm -f -- "$REQUEST"
write_status running 0 ''
if ! printf 'url = "%s"\\n' "$URL" | curl --config - --fail --silent --show-error --proto '=https' --proto-redir '=https' --max-redirs 0 --connect-timeout 30 --max-time 43200 --speed-limit 1024 --speed-time 120 --max-filesize 17179869184 --output "$PART"; then
  bytes=$(stat -c %s -- "$PART" 2>/dev/null || printf 0)
  rm -f -- "$PART"
  write_status failed "$bytes" 'Microsoft download failed or the link expired. Generate a fresh direct link and retry.'
  completed=1
  exit 1
fi
bytes=$(stat -c %s -- "$PART" 2>/dev/null || printf 0)
if [ "$bytes" -ne "$EXPECTED_SIZE" ]; then rm -f -- "$PART"; write_status failed "$bytes" 'Microsoft returned a file with an unexpected size. Generate a fresh direct link and retry.'; completed=1; exit 1; fi
sync -f "$PART" 2>/dev/null || true
if ! mv -n -- "$PART" "$FINAL" || [ -e "$PART" ]; then rm -f -- "$PART"; write_status failed "$bytes" 'An ISO with this filename already exists; choose it from the host library.'; completed=1; exit 1; fi
STAT_LINE=$(stat -L --printf='%d\\t%i\\t%s\\t%Y\\t%Z\\n' -- "$FINAL")
IFS="$(printf '\t')" read -r DEVICE INODE FINAL_SIZE MTIME CTIME <<EOF
$STAT_LINE
EOF
FILE_IDENTITY_SHA=$(printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s' "$FINAL" "$DEVICE" "$INODE" "$FINAL_SIZE" "$MTIME" "$CTIME" | sha256sum | awk '{print $1}')
printf '${WINDOWS_ISO_SOURCE_PROTOCOL}\\t%s\\t%s\\n' "$SOURCE" "$FILE_IDENTITY_SHA" >"$SOURCE_TMP"
chmod 600 "$SOURCE_TMP"
if ! mv -n -- "$SOURCE_TMP" "$FINAL.hivra-source" || [ -e "$SOURCE_TMP" ]; then rm -f -- "$SOURCE_TMP"; write_status failed "$bytes" 'The ISO completed but its Hivra media label could not be saved. Refresh the library before use.'; completed=1; exit 1; fi
write_status succeeded "$bytes" ''
completed=1`;
  return `set -euo pipefail
export LC_ALL=C
command -v pvesm >/dev/null
command -v curl >/dev/null
command -v systemd-run >/dev/null
STORAGE=${shellQuote(input.storage)}
FILENAME=${shellQuote(filename)}
TASK_ROOT=${shellQuote(taskRoot)}
REQUEST=${shellQuote(requestPath)}
STATUS=${shellQuote(statusPath)}
PART_PATH_FILE=${shellQuote(partPathFile)}
ACTIVE=${shellQuote(activePath)}
IFS= read -r DIRECT_URL
pvesm status --content iso 2>/dev/null | awk 'NR > 1 && $3 == "active" { print $1 }' | grep -Fxq -- "$STORAGE" || exit 4
FINAL=$(pvesm path "$STORAGE:iso/$FILENAME" 2>/dev/null) || exit 4
case "$FINAL" in /*) ;; *) exit 4;; esac
mkdir -p -- "$TASK_ROOT" "$(dirname -- "$FINAL")"
chmod 700 "$TASK_ROOT"
exec 9>"$TASK_ROOT/start.lock"
flock -x 9
[ ! -e "$FINAL" ] || { echo iso-already-exists >&2; exit 5; }
[ ! -e "$FINAL.hivra-source" ] || { echo iso-metadata-conflict >&2; exit 5; }
[ ! -e "$STATUS" ] || exit 6
if [ -f "$ACTIVE" ]; then
  active_task=$(cat -- "$ACTIVE" 2>/dev/null || true)
  active_state=$(systemctl show --property=ActiveState --value hivra-winiso-download.service 2>/dev/null || true)
  case "$active_state" in active|activating) echo iso-download-active >&2; exit 8;; esac
  rm -f -- "$ACTIVE"
fi
if ! HEADERS=$(printf 'url = "%s"\\n' "$DIRECT_URL" | curl --config - --head --fail --silent --show-error --proto '=https' --proto-redir '=https' --max-redirs 0 --connect-timeout 30 --max-time 60 --dump-header - --output /dev/null); then echo iso-length-unavailable >&2; exit 9; fi
CONTENT_LENGTH=$(printf %s "$HEADERS" | awk 'BEGIN { IGNORECASE=1 } /^Content-Length:[[:space:]]*[0-9]+[[:space:]]*$/ { value=$2; gsub(/\\r/, "", value) } END { print value }')
case "$CONTENT_LENGTH" in ''|*[!0-9]*) echo iso-length-unavailable >&2; exit 9;; esac
[ "$CONTENT_LENGTH" -ge 1 ] && [ "$CONTENT_LENGTH" -le 17179869184 ] || { echo iso-length-out-of-range >&2; exit 9; }
AVAILABLE_BYTES=$(df -PB1 -- "$(dirname -- "$FINAL")" | awk 'NR == 2 { print $4 }')
case "$AVAILABLE_BYTES" in ''|*[!0-9]*) echo iso-space-unavailable >&2; exit 9;; esac
REQUIRED_BYTES=$((CONTENT_LENGTH + 1073741824))
[ "$AVAILABLE_BYTES" -ge "$REQUIRED_BYTES" ] || { echo iso-space-insufficient >&2; exit 9; }
mkfifo -- "$REQUEST"
chmod 600 "$REQUEST"
printf %s "$FINAL.hivra-${taskId}.part" >"$PART_PATH_FILE"
chmod 600 "$PART_PATH_FILE"
printf %s ${shellQuote(taskId)} >"$ACTIVE"
chmod 600 "$ACTIVE"
tmp="$STATUS.tmp.$$"
printf '${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\\tqueued\\t0\\t\\n' >"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$STATUS"
if ! systemd-run --quiet --collect --no-block --unit=hivra-winiso-download --property=RuntimeMaxSec=12h --setenv="HIVRA_FINAL=$FINAL" --setenv="HIVRA_EXPECTED_SIZE=$CONTENT_LENGTH" --setenv=${shellQuote(`HIVRA_SOURCE=${observedSource}`)} /bin/bash -c ${shellQuote(worker)}; then
  rm -f -- "$REQUEST" "$STATUS" "$PART_PATH_FILE" "$ACTIVE"
  exit 7
fi
if ! printf '%s\\n' "$DIRECT_URL" | timeout 15s tee "$REQUEST" >/dev/null; then
  systemctl stop hivra-winiso-download.service >/dev/null 2>&1 || true
  rm -f -- "$REQUEST" "$STATUS" "$PART_PATH_FILE" "$ACTIVE"
  echo iso-fifo-timeout >&2
  exit 10
fi
rm -f -- "$REQUEST"
printf '${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\\t%s\\t%s\\t%s\\n' ${shellQuote(taskId)} "$(printf %s "$FILENAME" | base64 | tr -d '\\r\\n')" "$(printf %s "$STORAGE" | base64 | tr -d '\\r\\n')"`;
}

export function buildWindowsIsoDownloadStatusScript(taskId: string): string {
  return `set -euo pipefail
export LC_ALL=C
STATUS=${shellQuote(`/var/lib/hivra/windows-iso-downloads/${taskId}.status`)}
PART_PATH_FILE=${shellQuote(`/var/lib/hivra/windows-iso-downloads/${taskId}.partpath`)}
REQUEST=${shellQuote(`/var/lib/hivra/windows-iso-downloads/${taskId}.request`)}
ACTIVE='/var/lib/hivra/windows-iso-downloads/active'
[ -f "$STATUS" ] || exit 4
IFS="$(printf '\t')" read -r protocol state recorded_bytes message <"$STATUS"
[ "$protocol" = "${WINDOWS_ISO_DOWNLOAD_PROTOCOL}" ] || exit 5
case "$state" in queued|running)
  bytes="$recorded_bytes"
  if [ -f "$PART_PATH_FILE" ]; then
    part=$(cat -- "$PART_PATH_FILE")
    case "$part" in /*.hivra-${taskId}.part) bytes=$(stat -c %s -- "$part" 2>/dev/null || printf %s "$recorded_bytes");; esac
  fi
  unit_state=$(systemctl show --property=ActiveState --value hivra-winiso-download.service 2>/dev/null || true)
  active_task=$(cat -- "$ACTIVE" 2>/dev/null || true)
  case "$unit_state" in active|activating) [ "$active_task" = ${shellQuote(taskId)} ] || exit 6;;
  *)
    if [ -f "$PART_PATH_FILE" ]; then part=$(cat -- "$PART_PATH_FILE"); case "$part" in /*.hivra-${taskId}.part) rm -f -- "$part";; esac; fi
    rm -f -- "$REQUEST" "$PART_PATH_FILE"
    if [ "$active_task" = ${shellQuote(taskId)} ]; then rm -f -- "$ACTIVE"; fi
    message=$(printf %s 'The host download task stopped before completion. Generate a fresh Microsoft link and retry.' | base64 | tr -d '\\r\\n')
    tmp="$STATUS.tmp.$$"; printf '${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\\tfailed\\t%s\\t%s\\n' "$bytes" "$message" >"$tmp"; chmod 600 "$tmp"; mv -f "$tmp" "$STATUS"
    state=failed;;
  esac
  printf '${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\\t%s\\t%s\\t%s\\n' "$state" "$bytes" "$message";;
succeeded|failed) cat -- "$STATUS";;
*) exit 5;; esac`;
}

export async function startWindowsIsoDownload(
  userId: string,
  raw: unknown,
  dependencies: Partial<Dependencies> = {},
): Promise<{ taskId: string; state: "queued"; filename: string; storage: string }> {
  const parsed = WindowsIsoDownloadSchema.safeParse(raw);
  if (!userId || !parsed.success) throw new WindowsByoIsoError("invalid_request", "Complete the Microsoft ISO download settings and rights attestation.");
  const validated = validateMicrosoftWindowsIsoUrl(parsed.data.directUrl);
  if (parsed.data.source !== validated.source) {
    throw new WindowsByoIsoError("invalid_request", "The selected Windows media type does not match the Microsoft ISO filename. Generate the link from the matching guide.");
  }
  const deps = { ...defaults, ...dependencies };
  let context: SelfManagedProxmoxExecutionContext;
  try { context = await deps.resolveContext(userId, parsed.data); }
  catch { throw new WindowsByoIsoError("target_unavailable", "The selected host changed. Run its check again."); }
  if (!exactContextSupportsWindows(context)) throw new WindowsByoIsoError("target_incompatible", "This host does not have current Windows setup capability and capacity.");
  const inventory = await listWindowsIsoImages(userId, parsed.data, deps);
  if (!inventory.storages.some(storage => storage.id === parsed.data.storage)) {
    throw new WindowsByoIsoError("invalid_request", "Choose an active ISO storage on this host.");
  }
  if (inventory.images.some(image => image.name.toLowerCase() === validated.filename.toLowerCase())) {
    throw new WindowsByoIsoError("download_conflict", "An ISO with this filename already exists on this host. Choose it from the library.");
  }
  const taskId = randomUUID();
  const started = await deps.runHostScriptWithStdin(
    buildWindowsIsoDownloadStartScript(parsed.data, taskId, validated.filename, validated.source),
    `${validated.url}\n`,
    context.env,
    { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 },
  );
  const match = started.stdout.match(new RegExp(`(?:^|\\n)${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\\t(${taskId})\\t([^\\t\\n]+)\\t([^\\t\\n]+)(?:\\n|$)`));
  if (!started.ok || !match) {
    if (started.stderr.includes("iso-already-exists")) throw new WindowsByoIsoError("download_conflict", "An ISO with this filename already exists on this host. Refresh the library.");
    if (started.stderr.includes("iso-download-active")) throw new WindowsByoIsoError("download_conflict", "This host is already downloading one Windows ISO. Wait for it to finish before starting another.");
    if (started.stderr.includes("iso-length")) throw new WindowsByoIsoError("target_unavailable", "Microsoft did not provide a safe downloadable size for this link. Generate a fresh final direct link.");
    if (started.stderr.includes("iso-space")) throw new WindowsByoIsoError("target_unavailable", "The selected ISO storage does not have enough confirmed free space plus download headroom.");
    if (started.stderr.includes("iso-fifo-timeout")) throw new WindowsByoIsoError("target_unavailable", "The host could not accept the secure one-time download link. Retry with a fresh Microsoft link.");
    throw new WindowsByoIsoError("target_unavailable", "The host could not start the Microsoft ISO download.");
  }
  return { taskId, state: "queued", filename: validated.filename, storage: parsed.data.storage };
}

export async function getWindowsIsoDownloadStatus(
  userId: string,
  raw: unknown,
  dependencies: Partial<Dependencies> = {},
): Promise<WindowsIsoDownloadStatus> {
  const parsed = WindowsIsoDownloadStatusSchema.safeParse(raw);
  if (!userId || !parsed.success) throw new WindowsByoIsoError("invalid_request", "Choose one exact Windows ISO download task.");
  const deps = { ...defaults, ...dependencies };
  let context: SelfManagedProxmoxExecutionContext;
  try { context = await deps.resolveContext(userId, parsed.data); }
  catch { throw new WindowsByoIsoError("target_unavailable", "The selected host changed. Run its check again."); }
  if (!exactContextSupportsWindows(context)) throw new WindowsByoIsoError("target_incompatible", "This host no longer has current Windows setup capability.");
  const result = await deps.runHostScript(buildWindowsIsoDownloadStatusScript(parsed.data.taskId), context.env, { timeoutMs: 15_000, maxOutputBytes: 8 * 1024 });
  if (!result.ok) throw new WindowsByoIsoError("target_unavailable", "The host download task could not be found.");
  const match = result.stdout.match(new RegExp(`(?:^|\\n)${WINDOWS_ISO_DOWNLOAD_PROTOCOL}\\t(queued|running|succeeded|failed)\\t([0-9]{1,20})\\t([^\\n]*)(?:\\n|$)`));
  if (!match) throw new WindowsByoIsoError("target_unavailable", "The host returned invalid download progress.");
  const bytesDownloaded = Number(match[2]);
  if (!Number.isSafeInteger(bytesDownloaded)) throw new WindowsByoIsoError("target_unavailable", "The host returned invalid download progress.");
  let message: string | null = null;
  try { message = match[3] ? Buffer.from(match[3], "base64").toString("utf8").slice(0, 500) : null; }
  catch { throw new WindowsByoIsoError("target_unavailable", "The host returned invalid download progress."); }
  return { taskId: parsed.data.taskId, state: match[1] as WindowsIsoDownloadStatus["state"], bytesDownloaded, message };
}

function launchDigest(userId: string, input: WindowsByoIsoLaunch): string {
  const authority = {
    connectionId: input.connectionId,
    targetId: input.targetId,
    expectedConnectionRevision: input.expectedConnectionRevision,
    launchRequestId: input.launchRequestId,
    name: input.name,
    isoVolume: input.isoVolume,
    mediaEvidence: input.mediaEvidence,
    cpu: input.cpu,
    ram: input.ram,
    diskGb: input.diskGb,
    rightsAttested: input.rightsAttested,
    termsVersion: input.termsVersion,
  };
  return createHash("sha256").update(JSON.stringify(["windows-byo-iso-v1", userId, authority])).digest("hex");
}

export function buildWindowsIsoProvisionScript(input: WindowsByoIsoLaunch, operationId: string, agentId: string, bindingHash: string, context: SelfManagedProxmoxExecutionContext): string {
  const operationTag = `hivra-operation-${operationId}`;
  const allocationTag = `hivra-op-${operationId.replace(/-/g, "").toLowerCase()}`;
  const agentTag = `hivra-agent-${agentId}`;
  const bindingTag = hivraInfrastructureBindingTag(bindingHash);
  const memoryMb = input.ram * 1024;
  return `set -euo pipefail
export LC_ALL=C
ISO=${shellQuote(input.isoVolume)}
EXPECTED_SIZE=${input.mediaEvidence.sizeBytes}
EXPECTED_MTIME=${input.mediaEvidence.modifiedAtSeconds}
EXPECTED_FILE_IDENTITY_SHA=${shellQuote(input.mediaEvidence.fileIdentitySha256)}
verify_iso() {
  ISO_PATH=$(pvesm path "$ISO" 2>/dev/null) || return 1
  [ -f "$ISO_PATH" ] || return 1
  STAT_LINE=$(stat -L --printf='%d\t%i\t%s\t%Y\t%Z\n' -- "$ISO_PATH" 2>/dev/null) || return 1
  IFS="$(printf '\t')" read -r DEVICE INODE SIZE MTIME CTIME <<EOF
$STAT_LINE
EOF
  [ "$SIZE" = "$EXPECTED_SIZE" ] || return 1
  [ "$MTIME" = "$EXPECTED_MTIME" ] || return 1
  [ "$(printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s' "$ISO_PATH" "$DEVICE" "$INODE" "$SIZE" "$MTIME" "$CTIME" | sha256sum | awk '{print $1}')" = "$EXPECTED_FILE_IDENTITY_SHA" ] || return 1
}
verify_iso || { echo iso-evidence-changed >&2; exit 4; }
exec 9>/run/lock/hivra-windows-launch.lock
flock -x 9
for config in /etc/pve/qemu-server/*.conf; do
  [ -f "$config" ] || continue
  tags=$(sed -n 's/^tags:[[:space:]]*//p' "$config")
  case ";$tags;" in *\;${operationTag}\;*)
    case ";$tags;" in *\;${agentTag}\;*) ;; *) exit 5;; esac
    case ";$tags;" in *\;${bindingTag}\;*) ;; *) exit 5;; esac
    case ";$tags;" in *\;${allocationTag}\;*) ;; *) exit 5;; esac
    grep -Fxq ${shellQuote(`ide2: ${input.isoVolume},media=cdrom`)} "$config" || exit 5
    vmid=\${config##*/}; vmid=\${vmid%.conf}; printf 'HIVRA_WINDOWS_RESULT\\t%s\\n' "$vmid"; exit 0;;
  esac
done
VMID=''
for candidate in $(seq ${context.runtime.vmidStart} ${context.runtime.vmidEnd}); do
  if ! qm status "$candidate" >/dev/null 2>&1; then VMID="$candidate"; break; fi
done
[ -n "$VMID" ] || exit 6
created=0
cleanup() { status=$?; if [ "$status" -ne 0 ] && [ "$created" -eq 1 ]; then
  tags=$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p' || true)
  case ";$tags;" in *\;${operationTag}\;*\;${agentTag}\;*) qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true; qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true;; esac
fi; exit "$status"; }
trap cleanup EXIT
verify_iso || { echo iso-evidence-changed >&2; exit 4; }
qm create "$VMID" --name ${shellQuote(input.name)} --ostype win11 --machine q35 --bios ovmf --cpu host --cores ${input.cpu} --memory ${memoryMb} --balloon 0 \\
  --efidisk0 ${shellQuote(`${context.runtime.storage}:1,efitype=4m,pre-enrolled-keys=1`)} --tpmstate0 ${shellQuote(`${context.runtime.storage}:1,version=v2.0`)} \\
  --sata0 ${shellQuote(`${context.runtime.storage}:${input.diskGb},discard=on,ssd=1`)} --ide2 ${shellQuote(`${input.isoVolume},media=cdrom`)} --boot ${shellQuote("order=ide2;sata0")} \\
  --net0 ${shellQuote(`e1000,bridge=${context.runtime.bridge}`)} --vga virtio --tags ${shellQuote(`hivra;hivra-windows;${operationTag};${allocationTag};${agentTag};${bindingTag}`)} >/dev/null
created=1
qm start "$VMID" >/dev/null
printf 'HIVRA_WINDOWS_RESULT\\t%s\\n' "$VMID"
trap - EXIT`;
}

export function buildWindowsIsoReconciliationScript(input: WindowsByoIsoLaunch, operationId: string, agentId: string, bindingHash: string): string {
  const requiredTags = [
    `hivra-operation-${operationId}`,
    `hivra-op-${operationId.replace(/-/g, "").toLowerCase()}`,
    `hivra-agent-${agentId}`,
    hivraInfrastructureBindingTag(bindingHash),
  ];
  return `set -euo pipefail
export LC_ALL=C
ISO=${shellQuote(input.isoVolume)}
ISO_PATH=$(pvesm path "$ISO" 2>/dev/null) || exit 4
[ -f "$ISO_PATH" ] || exit 4
STAT_LINE=$(stat -L --printf='%d\t%i\t%s\t%Y\t%Z\n' -- "$ISO_PATH" 2>/dev/null) || exit 4
IFS="$(printf '\t')" read -r DEVICE INODE SIZE MTIME CTIME <<EOF
$STAT_LINE
EOF
[ "$SIZE" = "${input.mediaEvidence.sizeBytes}" ] || exit 4
[ "$MTIME" = "${input.mediaEvidence.modifiedAtSeconds}" ] || exit 4
[ "$(printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s' "$ISO_PATH" "$DEVICE" "$INODE" "$SIZE" "$MTIME" "$CTIME" | sha256sum | awk '{print $1}')" = ${shellQuote(input.mediaEvidence.fileIdentitySha256)} ] || exit 4
exec 9>/run/lock/hivra-windows-launch.lock
flock -x 9
found=''
for config in /etc/pve/qemu-server/*.conf; do
  [ -f "$config" ] || continue
  observed_tags=$(sed -n 's/^tags:[[:space:]]*//p' "$config")
  owned=1
${requiredTags.map(tag => `  printf '%s\\n' "$observed_tags" | tr ';' '\\n' | grep -Fxq ${shellQuote(tag)} || owned=0`).join("\n")}
  [ "$owned" -eq 1 ] || continue
  grep -Fxq ${shellQuote(`ide2: ${input.isoVolume},media=cdrom`)} "$config" || exit 5
  vmid=\${config##*/}; vmid=\${vmid%.conf}
  [ -z "$found" ] || exit 6
  found="$vmid"
done
[ -n "$found" ] || exit 7
state=$(qm status "$found" 2>/dev/null | awk '{print $2}')
case "$state" in running) ;; stopped) qm start "$found" >/dev/null;; *) exit 8;; esac
printf 'HIVRA_WINDOWS_RESULT\\t%s\\n' "$found"`;
}

export async function launchWindowsByoIso(userId: string, actorIdentity: string, raw: unknown, dependencies: Partial<Dependencies> = {}) {
  const parsed = WindowsByoIsoLaunchSchema.safeParse(raw);
  if (!userId || !actorIdentity || !parsed.success) throw new WindowsByoIsoError("invalid_request", "Complete the Windows ISO, rights attestation, and deployment settings.");
  const input = parsed.data;
  const deps = { ...defaults, ...dependencies };
  if (!deps.database) throw new WindowsByoIsoError("database_unavailable", "Windows setup persistence is unavailable.");
  const digest = launchDigest(userId, input);
  const { data: reservation, error: reservationError } = await deps.database.rpc("reserve_windows_byo_iso_launch", {
    p_user_id: userId, p_request_id: input.launchRequestId, p_request_digest: digest,
    p_media_evidence: input.mediaEvidence,
  });
  if (reservationError || !reservation || typeof reservation !== "object") throw new WindowsByoIsoError("database_unavailable", "The Windows launch receipt could not be saved.");
  const receipt = reservation as Record<string, unknown>;
  if (receipt.status === "invalid") throw new WindowsByoIsoError("invalid_request", "The Windows launch request could not be reserved.");
  if (receipt.status === "conflict") throw new WindowsByoIsoError("request_conflict", "This launch request already belongs to different settings.");
  if (receipt.status === "existing") return receipt.agent;
  const pending = receipt.status === "pending";
  if (!pending && receipt.status !== "reserved") throw new WindowsByoIsoError("database_unavailable", "The Windows launch receipt has an invalid state.");
  const operationId = Id.parse(receipt.operationId);
  const agentId = Id.parse(receipt.agentId);
  const bindingHash = z.string().regex(/^[a-f0-9]{64}$/).parse(receipt.bindingHash);

  let context: SelfManagedProxmoxExecutionContext;
  try { context = await deps.resolveContext(userId, input); }
  catch { throw new WindowsByoIsoError("target_unavailable", "The selected host changed. Run its check again."); }
  if (!exactContextSupportsWindows(context)) throw new WindowsByoIsoError("target_incompatible", "The selected host no longer has Windows setup capability or capacity.");
  const inventory = await listWindowsIsoImages(userId, input, deps);
  const observedImage = inventory.images.find(image => image.volume === input.isoVolume
    && image.sizeBytes === input.mediaEvidence.sizeBytes
    && image.modifiedAtSeconds === input.mediaEvidence.modifiedAtSeconds
    && image.fileIdentitySha256 === input.mediaEvidence.fileIdentitySha256);
  if (!observedImage) {
    throw new WindowsByoIsoError("iso_unavailable", "The selected customer-owned ISO is no longer available on this host.");
  }
  if (input.mediaSource !== observedImage.source) {
    throw new WindowsByoIsoError("iso_unavailable", "The selected ISO media label changed. Refresh the host library and choose it again.");
  }

  if (pending) {
    const reconciled = await deps.runHostScript(
      buildWindowsIsoReconciliationScript(input, operationId, agentId, bindingHash),
      context.env,
      { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 },
    );
    const vmidMatch = reconciled.stdout.match(/(?:^|\n)HIVRA_WINDOWS_RESULT\t([1-9][0-9]{2,8})(?:\n|$)/);
    if (!reconciled.ok || !vmidMatch) throw new WindowsByoIsoError("provision_uncertain", "The saved Windows setup request could not be reconciled without risking another VM.");
    return finalizeWindowsLaunch(deps.database, userId, input, operationId, agentId, Number(vmidMatch[1]));
  }

  const attestedAt = deps.now().toISOString();
  const { data: agent, error: insertError } = await deps.database.from("hivra_agents").insert({
    id: agentId, user_id: userId, type: "linux-desktop", computer_profile: "windows", name: input.name,
    status: "provisioning", deployment_mode: "self-managed", computer_substrate: "proxmox-kvm",
    desired_state: "running", operation_id: operationId, operation_kind: "provision",
    allocation_operation_id: operationId,
    operation_started_at: attestedAt, operation_payload: { stage: "windows_owner_installation", windowsMediaSource: observedImage.source },
    infrastructure_connection_id: input.connectionId, deployment_target_id: input.targetId,
    infrastructure_connection_revision: input.expectedConnectionRevision,
    infrastructure_binding_token_hash: bindingHash, infrastructure_binding_token_enforced: true,
    proxmox_host: "__hivra_self_managed_no_ambient_authority__", cpu: input.cpu, ram: input.ram,
    windows_iso_volume: input.isoVolume, windows_disk_gb: input.diskGb,
    windows_iso_size_bytes: input.mediaEvidence.sizeBytes,
    windows_iso_modified_at_seconds: input.mediaEvidence.modifiedAtSeconds,
    windows_iso_file_identity_sha256: input.mediaEvidence.fileIdentitySha256,
    windows_iso_source: observedImage.source,
    windows_rights_attested_by: actorIdentity, windows_rights_attested_at: attestedAt,
    windows_rights_terms_version: input.termsVersion,
  }).select("id, name, status, vmid, computer_profile, deployment_mode").single();
  if (insertError || !agent) throw new WindowsByoIsoError("database_unavailable", "The Windows computer record could not be confirmed.");

  const provisioned = await deps.runHostScript(buildWindowsIsoProvisionScript(input, operationId, agentId, bindingHash, context), context.env, {
    timeoutMs: 120_000, maxOutputBytes: 64 * 1024,
  });
  const vmidMatch = provisioned.stdout.match(/(?:^|\n)HIVRA_WINDOWS_RESULT\t([1-9][0-9]{2,8})(?:\n|$)/);
  if (!provisioned.ok || !vmidMatch) throw new WindowsByoIsoError("provision_uncertain", "Windows setup could not be confirmed. The saved request must be reconciled before retrying.");
  return finalizeWindowsLaunch(deps.database, userId, input, operationId, agentId, Number(vmidMatch[1]));
}

async function finalizeWindowsLaunch(database: Database, userId: string, input: WindowsByoIsoLaunch, operationId: string, agentId: string, vmid: number) {
  const { data: accepted, error: acceptError } = await database.rpc("accept_windows_byo_iso_launch", {
    p_user_id: userId,
    p_request_id: input.launchRequestId,
    p_agent_id: agentId,
    p_operation_id: operationId,
    p_vmid: vmid,
  });
  if (acceptError || accepted !== true) throw new WindowsByoIsoError("provision_uncertain", "The created Windows VM receipt could not be confirmed.");
  return { id: agentId, name: input.name, status: "provisioning", vmid, computer_profile: "windows", deployment_mode: "self-managed" };
}
