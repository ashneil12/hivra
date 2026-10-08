export interface VmidBoundGuestSshOptions {
  /** Guest login user. Defaults to the Hivra lane's `ubuntu`. */
  sshUser?: string;
  /** ssh ConnectTimeout in seconds. Defaults to 10. */
  connectTimeoutSeconds?: number;
  /** Add LogLevel=ERROR so ssh notices never mix into a caller's parsed stderr. */
  quiet?: boolean;
  /**
   * Leave the EXIT trap to the caller, for scripts whose own EXIT trap must
   * still run when the prelude refuses (a provision's teardown). That trap
   * must call `cleanup_hivra_guest_ssh_identity`, which the prelude defines.
   * By default the prelude installs a trap that only removes its identity
   * directory, replacing any EXIT trap the caller set earlier.
   */
  callerOwnsExitTrap?: boolean;
}

const GUEST_SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/** A plain login name: nothing that could smuggle another host or ssh option into the destination. */
export function isValidGuestSshUser(user: string): boolean {
  return GUEST_SSH_USER.test(user);
}

/**
 * Build the host-side SSH prelude used after a Hivra VM has been provisioned.
 *
 * A guest IP is not an identity boundary: a stale neighbour entry or an IP
 * collision can route a later SSH connection to another tenant. QEMU Guest
 * Agent is reached through the selected VMID's virtio channel, so it can
 * attest the guest's Ed25519 SSH host key without trusting the network path.
 * Every subsequent SSH connection is pinned to that exact key. When the key
 * can't be attested the prelude exits non-zero before any connection is made.
 *
 * Callers must define VMID, GUEST_IP and VM_KEY, and must have already checked
 * the VM's owner binding and configured IP before appending this prelude.
 */
export function buildVmidBoundGuestSshPrelude(options: VmidBoundGuestSshOptions = {}): string {
  const sshUser = options.sshUser ?? "ubuntu";
  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? 10;
  if (!isValidGuestSshUser(sshUser)) throw new Error("Invalid guest SSH user");
  if (!Number.isSafeInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1 || connectTimeoutSeconds > 120) {
    throw new Error("Invalid guest SSH connect timeout");
  }
  const logLevel = options.quiet ? " -o LogLevel=ERROR" : "";
  const exitTrap = options.callerOwnsExitTrap ? "" : "trap cleanup_hivra_guest_ssh_identity EXIT HUP INT TERM\n";
  return `GUEST_SSH_IDENTITY_DIR=""
cleanup_hivra_guest_ssh_identity() {
  case "\${GUEST_SSH_IDENTITY_DIR:-}" in
    /run/hivra-guest-ssh-identity.*) rm -rf -- "$GUEST_SSH_IDENTITY_DIR" ;;
    "") ;;
    *) printf 'refusing to remove unexpected guest identity directory\n' >&2; return 1 ;;
  esac
}
${exitTrap}GUEST_SSH_IDENTITY_DIR="$(mktemp -d /run/hivra-guest-ssh-identity.XXXXXXXX)"
chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
GUEST_SSH_KNOWN_HOSTS="$GUEST_SSH_IDENTITY_DIR/known_hosts"
GUEST_SSH_HOST_ALIAS="hivra-vmid-$VMID"
QGA_SSH_HOST_KEY_JSON="$(qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub)" \\
  || { printf 'VMID-bound SSH refused: VM %s SSH host key could not be read through QEMU Guest Agent; nothing was sent to the guest\\n' "$VMID" >&2; exit 1; }
GUEST_SSH_HOST_KEY="$(printf '%s' "$QGA_SSH_HOST_KEY_JSON" | /usr/bin/python3 -c '
import base64,binascii,json,sys
try:
    document=json.load(sys.stdin)
    fields=document.get("out-data", "").strip().split()
    raw=base64.b64decode(fields[1], validate=True)
    expected=b"\\x00\\x00\\x00\\x0bssh-ed25519\\x00\\x00\\x00\\x20"
    if document.get("exited") != 1 or document.get("exitcode") != 0 or len(fields) < 2 or fields[0] != "ssh-ed25519" or len(raw) != 51 or not raw.startswith(expected):
        raise ValueError("invalid VMID-bound SSH host key")
except (IndexError,KeyError,TypeError,ValueError,binascii.Error,json.JSONDecodeError):
    raise SystemExit(1)
print("ssh-ed25519 "+fields[1])
')" \\
  || { printf 'VMID-bound SSH refused: VM %s did not attest a valid Ed25519 SSH host key; nothing was sent to the guest\\n' "$VMID" >&2; exit 1; }
printf '%s %s\n' "$GUEST_SSH_HOST_ALIAS" "$GUEST_SSH_HOST_KEY" > "$GUEST_SSH_KNOWN_HOSTS"
chmod 0600 "$GUEST_SSH_KNOWN_HOSTS"
GUEST_SSH=(ssh -i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS" -o HostKeyAlias="$GUEST_SSH_HOST_ALIAS" -o ConnectTimeout=${connectTimeoutSeconds}${logLevel} "${sshUser}@$GUEST_IP")`;
}
