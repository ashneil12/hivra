import {
  ARCHIVE_VM_COLD_SH_B64,
  RESTORE_VM_COLD_SH_B64,
} from "./cold-storage-host-scripts.generated";

/**
 * Self-delivery for the two cold-storage ops scripts.
 *
 * archive-vm-cold.sh and restore-vm-cold.sh used to be the ONLY ops scripts with
 * no automated delivery: cold-storage-service.ts executed
 * /usr/local/sbin/<script> and ran whatever bytes happened to be on the host, so
 * merging a fix to either changed nothing until a human scp'd it to every PVE
 * host — hosts silently ran months-old copies. That is what let the step-5b
 * chown defect survive undetected. The daily-backup crons already solved this by
 * embedding their script as base64 and rewriting it before every invocation
 * (see api/cron/daily-vm-backups/route.ts); these two now do the same.
 *
 * The base64 payloads are generated — run
 * `node scripts/generate-cold-storage-host-scripts.cjs` after editing either .sh.
 */

export type ColdStorageHostScript = "archive-vm-cold.sh" | "restore-vm-cold.sh";

const B64_BY_NAME: Record<ColdStorageHostScript, string> = {
  "archive-vm-cold.sh": ARCHIVE_VM_COLD_SH_B64,
  "restore-vm-cold.sh": RESTORE_VM_COLD_SH_B64,
};

/**
 * Shell that (re)installs one cold-storage script at /usr/local/sbin before it
 * is invoked, so the host runs the version from THIS deploy rather than whatever
 * was last copied there by hand.
 *
 * Two properties this block must have, both load-bearing:
 *
 * 1. ATOMIC. It writes a temp file in the same directory and mv's it into place.
 *    A plain redirect onto the target truncates it in place, and bash reads a
 *    script incrementally as it executes — so rewriting the file under a
 *    CONCURRENT invocation would corrupt that running process. Concurrency is
 *    the designed workload here: /api/admin/restore-batch dispatches up to 20
 *    restores with Promise.all and several can land on the same host. mv swaps
 *    the directory entry, leaving any already-running bash on its old inode.
 *
 * 2. FAIL-FAST, via EXPLICIT status checks — deliberately NOT "set -e".
 *    The composed program runs under "bash -s" with no top-level "set -e", and
 *    the obvious fix, wrapping the install in `( set -e ... ) || { exit 1; }`,
 *    silently does nothing: bash SUPPRESSES errexit inside a compound command
 *    used as the left operand of `||`. That was verified on a real host — a
 *    corrupt payload sailed through the guard, mv clobbered the good script with
 *    an empty file, and the invocation still ran. Every step is therefore
 *    checked by hand, and the temp file is cleaned up on each failure path so a
 *    half-written install can neither be executed nor left behind.
 *
 * It deliberately does NOT create the directory: /usr/local/sbin already exists
 * on Debian (hence Proxmox) as 2775 root:staff, and "install -d -m 755" would
 * silently strip that setgid bit on every archive and every restore.
 */
export function buildColdStorageScriptInstall(
  name: ColdStorageHostScript
): string {
  const marker = `HERMES_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const die = (what: string) =>
    `{ rm -f "$__tmp"; echo "[cold-storage] ${what} ${name}" >&2; exit 1; }`;
  return [
    `__tmp=$(mktemp /usr/local/sbin/.${name}.XXXXXX) || ` +
      `{ echo "[cold-storage] mktemp failed for ${name}" >&2; exit 1; }`,
    `base64 -d > "$__tmp" <<'${marker}'`,
    B64_BY_NAME[name],
    marker,
    // Status of the heredoc-fed base64, captured before anything else can clobber $?.
    `[ $? -eq 0 ] || ${die("failed to decode")}`,
    `chmod 755 "$__tmp" || ${die("failed to chmod")}`,
    `mv -f "$__tmp" /usr/local/sbin/${name} || ${die("failed to install")}`,
  ].join("\n");
}
