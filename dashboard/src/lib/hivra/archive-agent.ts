// Hivra-lane cold archive — the rung above "parked".
//
// The lane's reclaim ladder (Ash, 2026-07-25):
//   running → parked (qm shutdown; RAM freed, disk kept) → ARCHIVED (disk freed)
//   → eventually scheduled for deletion.
// The hard requirement at every rung: **Start always works.**
//
// Parking alone only frees RAM. On fixturenodea the 27 parked boxes still held ~162 GB
// of thinpool, which is the actual waste. Archiving frees that by removing the
// VM once its disk is safely on the Storage Box.
//
// WHY THIS IS NOT MODELLED AS A NEW `status`
// ------------------------------------------
// An archived box deliberately stays `status='stopped'`. The Hivra lane has no
// archive state machine (hivra_agents has no archive_uri/archived_at columns,
// unlike hermes_instances), and inventing one would mean a schema change plus UI
// work in every surface that switches on status. Instead the START path becomes
// SELF-HEALING: if the VM is missing it restores from the archive first, then
// runs the normal start helper. The user still sees a parked box and one Start
// button; it is simply slower on the first wake. Nothing downstream changes.
//
// That works because the restore is coordinate-preserving — vmid, IP octet
// (hivra_agents.ip) and the named Cloudflare tunnel (hivra_agents.cf_hostname)
// all live in the DB row, not on the disk. `qmrestore` onto the same vmid puts
// the box back exactly where the row already says it is, so the existing
// hivra-start-on-host.sh reconnects the tunnel unchanged.
//
// Archives live at
//   cold:hivra-parked/<host>/<agent-uuid>/vzdump-qemu-<vmid>-<ts>.vma.zst
// with a manifest.json alongside carrying the sha256. Keyed by agent UUID, not
// vmid — see remoteDirFor().
//
// Optional encryption at rest (HERMES_BACKUP_ENCRYPTION, see
// lib/cold-storage/backup-encryption.ts): an encrypted archive is
// vzdump-qemu-<vmid>-<ts>.vma.zst.age and its manifest carries "encryption":"age"
// and "plain_sha256"; "sha256" is then the hash of the stored (encrypted) file.
// The restore side always understands both; the builder only encrypts when it is
// handed a validated PUBLIC recipient.

import {
  AGE_IDENTITY_RE,
  AGE_RECIPIENT_RE,
} from "@/lib/cold-storage/backup-encryption";

/** Storage Box directory holding Hivra archives, one subdir per PVE host. */
export const HIVRA_ARCHIVE_REMOTE_DIR = "hivra-parked";

const SSH_COLD = `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new cold`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Archives are keyed by AGENT UUID, never by vmid alone.
 *
 * vmids are recycled on this lane — fixturenodea currently has three hivra_agents rows
 * claiming vmid 2100 (two deleted, one live). A vmid-keyed archive would let a
 * restore hand a brand-new agent the previous tenant's disk, which is both a
 * data-loss and a data-leak bug. The UUID never repeats, so this cannot alias.
 */
function remoteDirFor(agentId: string, host: string): string {
  assertHost(host);
  if (!UUID_RE.test(agentId)) {
    throw new Error(`hivra archive: invalid agent id ${agentId}`);
  }
  return `${HIVRA_ARCHIVE_REMOTE_DIR}/${host}/${agentId}`;
}

function assertVmid(vmid: number): void {
  if (!Number.isInteger(vmid) || vmid <= 0) {
    throw new Error(`hivra archive: invalid vmid ${vmid}`);
  }
}

function assertHost(host: string): void {
  // Interpolated into shell; keep it to the slug shape the fleet actually uses.
  if (!/^[a-z0-9-]{2,32}$/.test(host)) {
    throw new Error(`hivra archive: invalid host slug ${host}`);
  }
}

/**
 * Shell that restores <vmid> from its Storage Box archive **only if the VM is
 * absent**, and is a no-op otherwise. Prepend to the start/restart command so a
 * cold-archived box wakes transparently.
 *
 * Fails CLOSED: any missing archive, failed download, sha mismatch or failed
 * qmrestore exits non-zero, so the caller reports "Start failed" rather than
 * silently starting nothing. Verifies sha256 BEFORE qmrestore, mirroring the
 * Hermes lane's invariant that nothing destructive/committing happens against
 * unverified bytes.
 */
export function buildHivraRestoreIfMissingScript(
  vmid: number,
  host: string,
  agentId: string,
  options: { ageIdentity?: string } = {}
): string {
  assertVmid(vmid);
  const remote = remoteDirFor(agentId, host);
  if (options.ageIdentity !== undefined && !AGE_IDENTITY_RE.test(options.ageIdentity)) {
    throw new Error("hivra archive: invalid age identity");
  }
  // Without an identity the script still recognises an encrypted archive, and
  // fails closed with a clear reason BEFORE downloading or deleting anything.
  const decryptBlock = options.ageIdentity === undefined
    ? `    echo "[hivra-restore] archive for vmid ${vmid} is age-encrypted but HERMES_BACKUP_AGE_IDENTITY is not configured; nothing was restored or deleted" >&2
    rm -f "/var/lib/vz/dump/$__base"
    exit 1`
    : `    command -v age >/dev/null 2>&1 \\
      || { echo "[hivra-restore] archive is age-encrypted but age is not installed; nothing was restored or deleted" >&2; rm -f "/var/lib/vz/dump/$__base"; exit 1; }
    # The identity travels inside this script (SSH stdin) in a quoted heredoc and
    # lives in a 0600 file only for the single age command below.
    __idf=$(mktemp "/run/.hermes-age-identity.XXXXXXXX") \\
      || { echo "[hivra-restore] cannot create identity file" >&2; rm -f "/var/lib/vz/dump/$__base"; exit 1; }
    chmod 0600 "$__idf"
    cat > "$__idf" <<'HERMES_HIVRA_AGE_IDENTITY_EOF'
${options.ageIdentity}
HERMES_HIVRA_AGE_IDENTITY_EOF
    if age -d -i "$__idf" -o "/var/lib/vz/dump/\${__base%.age}" "/var/lib/vz/dump/$__base" 2>/dev/null; then
      rm -f "$__idf" "/var/lib/vz/dump/$__base"
    else
      rm -f "$__idf" "/var/lib/vz/dump/$__base" "/var/lib/vz/dump/\${__base%.age}"
      echo "[hivra-restore] age decrypt failed for vmid ${vmid} (wrong identity or corrupt archive) — refusing to restore" >&2
      exit 1
    fi
    __base="\${__base%.age}"
    __pwant=$(${SSH_COLD} "cat ${remote}/manifest.json 2>/dev/null" 2>/dev/null \\
      | tr ',' '\\n' | grep -o '"plain_sha256"[[:space:]]*:[[:space:]]*"[a-f0-9]\\{64\\}"' | grep -o '[a-f0-9]\\{64\\}' | head -1 || true)
    if [ -n "$__pwant" ] && [ "$(sha256sum "/var/lib/vz/dump/$__base" | cut -d' ' -f1)" != "$__pwant" ]; then
      echo "[hivra-restore] PLAIN SHA MISMATCH after decrypt for vmid ${vmid} — refusing to restore" >&2
      rm -f "/var/lib/vz/dump/$__base"
      exit 1
    fi`;
  return `
if ! qm status ${vmid} >/dev/null 2>&1; then
  echo "[hivra-restore] vmid ${vmid} absent — restoring from cold archive"
  __arch=$(${SSH_COLD} "ls -1t ${remote}" 2>/dev/null | grep -E '^vzdump-qemu-${vmid}-.*\\.vma\\.zst(\\.age)?$' | head -1 || true)
  [ -z "$__arch" ] || __arch="${remote}/$__arch"
  if [ -z "$__arch" ]; then
    echo "[hivra-restore] no archive found for vmid ${vmid} under ${remote}" >&2
    exit 1
  fi
  __base=$(basename "$__arch")
  mkdir -p /var/lib/vz/dump
  rsync -a --partial -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "cold:$__arch" "/var/lib/vz/dump/$__base" \\
    || { echo "[hivra-restore] download failed" >&2; rm -f "/var/lib/vz/dump/$__base"; exit 1; }
  __want=$(${SSH_COLD} "cat ${remote}/manifest.json 2>/dev/null" 2>/dev/null \\
    | tr ',' '\\n' | grep -o '"sha256"[[:space:]]*:[[:space:]]*"[a-f0-9]\\{64\\}"' | grep -o '[a-f0-9]\\{64\\}' | head -1 || true)
  if [ -n "$__want" ]; then
    __got=$(sha256sum "/var/lib/vz/dump/$__base" | cut -d' ' -f1)
    if [ "$__got" != "$__want" ]; then
      echo "[hivra-restore] SHA MISMATCH for vmid ${vmid} (want \${__want:0:16}… got \${__got:0:16}…) — refusing to restore" >&2
      rm -f "/var/lib/vz/dump/$__base"
      exit 1
    fi
  else
    echo "[hivra-restore] WARN: no manifest sha for vmid ${vmid}; restoring unverified" >&2
  fi
  case "$__base" in
  *.age)
${decryptBlock}
    ;;
  esac
  qmrestore "/var/lib/vz/dump/$__base" ${vmid} >/dev/null \\
    || { echo "[hivra-restore] qmrestore failed" >&2; rm -f "/var/lib/vz/dump/$__base"; exit 1; }
  rm -f "/var/lib/vz/dump/$__base"
  echo "[hivra-restore] vmid ${vmid} restored"
fi
`.trim();
}

/**
 * Shell that archives a PARKED box: vzdump → Storage Box → verify the uploaded
 * copy → only then `qm destroy`. Refuses to touch a RUNNING guest, so it can
 * never pull the disk out from under a live agent (notably aeon, which runs
 * autonomously and is never parked by the idle sweep).
 */
export function buildHivraArchiveScript(
  vmid: number,
  host: string,
  agentId: string,
  options: { ageRecipient?: string } = {}
): string {
  assertVmid(vmid);
  const remote = remoteDirFor(agentId, host);
  if (options.ageRecipient !== undefined && !AGE_RECIPIENT_RE.test(options.ageRecipient)) {
    throw new Error("hivra archive: invalid age recipient");
  }
  // Encrypt with the PUBLIC recipient after vzdump and before upload. "" when
  // off, so the script is then exactly what it was. Fails closed (no upload, no
  // destroy) when age is missing or fails.
  const encryptBlock = options.ageRecipient === undefined
    ? ""
    : `  command -v age >/dev/null 2>&1 || { echo "[hivra-archive] REFUSING_BACKUP_NO_AGE: age is not installed; NOT destroying vmid ${vmid}" >&2; exit 1; }
  __plain_sha="$__sha"
  age -r ${options.ageRecipient} -o "$__f.age" "$__f" && [ -s "$__f.age" ] \\
    || { echo "[hivra-archive] age encryption failed — NOT destroying vmid ${vmid}" >&2; rm -f "$__f.age" "$__f"; exit 1; }
  rm -f "$__f"
  __f="$__f.age"
  __sha=$(sha256sum "$__f" | cut -d' ' -f1)
`;
  const manifestEnc = options.ageRecipient === undefined ? "" : `,"encryption":"age","plain_sha256":"%s"`;
  const manifestEncArg = options.ageRecipient === undefined ? "" : ` "$__plain_sha"`;
  return `
set -o pipefail
__st=$(qm status ${vmid} 2>/dev/null | awk '{print $2}')
if [ "$__st" != "stopped" ]; then
  echo "[hivra-archive] vmid ${vmid} is '\${__st:-absent}', refusing (only parked boxes are archivable)" >&2
  exit 1
fi
__have=$(${SSH_COLD} "ls ${remote}" 2>/dev/null | grep -E '^vzdump-qemu-${vmid}-.*\\.vma\\.zst(\\.age)?$' || true)
if [ -n "$__have" ]; then
  echo "[hivra-archive] archive already present for vmid ${vmid}; skipping vzdump"
else
  [ -e /var/run/vzdump.lock ] && ! pgrep -x vzdump >/dev/null 2>&1 && rm -f /var/run/vzdump.lock
  rm -f /var/lib/vz/dump/vzdump-qemu-${vmid}-*.vma.zst
  vzdump ${vmid} --mode stop --compress zstd --dumpdir /var/lib/vz/dump >/var/lib/vz/dump/${vmid}.arch.log 2>&1 \\
    || { echo "[hivra-archive] vzdump failed:" >&2; tail -5 /var/lib/vz/dump/${vmid}.arch.log >&2; exit 1; }
  __f=$(ls -1t /var/lib/vz/dump/vzdump-qemu-${vmid}-*.vma.zst | head -1)
  __sha=$(sha256sum "$__f" | cut -d' ' -f1)
${encryptBlock}  ${SSH_COLD} "mkdir -p ${remote}"
  rsync -a --partial -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$__f" "cold:${remote}/$(basename "$__f")" \\
    || { echo "[hivra-archive] upload failed" >&2; exit 1; }
  __rsha=$(${SSH_COLD} "sha256sum ${remote}/$(basename "$__f")" 2>/dev/null | cut -d' ' -f1)
  if [ "$__sha" != "$__rsha" ]; then
    echo "[hivra-archive] remote sha mismatch — NOT destroying vmid ${vmid}" >&2
    exit 1
  fi
  # The Storage Box shell SILENTLY NO-OPS \`cat > file\` — it echoes the input
  # back and exits 0 — so piping the manifest into it would ship archives with no
  # manifest, and every restore would fall through to "restoring unverified".
  # Verified on fixturenodea. Build it locally and rsync it up instead; rsync works.
  printf '{"vmid":%s,"host":"%s","agent_id":"%s","file":"%s","sha256":"%s"${manifestEnc}}\\n' \\
    ${vmid} "${host}" "${agentId}" "$(basename "$__f")" "$__sha"${manifestEncArg} > /var/lib/vz/dump/${vmid}.manifest.json
  rsync -a -e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \\
    /var/lib/vz/dump/${vmid}.manifest.json "cold:${remote}/manifest.json" \\
    || { echo "[hivra-archive] manifest upload failed — NOT destroying vmid ${vmid}" >&2; exit 1; }
  __back=$(${SSH_COLD} "cat ${remote}/manifest.json" 2>/dev/null | grep -oE '[a-f0-9]{64}' | head -1)
  if [ "$__back" != "$__sha" ]; then
    echo "[hivra-archive] manifest did not land — NOT destroying vmid ${vmid}" >&2; exit 1
  fi
  rm -f "$__f" /var/lib/vz/dump/${vmid}.arch.log /var/lib/vz/dump/${vmid}.manifest.json
fi
qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 >/dev/null \\
  || { echo "[hivra-archive] destroy failed" >&2; exit 1; }
echo "[hivra-archive] vmid ${vmid} archived + disk reclaimed"
`.trim();
}
