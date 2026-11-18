/**
 * Optional `age` encryption at rest for whole-VM backups sent to the cold
 * Storage Box (daily vzdump backups, cold archives, Hivra parked archives).
 *
 * Off by default: with the switch off every command and script is byte-for-byte
 * what it was before this module existed.
 *
 * Env (all read from the dashboard process env, never from a host):
 *   HERMES_BACKUP_ENCRYPTION      "on" enables encryption of NEW backups.
 *   HERMES_BACKUP_AGE_RECIPIENT   age1... PUBLIC key. All backing up needs.
 *   HERMES_BACKUP_AGE_IDENTITY    AGE-SECRET-KEY-1... secret. Used ONLY when a
 *                                 restore must decrypt an encrypted archive.
 *
 * The recipient is public and may appear in argv. The identity must never
 * appear in argv, in an env assignment on a command line, or in a log: it is
 * delivered inside the script that goes over SSH stdin, in a quoted heredoc
 * that writes a 0600 mktemp file, removed by an EXIT trap.
 */

type EnvLike = Record<string, string | undefined>;

/** age X25519 public recipient: "age1" + 58 bech32 chars. */
export const AGE_RECIPIENT_RE = /^age1[0-9a-z]{58}$/;
/** age X25519 secret identity: "AGE-SECRET-KEY-1" + 58 upper-case bech32 chars. */
export const AGE_IDENTITY_RE = /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/;

export type BackupEncryption =
  | { enabled: false }
  | { enabled: true; ok: true; recipient: string }
  | { enabled: true; ok: false; error: string };

const ON_VALUES = new Set(["on", "1", "true", "yes"]);
const OFF_VALUES = new Set(["", "off", "0", "false", "no"]);

/**
 * Resolve the encryption switch. An unrecognised switch value is treated as
 * "enabled but misconfigured" so a typo can never silently upload plaintext.
 */
export function resolveBackupEncryption(env: EnvLike = process.env): BackupEncryption {
  const raw = (env.HERMES_BACKUP_ENCRYPTION ?? "").trim().toLowerCase();
  if (OFF_VALUES.has(raw)) return { enabled: false };
  if (!ON_VALUES.has(raw)) {
    return {
      enabled: true,
      ok: false,
      error:
        "HERMES_BACKUP_ENCRYPTION has an unrecognised value; set it to \"on\" or leave it unset. " +
        "Refusing to run backups until the switch is unambiguous.",
    };
  }
  const recipient = (env.HERMES_BACKUP_AGE_RECIPIENT ?? "").trim();
  if (!AGE_RECIPIENT_RE.test(recipient)) {
    return {
      enabled: true,
      ok: false,
      error:
        "HERMES_BACKUP_ENCRYPTION is on but HERMES_BACKUP_AGE_RECIPIENT is missing or is not a valid " +
        "age public key (age1...). Refusing to run backups; plaintext would otherwise be uploaded.",
    };
  }
  return { enabled: true, ok: true, recipient };
}

/**
 * Env assignments to prefix a backup script invocation with ("" when off).
 * Only the public recipient is ever put on a command line.
 */
export function backupEncryptionEnvPrefix(encryption: BackupEncryption): string {
  if (!encryption.enabled || !encryption.ok) return "";
  return `HERMES_BACKUP_ENCRYPTION=on HERMES_BACKUP_AGE_RECIPIENT=${encryption.recipient} `;
}

export type AgeIdentity =
  | { present: true; identity: string }
  | { present: false; error: string };

/** The decryption identity from env, validated strictly (it is placed in a heredoc). */
export function resolveAgeIdentity(env: EnvLike = process.env): AgeIdentity {
  const identity = (env.HERMES_BACKUP_AGE_IDENTITY ?? "").trim();
  if (!identity) {
    return {
      present: false,
      error:
        "This archive is age-encrypted but HERMES_BACKUP_AGE_IDENTITY is not configured, so it cannot be " +
        "decrypted. Nothing was restored and nothing was deleted.",
    };
  }
  if (!AGE_IDENTITY_RE.test(identity)) {
    return {
      present: false,
      error:
        "HERMES_BACKUP_AGE_IDENTITY is not a valid age secret key (AGE-SECRET-KEY-1...). " +
        "Nothing was restored and nothing was deleted.",
    };
  }
  return { present: true, identity };
}

/** True for a Storage Box path of an age-encrypted archive. */
export function isAgeEncryptedPath(path: string): boolean {
  return path.endsWith(".age");
}

const IDENTITY_HEREDOC_MARKER = "HERMES_BACKUP_AGE_IDENTITY_EOF";

/**
 * Shell that writes the identity to a fresh 0600 mktemp file and exports its
 * PATH as HERMES_BACKUP_AGE_IDENTITY_FILE, removing the file on exit. It must
 * be part of the script sent over SSH stdin (the identity is inside the quoted
 * heredoc, so it is never in argv or in a shell variable that could be
 * exported or echoed), and the command that needs the file must run as a child
 * of that shell so the EXIT trap outlives it.
 *
 * `removeOnExit: false` is for a detached job that outlives this shell: the
 * job then owns removal of the file.
 */
export function buildAgeIdentityPrelude(identity: string, opts: { removeOnExit?: boolean } = {}): string {
  if (!AGE_IDENTITY_RE.test(identity)) {
    throw new Error("buildAgeIdentityPrelude: not a valid age secret key");
  }
  const removeOnExit = opts.removeOnExit !== false;
  return [
    `__age_id_file="$(mktemp "\${HERMES_AGE_ID_DIR:-/run}/hermes-age-identity.XXXXXXXX")" || { echo "[age] cannot create identity file" >&2; exit 1; }`,
    ...(removeOnExit ? [`trap 'rm -f -- "$__age_id_file"' EXIT`] : []),
    `chmod 0600 "$__age_id_file" || { rm -f -- "$__age_id_file"; echo "[age] cannot protect identity file" >&2; exit 1; }`,
    `cat > "$__age_id_file" <<'${IDENTITY_HEREDOC_MARKER}'`,
    identity,
    IDENTITY_HEREDOC_MARKER,
    `export HERMES_BACKUP_AGE_IDENTITY_FILE="$__age_id_file"`,
  ].join("\n");
}
