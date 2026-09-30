/**
 * SSH alias for the cold-storage box, installed on a Proxmox host by the backup
 * routes (daily-vm-backups, daily-instance-backups, instances/[id]/backups).
 *
 * The box address is deployment configuration, not source. It comes from
 * HERMES_COLD_STORAGE_HOST and HERMES_COLD_STORAGE_USER, with no default in the
 * repository: a public tree must not name the box that holds the backups. The
 * SSH private key comes from HETZNER_SSH_PRIVATE_KEY_B64 as before.
 *
 * Both values end up in an ssh_config file written through a quoted heredoc, so
 * a newline or a space in either would add a second directive. They are checked
 * against a strict pattern before they are used, and a rejected value is never
 * echoed into the script or the logs.
 */

export const COLD_STORAGE_HOST_ENV = "HERMES_COLD_STORAGE_HOST";
export const COLD_STORAGE_USER_ENV = "HERMES_COLD_STORAGE_USER";
export const COLD_STORAGE_KEY_ENV = "HETZNER_SSH_PRIVATE_KEY_B64";

// The Hetzner Storage Box SSH port. A product constant, not a deployment secret.
const COLD_STORAGE_SSH_PORT = 23;

const SAFE_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SAFE_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ColdStorageTarget = { host: string; user: string };

export type ColdStorageTargetResult =
  | { ok: true; target: ColdStorageTarget }
  | { ok: false; reason: string };

/**
 * Read and validate the cold-storage host and user. The reason text names only
 * the env variables, never their values.
 */
export function resolveColdStorageTarget(
  env: Record<string, string | undefined> = process.env
): ColdStorageTargetResult {
  const host = env[COLD_STORAGE_HOST_ENV]?.trim() ?? "";
  const user = env[COLD_STORAGE_USER_ENV]?.trim() ?? "";

  const missing = [
    host ? null : COLD_STORAGE_HOST_ENV,
    user ? null : COLD_STORAGE_USER_ENV,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return { ok: false, reason: `${missing.join(" and ")} missing` };
  }

  const invalid = [
    SAFE_HOST.test(host) ? null : COLD_STORAGE_HOST_ENV,
    SAFE_USER.test(user) ? null : COLD_STORAGE_USER_ENV,
  ].filter((name): name is string => name !== null);
  if (invalid.length > 0) {
    return { ok: false, reason: `${invalid.join(" and ")} invalid` };
  }

  return { ok: true, target: { host, user } };
}

/**
 * The marker-delimited ssh_config block that defines the `cold` and
 * `hermes-cold-storage` aliases. The begin and end markers let the installer
 * replace its own block on every run.
 */
export function buildColdStorageSshConfigBlock(target: ColdStorageTarget): string {
  return `# BEGIN HERMES COLD STORAGE
Host cold hermes-cold-storage
  HostName ${target.host}
  User ${target.user}
  Port ${COLD_STORAGE_SSH_PORT}
  IdentityFile /etc/hivra/keys/cold-storage
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /root/.ssh/known_hosts
# END HERMES COLD STORAGE`;
}

export type ColdStorageInstallScriptResult =
  | { ok: true; script: string }
  | { ok: false; reason: string };

/**
 * Shell fragment that installs the cold-storage key and ssh alias on a Proxmox
 * host. Returns the reason instead when the key, host or user is not configured,
 * so each caller decides whether that is a warning or a hard stop.
 */
export function buildColdStorageInstallScript(
  env: Record<string, string | undefined> = process.env
): ColdStorageInstallScriptResult {
  const storageKeyB64 = env[COLD_STORAGE_KEY_ENV]?.trim() ?? "";
  if (!storageKeyB64) {
    return { ok: false, reason: `${COLD_STORAGE_KEY_ENV} missing` };
  }
  const resolved = resolveColdStorageTarget(env);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    script: `install -d -m 700 /root/.ssh
base64 -d > /etc/hivra/keys/cold-storage <<'HERMES_COLD_STORAGE_KEY'
${storageKeyB64}
HERMES_COLD_STORAGE_KEY
chmod 600 /etc/hivra/keys/cold-storage
touch /root/.ssh/config
chmod 600 /root/.ssh/config
sed -i '/# BEGIN HERMES COLD STORAGE/,/# END HERMES COLD STORAGE/d' /root/.ssh/config 2>/dev/null || true
cat >> /root/.ssh/config <<'HERMES_COLD_STORAGE_SSH_CONFIG'
${buildColdStorageSshConfigBlock(resolved.target)}
HERMES_COLD_STORAGE_SSH_CONFIG`,
  };
}

/**
 * The same fragment for callers that cannot run without the alias: when the
 * key, host or user is not configured it prints the reason and stops the host
 * script with exit code 20, so the failure names the missing setting.
 */
export function buildColdStorageInstallScriptOrExit(
  env: Record<string, string | undefined> = process.env
): string {
  const result = buildColdStorageInstallScript(env);
  if (result.ok) return result.script;
  return `echo "${result.reason}; cold storage alias unavailable" >&2; exit 20`;
}
