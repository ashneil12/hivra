/**
 * Host-side SSH from a Proxmox host into a Hermes-lane guest, bound to one VMID.
 *
 * Hermes updates, config writes and OAuth/integration calls carry the box's
 * secrets (LLM keys, the WebUI bearer, the Bankr wallet key) to the guest's
 * private IP. That IP is not an identity: a neighbour on the shared bridge can
 * answer ARP for it, and a stale row can name an IP that now belongs to another
 * VM. So before any byte is sent the host proves which VM it is talking to:
 *
 *  1. the VMID (the stored one, or the single running VM this host has
 *     configured with the IP) exists, is running and its `ipconfig0` names the
 *     IP we are about to connect to;
 *  2. it is not a Hivra computer (those carry a `hivra-bind-*` owner tag);
 *  3. its QEMU Guest Agent, reached over the VMID's virtio channel rather than
 *     the network, reports the guest's Ed25519 SSH host key, and every SSH
 *     connection is pinned to exactly that key (the Hivra lane's
 *     `buildVmidBoundGuestSshPrelude`).
 *
 * Any failed check exits the host script before a connection is opened, with a
 * `VMID-bound SSH refused:` line naming the reason. Hermes VMs carry no owner
 * binding tag yet, so this binds the IP to a VM and the connection to that VM's
 * key; it does not prove the VMID still belongs to the same instance.
 *
 * Callers define PRIVATE_IP, VM_SSH_KEY_PATH and VMID (empty to resolve it from
 * the IP) before appending the prelude, and use the `GUEST_SSH` array it sets.
 */

import { buildVmidBoundGuestSshPrelude, isValidGuestSshUser } from "@/lib/hivra/vmid-bound-guest-ssh";

export { isValidGuestSshUser };

/** Every refusal line starts with this, so callers and logs can tell it from a network fault. */
export const GUEST_SSH_REFUSED_MARKER = "VMID-bound SSH refused:";

/** Bound on one `qm guest cmd ping`. */
export const HERMES_GUEST_AGENT_PING_TIMEOUT_SECONDS = 5;
/** Pause between guest agent pings while a VM boots. */
export const HERMES_GUEST_AGENT_RETRY_SLEEP_SECONDS = 5;

export interface HermesGuestSshPreludeOptions {
  /** Guest login user (PROXMOX_VM_SSH_USER, `hermes` on Hermes VMs). */
  sshUser: string;
  /**
   * How many times to ping the guest agent before giving up, for callers that
   * may reach a VM that is still booting. 0 skips the wait: an agent that is
   * down then fails the host-key read and the prelude refuses.
   */
  agentAttempts?: number;
  connectTimeoutSeconds?: number;
  quiet?: boolean;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}

// Prints the VMID when a qemu-server config's main section (snapshot sections
// start at the first "[") has an ipconfig0 whose ip= is exactly $PRIVATE_IP.
const CONFIG_IP_MATCH_AWK = `
      /^\\[/ { exit }
      /^ipconfig0:/ {
        line = $0
        sub(/^ipconfig0:[ \\t]*/, "", line)
        n = split(line, parts, ",")
        for (i = 1; i <= n; i++) {
          if (substr(parts[i], 1, 3) == "ip=") {
            value = substr(parts[i], 4)
            sub(/\\/[0-9]+$/, "", value)
            if (value == ip) found = 1
          }
        }
      }
      END { exit(found ? 0 : 1) }`;

export function buildHermesVmidBoundGuestSshPrelude(options: HermesGuestSshPreludeOptions): string {
  if (!isValidGuestSshUser(options.sshUser)) throw new Error("Invalid guest SSH user");
  const agentAttempts = boundedInteger(options.agentAttempts ?? 0, 0, 30, "guest agent attempts");
  const agentWait = agentAttempts > 0
    ? `HERMES_GUEST_AGENT_ATTEMPTS=${agentAttempts}
hermes_guest_agent_up=0
for _agent_attempt in $(seq 1 "$HERMES_GUEST_AGENT_ATTEMPTS"); do
  if timeout ${HERMES_GUEST_AGENT_PING_TIMEOUT_SECONDS} qm guest cmd "$VMID" ping </dev/null >/dev/null 2>&1; then
    hermes_guest_agent_up=1
    break
  fi
  if [ "$_agent_attempt" -lt "$HERMES_GUEST_AGENT_ATTEMPTS" ]; then sleep ${HERMES_GUEST_AGENT_RETRY_SLEEP_SECONDS}; fi
done
[ "$hermes_guest_agent_up" = 1 ] \\
  || vmid_bound_ssh_refuse "QEMU Guest Agent in VM $VMID did not answer, so its SSH host key can't be attested"
`
    : "";
  return `vmid_bound_ssh_refuse() {
  printf '${GUEST_SSH_REFUSED_MARKER} %s; nothing was sent to the guest\\n' "$1" >&2
  exit 1
}
case "\${PRIVATE_IP:-}" in
  ""|*[!0-9.]*) vmid_bound_ssh_refuse "the stored guest ip is not an IPv4 address" ;;
esac
[ -f "\${VM_SSH_KEY_PATH:-}" ] || vmid_bound_ssh_refuse "this host has no guest SSH key at \${VM_SSH_KEY_PATH:-(unset)}"
hermes_guest_vmid_resolved=0
if [ -z "\${VMID:-}" ]; then
  # No stored VMID: the VM is the single running guest this host has
  # configured with the IP. A second running one is an IP collision.
  hermes_guest_candidates=""
  for hermes_guest_conf in /etc/pve/qemu-server/*.conf; do
    [ -f "$hermes_guest_conf" ] || continue
    if awk -v ip="$PRIVATE_IP" '${CONFIG_IP_MATCH_AWK}
    ' "$hermes_guest_conf" </dev/null; then
      hermes_guest_candidate="\${hermes_guest_conf##*/}"
      hermes_guest_candidates="$hermes_guest_candidates \${hermes_guest_candidate%.conf}"
    fi
  done
  for hermes_guest_candidate in $hermes_guest_candidates; do
    if [ "$(qm status "$hermes_guest_candidate" </dev/null 2>/dev/null | awk '{print $2}')" = running ]; then
      [ -z "\${VMID:-}" ] \\
        || vmid_bound_ssh_refuse "more than one running VM on this host is configured with $PRIVATE_IP"
      VMID="$hermes_guest_candidate"
    fi
  done
  [ -n "\${VMID:-}" ] || vmid_bound_ssh_refuse "no running VM on this host is configured with $PRIVATE_IP"
  hermes_guest_vmid_resolved=1
fi
case "$VMID" in
  ""|*[!0-9]*) vmid_bound_ssh_refuse "the stored vmid is not a number" ;;
esac
hermes_guest_config="$(qm config "$VMID" </dev/null 2>/dev/null)" \\
  || vmid_bound_ssh_refuse "VM $VMID does not exist on this host"
if [ "$hermes_guest_vmid_resolved" != 1 ]; then
  [ "$(qm status "$VMID" </dev/null 2>/dev/null | awk '{print $2}')" = running ] \\
    || vmid_bound_ssh_refuse "VM $VMID is not running"
fi
hermes_guest_configured_ip="$(printf '%s\\n' "$hermes_guest_config" | awk '
  /^ipconfig0:/ && !seen {
    seen = 1
    line = $0
    sub(/^ipconfig0:[ \\t]*/, "", line)
    n = split(line, parts, ",")
    for (i = 1; i <= n; i++) {
      if (substr(parts[i], 1, 3) == "ip=") {
        value = substr(parts[i], 4)
        if (value ~ /^[0-9.]+\\/[0-9]+$/) { sub(/\\/[0-9]+$/, "", value); print value }
      }
    }
  }')"
[ "$hermes_guest_configured_ip" = "$PRIVATE_IP" ] \\
  || vmid_bound_ssh_refuse "VM $VMID is configured with ip \${hermes_guest_configured_ip:-none}, not $PRIVATE_IP"
hermes_guest_tags="$(printf '%s\\n' "$hermes_guest_config" | awk '/^tags:/ && !seen { seen = 1; line = $0; sub(/^tags:[ \\t]*/, "", line); gsub(/[;, ]+/, ";", line); print line }')"
case ";$hermes_guest_tags;" in
  *";hivra-bind-"*) vmid_bound_ssh_refuse "VM $VMID is a Hivra computer, not a Hermes instance VM" ;;
esac
hermes_guest_agent="$(printf '%s\\n' "$hermes_guest_config" | awk '/^agent:/ && !seen { seen = 1; line = $0; sub(/^agent:[ \\t]*/, "", line); print line }')"
case ",$hermes_guest_agent," in
  *,1,*|*,on,*|*,yes,*|*,true,*|*,enabled=1,*|*,enabled=on,*|*,enabled=yes,*|*,enabled=true,*) ;;
  *) vmid_bound_ssh_refuse "VM $VMID has no QEMU Guest Agent channel, so its SSH host key can't be attested" ;;
esac
${agentWait}GUEST_IP="$PRIVATE_IP"
VM_KEY="$VM_SSH_KEY_PATH"
${buildVmidBoundGuestSshPrelude({
  sshUser: options.sshUser,
  ...(options.connectTimeoutSeconds === undefined ? {} : { connectTimeoutSeconds: options.connectTimeoutSeconds }),
  ...(options.quiet ? { quiet: true } : {}),
})}`;
}

/**
 * Wait for the pinned guest SSH to accept a connection (a VM that is still
 * booting), after `buildHermesVmidBoundGuestSshPrelude`. A host key that does
 * not match the attested one is not a boot race: it refuses at once.
 */
export function buildPinnedGuestSshReadinessWait(params: { attempts: number; sleepSeconds: number }): string {
  const attempts = boundedInteger(params.attempts, 1, 30, "SSH readiness attempts");
  const sleepSeconds = boundedInteger(params.sleepSeconds, 1, 60, "SSH readiness sleep");
  return `SSH_READY_ATTEMPTS=${attempts}
ssh_ready=0
ssh_ready_error=""
for _attempt in $(seq 1 "$SSH_READY_ATTEMPTS"); do
  if ssh_ready_error="$("\${GUEST_SSH[@]}" "sudo -n true" </dev/null 2>&1 >/dev/null)"; then
    ssh_ready=1
    break
  fi
  case "$ssh_ready_error" in
    *"Host key verification failed"*|*"REMOTE HOST IDENTIFICATION HAS CHANGED"*)
      vmid_bound_ssh_refuse "the SSH server at $PRIVATE_IP did not present VM $VMID's attested SSH host key" ;;
  esac
  # Explicit \`if\` rather than \`[ … ] && sleep\`: under \`set -e\` a false
  # test as the loop body's last command makes the body exit non-zero.
  if [ "$_attempt" -lt "$SSH_READY_ATTEMPTS" ]; then sleep ${sleepSeconds}; fi
done
if [ "$ssh_ready" != "1" ]; then
  echo "VM $VMID is not reachable over SSH at $PRIVATE_IP" >&2
  exit 1
fi
`;
}
