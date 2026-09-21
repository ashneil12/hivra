/**
 * Build the host-side SSH prelude used after a Hivra VM has been provisioned.
 *
 * A guest IP is not an identity boundary: a stale neighbour entry or an IP
 * collision can route a later SSH connection to another tenant. QEMU Guest
 * Agent is reached through the selected VMID's virtio channel, so it can
 * attest the guest's Ed25519 SSH host key without trusting the network path.
 * Every subsequent SSH connection is pinned to that exact key.
 *
 * Callers must define VMID, GUEST_IP and VM_KEY, and must have already checked
 * the VM's owner binding tag and configured IP before appending this prelude.
 */
export function buildVmidBoundGuestSshPrelude(): string {
  return `GUEST_SSH_IDENTITY_DIR=""
cleanup_hivra_guest_ssh_identity() {
  case "\${GUEST_SSH_IDENTITY_DIR:-}" in
    /run/hivra-guest-ssh-identity.*) rm -rf -- "$GUEST_SSH_IDENTITY_DIR" ;;
    "") ;;
    *) printf 'refusing to remove unexpected guest identity directory\n' >&2; return 1 ;;
  esac
}
trap cleanup_hivra_guest_ssh_identity EXIT HUP INT TERM
GUEST_SSH_IDENTITY_DIR="$(mktemp -d /run/hivra-guest-ssh-identity.XXXXXXXX)"
chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
GUEST_SSH_KNOWN_HOSTS="$GUEST_SSH_IDENTITY_DIR/known_hosts"
GUEST_SSH_HOST_ALIAS="hivra-vmid-$VMID"
QGA_SSH_HOST_KEY_JSON="$(qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub)"
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
')"
printf '%s %s\n' "$GUEST_SSH_HOST_ALIAS" "$GUEST_SSH_HOST_KEY" > "$GUEST_SSH_KNOWN_HOSTS"
chmod 0600 "$GUEST_SSH_KNOWN_HOSTS"
GUEST_SSH=(ssh -i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS" -o HostKeyAlias="$GUEST_SSH_HOST_ALIAS" -o ConnectTimeout=10 "ubuntu@$GUEST_IP")`;
}
