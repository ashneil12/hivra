// config-snapshot.ts — host-orchestrated HermesOS config snapshot, the serverless
// (Vercel cron) half of the pipeline documented in ashneil12/HermesOSBackup/RUNBOOK.md
// (Option B). This is the fleet-consistent twin of the per-tenant restic backup
// (backup-vm-restic.sh + daily-instance-backups): a PVE host reads the chosen agent's
// allowlisted, non-secret config out of its `agent-<id>_webui-state` Docker volume over
// SSH (host-only /etc/hivra/keys/vm-orchestrator key), and the dashboard redacts +
// fail-closed-scans + pushes a human-readable, diffable snapshot to the private repo.
//
// WHY THIS SHAPE (vs the in-container original that died 2026-05-07)
//   The first pipeline ran INSIDE one webui container and pushed via a PAT baked into
//   that container's git remote. When the container was destroyed the job died silently:
//   no host owner, no schedule, no alert. This moves the export to the robust posture the
//   restic backup already uses, and crucially keeps the GitHub credential in Vercel env
//   (HERMESOS_BACKUP_GH_TOKEN) — it NEVER touches a host or a guest. The host only ever
//   stages allowlisted config to stdout; the redact/scan/push all happen in the function.
//
// SECURITY INVARIANTS (from RUNBOOK.md — do not violate)
//   - Allowlist-first. Never snapshot .env, auth.*, secrets/, sessions/, memories/,
//     logs/, *.db/*.sqlite*, cache/, runtimes, or opaque archives the text scanner can't
//     read (*.tar.gz/*.tgz/*.zip incl. skills/.curator_backups).
//   - config.yaml is redacted; the fail-closed scanner blocks any private-key block, PAT,
//     sk-/sk-ant- key, AWS key, or unredacted token:/secret:/password: config field.
//   - The GitHub credential is never committed to the repo and never placed on a guest.

import "server-only";

import { createHash } from "crypto";

// ---------------------------------------------------------------------------------------
// Host staging script
// ---------------------------------------------------------------------------------------

// Mirror the allowlist excludes from host-config-snapshot.sh / backup-manifest.yaml. These
// are applied on the HOST `sudo tar` reads so secret/state/binary material never even
// leaves the guest; the in-function scanner is defense-in-depth on top of this.
const TAR_EXCLUDES =
  "--exclude=.env --exclude=*.env --exclude=secrets --exclude=auth.json --exclude=auth.* " +
  "--exclude=sessions --exclude=logs --exclude=memories --exclude=*.db --exclude=*.sqlite* " +
  "--exclude=cache --exclude=node_modules --exclude=__pycache__ --exclude=.venv " +
  "--exclude=.curator_backups --exclude=*.tar.gz --exclude=*.tgz --exclude=*.zip";

// Markers framing the staged-file payload on stdout. Everything between BEGIN and END is a
// run of `FILE\t<relpath>\t<base64>` lines (one per staged file). base64 -w0 emits no tabs
// or newlines and relpaths contain no tabs, so the framing is unambiguous.
export const SNAPSHOT_FILES_BEGIN = "CONFIG_SNAPSHOT_FILES_BEGIN";
export const SNAPSHOT_FILES_END = "CONFIG_SNAPSHOT_FILES_END";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface StagingTarget {
  instanceId: string;
  vmid: number;
  /** Optional; the host derives it from `qm config <vmid>` when omitted. */
  guestIp?: string | null;
}

/**
 * Build the bash that runs ON the PVE host (via runProxmoxHostScript) to stage the
 * allowlisted config subset out of the guest's webui-state volume and emit it as
 * FILE<TAB>relpath<TAB>base64 lines on stdout. The host reaches the guest with its own
 * /etc/hivra/keys/vm-orchestrator key (never placed on the guest); diagnostics go to
 * stderr so they don't pollute the framed payload.
 */
export function buildConfigSnapshotStagingScript(target: StagingTarget): string {
  const instanceId = shellSingleQuote(target.instanceId);
  const vmid = shellSingleQuote(String(target.vmid));
  const guestIp = shellSingleQuote(target.guestIp?.trim() ?? "");
  return `set -euo pipefail
INSTANCE_ID=${instanceId}
VMID=${vmid}
GUEST_IP=${guestIp}
KEY="\${HERMES_VM_ORCHESTRATOR_KEY:-/etc/hivra/keys/vm-orchestrator}"
SSHO="-i $KEY -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15"
if ! [[ "$INSTANCE_ID" =~ ^[0-9a-f-]{36}$ ]]; then echo "UNSAFE_INSTANCE_ID" >&2; exit 1; fi
if [ -z "$GUEST_IP" ] && [ -n "$VMID" ]; then
  GUEST_IP="$(qm config "$VMID" 2>/dev/null | sed -n 's#^ipconfig0:.*[^0-9]ip=\\([0-9][0-9.]\\{6,\\}\\).*#\\1#p' | head -1)"
fi
[ -z "$GUEST_IP" ] && { echo "NO_GUEST_IP vmid=$VMID" >&2; exit 3; }
V="/var/lib/docker/volumes/agent-\${INSTANCE_ID}_webui-state/_data"
STAGE="$(mktemp -d /tmp/hermes-cfg-stage.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/hermes"
# NOTE: -n is load-bearing. This script is delivered to the host over bash -s stdin
# (runProxmoxHostScript pipes it to the stream); without -n each inner ssh would inherit
# and read-ahead that same stdin pipe to forward to the guest, slurping the rest of THIS
# script and truncating execution to silence. -n redirects each inner ssh stdin from
# /dev/null so the host bash keeps reading its own command stream. (The original
# host-config-snapshot.sh dodged this by passing its body as an ssh ARG, not via stdin.)
g() { ssh -n $SSHO "hermes@$GUEST_IP" "$@"; }
# Allowlisted top-level files (skip empties / absent).
for f in config.yaml SOUL.md channel_directory.json context_length_cache.yaml; do
  g "sudo test -f $V/$f && sudo cat $V/$f" > "$STAGE/hermes/$f" 2>/dev/null && [ -s "$STAGE/hermes/$f" ] || rm -f "$STAGE/hermes/$f"
done
# Allowlisted dirs via host-side sudo tar with secret/state/binary excludes.
for d in skills orgs; do
  g "sudo test -d $V/$d && sudo tar -C $V -cf - ${TAR_EXCLUDES} $d 2>/dev/null" | tar -C "$STAGE/hermes" -xf - 2>/dev/null || true
done
# cron/jobs.json only (never the cron logs/state).
g "sudo test -f $V/cron/jobs.json && sudo cat $V/cron/jobs.json" > /tmp/_jobs.$$ 2>/dev/null && [ -s /tmp/_jobs.$$ ] && mkdir -p "$STAGE/hermes/cron" && mv /tmp/_jobs.$$ "$STAGE/hermes/cron/jobs.json" || rm -f /tmp/_jobs.$$
# Per-profile: config/SOUL/skills/orgs only.
if g "sudo test -d $V/profiles" 2>/dev/null; then
  for p in $(g "sudo ls $V/profiles 2>/dev/null"); do
    mkdir -p "$STAGE/hermes/profiles/$p"
    for f in config.yaml SOUL.md; do
      g "sudo test -f $V/profiles/$p/$f && sudo cat $V/profiles/$p/$f" > "$STAGE/hermes/profiles/$p/$f" 2>/dev/null && [ -s "$STAGE/hermes/profiles/$p/$f" ] || rm -f "$STAGE/hermes/profiles/$p/$f"
    done
    for d in skills orgs; do
      g "sudo test -d $V/profiles/$p/$d && sudo tar -C $V/profiles/$p -cf - ${TAR_EXCLUDES} $d 2>/dev/null" | tar -C "$STAGE/hermes/profiles/$p" -xf - 2>/dev/null || true
    done
  done
fi
# Emit the staged subset as framed FILE lines. base64 -w0 keeps each file on one line.
COUNT=0
echo "${SNAPSHOT_FILES_BEGIN}"
cd "$STAGE"
while IFS= read -r -d '' file; do
  rel="\${file#./}"
  printf 'FILE\\t%s\\t%s\\n' "$rel" "$(base64 -w0 < "$file")"
  COUNT=$((COUNT+1))
done < <(find . -type f -print0 | sort -z)
echo "${SNAPSHOT_FILES_END} count=$COUNT"
echo "REMOTE_STAGE_OK files=$COUNT guest_ip=$GUEST_IP" >&2`;
}

// ---------------------------------------------------------------------------------------
// Parse / redact / scan
// ---------------------------------------------------------------------------------------

export interface StagedFile {
  /** Relative path within the snapshot (e.g. "hermes/config.yaml"). */
  path: string;
  content: Buffer;
}

/**
 * Parse the framed FILE lines out of the host stdout. Throws if the markers are missing or
 * the emitted count doesn't match the parsed count (a truncated stream must fail closed, not
 * silently push a partial snapshot that would then delete the missing files from the repo).
 */
export function parseStagedFiles(stdout: string): StagedFile[] {
  const lines = stdout.split("\n");
  const begin = lines.indexOf(SNAPSHOT_FILES_BEGIN);
  if (begin === -1) throw new Error("staging output missing BEGIN marker");
  let endIdx = -1;
  let declaredCount = -1;
  for (let i = begin + 1; i < lines.length; i++) {
    if (lines[i].startsWith(SNAPSHOT_FILES_END)) {
      endIdx = i;
      const m = lines[i].match(/count=(\d+)/);
      declaredCount = m ? Number.parseInt(m[1], 10) : -1;
      break;
    }
  }
  if (endIdx === -1) throw new Error("staging output missing END marker (truncated stream)");

  const files: StagedFile[] = [];
  for (let i = begin + 1; i < endIdx; i++) {
    const line = lines[i];
    if (!line.startsWith("FILE\t")) continue;
    const parts = line.split("\t");
    if (parts.length !== 3) throw new Error(`malformed FILE line at index ${i}`);
    const [, relPath, b64] = parts;
    if (!relPath || relPath.includes("..")) throw new Error(`unsafe staged path: ${relPath}`);
    files.push({ path: relPath, content: Buffer.from(b64, "base64") });
  }
  if (declaredCount !== -1 && declaredCount !== files.length) {
    throw new Error(`staged file count mismatch: declared ${declaredCount}, parsed ${files.length}`);
  }
  return files;
}

// Redact secret-bearing config values. Same regex as export-hermes-backup.sh /
// host-config-snapshot.sh: any `<key>: <value>` line whose key contains api[_-]key,
// token, secret, password, client[_-]secret, or private[_-]key gets its value masked.
const CONFIG_REDACT_RX =
  /^(\s*[^#\n]*?(?:api[_-]?key|token|secret|password|client[_-]?secret|private[_-]?key)\s*:\s*).+$/gim;

export function redactConfigYaml(text: string): string {
  return text.replace(CONFIG_REDACT_RX, '$1"[REDACTED]"');
}

function isConfigYamlPath(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? "";
  return base === "config.yaml" || base === "config.yml";
}

/** Apply config.yaml redaction in place across the staged set (before scanning). */
export function redactStagedFiles(files: StagedFile[]): StagedFile[] {
  return files.map((f) =>
    isConfigYamlPath(f.path)
      ? { path: f.path, content: Buffer.from(redactConfigYaml(f.content.toString("utf8")), "utf8") }
      : f
  );
}

// Forbidden path fragments — these must never appear in a snapshot even if the host
// allowlist somehow let one through. Port of the find-based guard in host-config-snapshot.sh.
const FORBIDDEN_PATH_RX =
  /(^|\/)(\.env|[^/]+\.env|auth\.json|[^/]+\.db|[^/]+\.sqlite3?)$|(^|\/)(secrets|sessions|logs)\//i;

// Content secret patterns — port of the Python scanner in host-config-snapshot.sh.
const CONTENT_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github_pat", /gh[pousr]_[A-Za-z0-9_]{36,}/],
  ["openai_key", /sk-[A-Za-z0-9_-]{32,}/],
  ["anthropic_key", /sk-ant-[A-Za-z0-9_-]{32,}/],
  ["aws_access_key", /AKIA[0-9A-Z]{16}/],
];

const CONFIG_LIKE_EXT = new Set([".yaml", ".yml", ".json", ".toml", ".ini"]);
const SENSITIVE_FIELD_KEYS = new Set([
  "apikey",
  "token",
  "secret",
  "password",
  "clientsecret",
  "privatekey",
]);

export interface ScanHit {
  kind: string;
  path: string;
}

/**
 * Fail-closed secret/path scan over the (already redacted) staged set. Returns every hit;
 * the caller MUST refuse to push if any hit is returned. Mirrors host-config-snapshot.sh:
 * forbidden paths, raw key/PAT/cloud-key patterns, and unredacted sensitive config fields.
 */
export function scanForSecrets(files: StagedFile[]): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const file of files) {
    if (FORBIDDEN_PATH_RX.test(file.path)) {
      hits.push({ kind: "forbidden_path", path: file.path });
      continue;
    }
    const data = file.content.toString("utf8");
    let matched = false;
    for (const [kind, rx] of CONTENT_PATTERNS) {
      if (rx.test(data)) {
        hits.push({ kind, path: file.path });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const ext = (file.path.match(/\.[^./]+$/)?.[0] ?? "").toLowerCase();
    if (CONFIG_LIKE_EXT.has(ext)) {
      for (const line of data.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed || trimmed.startsWith("#") || !line.includes(":")) continue;
        const idx = line.indexOf(":");
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1);
        const normKey = key.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
        const normVal = value.trim().replace(/^["']|["']$/g, "");
        if (SENSITIVE_FIELD_KEYS.has(normKey) && normVal && normVal !== "[REDACTED]") {
          hits.push({ kind: "unredacted_config_secret_field", path: file.path });
          break;
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------
// GitHub push (Git Data API) — token from Vercel env, never on a host/guest
// ---------------------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

export interface GitHubPushConfig {
  repo: string; // "owner/name"
  branch: string; // e.g. "main"
  token: string;
  /** snapshot-relative -> bytes. Stored under `snapshot/<path>` in the repo. */
  files: StagedFile[];
  commitMessage: string;
}

export interface GitHubPushResult {
  changed: boolean;
  commitSha?: string;
  filesPushed: number;
  /** Blobs actually uploaded (new/changed); unchanged files reuse the stored blob. */
  blobsUploaded: number;
  filesDeleted: number;
}

/** All generated content lives under this prefix; the push replaces this subtree wholesale. */
const SNAPSHOT_PREFIX = "snapshot/";

/**
 * Compute the git blob SHA-1 for a buffer (`sha1("blob <len>\0" + content)`). A matching
 * sha in the base tree means the identical blob is already stored in the repo, so we can
 * reuse it in the new tree without re-uploading — turning a steady-state push (where most
 * of the hundreds of config/skill files are unchanged) from N blob POSTs into ~0.
 */
export function gitBlobSha(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`, "utf8"), content]))
    .digest("hex");
}

async function gh(
  cfg: Pick<GitHubPushConfig, "token">,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "hermesos-config-snapshot",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the body verbatim into logs unredacted — GitHub error bodies don't carry
    // secrets, but keep it short and strip any accidental key material.
    const snippet = text.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]").slice(0, 500);
    throw new Error(`github ${method} ${path} -> ${res.status}: ${snippet}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Push the snapshot to GitHub via the Git Data API: create blobs, build a tree that REPLACES
 * the whole `snapshot/` subtree (new/updated files plus explicit deletions for paths that
 * vanished from the agent), commit, and fast-forward the branch ref. No git binary, no
 * checkout — pure HTTPS, so the token stays in the function and never lands on a host/guest.
 * Returns {changed:false} with no commit when the tree is byte-identical to HEAD.
 */
export async function pushSnapshotToGitHub(cfg: GitHubPushConfig): Promise<GitHubPushResult> {
  if (cfg.files.length === 0) {
    // A staging read that produced nothing would otherwise delete the entire snapshot
    // subtree. Fail closed — a broken guest read must not wipe the backup history.
    throw new Error("refusing to push an empty snapshot (0 staged files)");
  }

  const { repo, branch, token } = cfg;
  const ref = (await gh({ token }, "GET", `/repos/${repo}/git/ref/heads/${branch}`)) as {
    object: { sha: string };
  };
  const baseCommitSha = ref.object.sha;
  const baseCommit = (await gh({ token }, "GET", `/repos/${repo}/git/commits/${baseCommitSha}`)) as {
    tree: { sha: string };
  };
  const baseTreeSha = baseCommit.tree.sha;

  const baseTree = (await gh(
    { token },
    "GET",
    `/repos/${repo}/git/trees/${baseTreeSha}?recursive=1`
  )) as { tree: Array<{ path: string; type: string; sha: string }>; truncated?: boolean };

  // Existing snapshot blobs (repo-relative path -> blob sha) — used both to skip
  // re-uploading unchanged files and to compute deletions.
  const existingSnapshotShaByPath = new Map<string, string>();
  for (const e of baseTree.tree) {
    if (e.type === "blob" && e.path.startsWith(SNAPSHOT_PREFIX)) {
      existingSnapshotShaByPath.set(e.path, e.sha);
    }
  }

  // Build the new tree. Reuse the existing blob sha when content is byte-identical
  // (no POST); upload a blob only for new/changed files.
  const newRepoPaths = new Set<string>();
  const treeEntries: Array<{ path: string; mode: string; type: "blob"; sha: string | null }> = [];
  let blobsUploaded = 0;
  for (const file of cfg.files) {
    const repoPath = SNAPSHOT_PREFIX + file.path;
    newRepoPaths.add(repoPath);
    const localSha = gitBlobSha(file.content);
    if (existingSnapshotShaByPath.get(repoPath) === localSha) {
      treeEntries.push({ path: repoPath, mode: "100644", type: "blob", sha: localSha });
      continue;
    }
    const blob = (await gh({ token }, "POST", `/repos/${repo}/git/blobs`, {
      content: file.content.toString("base64"),
      encoding: "base64",
    })) as { sha: string };
    blobsUploaded += 1;
    treeEntries.push({ path: repoPath, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Deletions: any prior snapshot/ blob no longer present in the new set. Only safe on a
  // COMPLETE base tree — if GitHub truncated the recursive listing (only happens for huge
  // repos, far above this config-only repo's ~hundreds of files), the existing-path set is
  // partial, so skip deletions rather than risk leaving stale files OR mis-deleting. New
  // content still pushes; stale files would just linger until a non-truncated run.
  let filesDeleted = 0;
  if (!baseTree.truncated) {
    for (const existing of existingSnapshotShaByPath.keys()) {
      if (!newRepoPaths.has(existing)) {
        treeEntries.push({ path: existing, mode: "100644", type: "blob", sha: null });
        filesDeleted += 1;
      }
    }
  }

  const newTree = (await gh({ token }, "POST", `/repos/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  })) as { sha: string };

  if (newTree.sha === baseTreeSha) {
    return { changed: false, filesPushed: cfg.files.length, blobsUploaded, filesDeleted: 0 };
  }

  const commit = (await gh({ token }, "POST", `/repos/${repo}/git/commits`, {
    message: cfg.commitMessage,
    tree: newTree.sha,
    parents: [baseCommitSha],
  })) as { sha: string };

  await gh({ token }, "PATCH", `/repos/${repo}/git/refs/heads/${branch}`, {
    sha: commit.sha,
    force: false,
  });

  return { changed: true, commitSha: commit.sha, filesPushed: cfg.files.length, blobsUploaded, filesDeleted };
}

// ---------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------

export interface SnapshotMetadataInput {
  instanceId: string;
  proxmoxNode: string;
  proxmoxVmid: number | null;
}

/** Build the EXPORT_METADATA.json staged file (repo path snapshot/EXPORT_METADATA.json). */
export function buildMetadataFile(input: SnapshotMetadataInput): StagedFile {
  const metadata = {
    exported_at_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source: "host-orchestrated config snapshot (vercel cron)",
    instance_id: input.instanceId,
    proxmox_node: input.proxmoxNode,
    proxmox_vmid: input.proxmoxVmid,
    hermes_home: "agent-<id>_webui-state Docker volume (_data)",
    method: "host sudo-read of allowlisted config from guest -> redact -> scan -> GitHub Git Data API",
  };
  return {
    path: "EXPORT_METADATA.json",
    content: Buffer.from(JSON.stringify(metadata, null, 2) + "\n", "utf8"),
  };
}
