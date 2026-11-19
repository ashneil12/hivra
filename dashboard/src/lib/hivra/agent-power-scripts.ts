import { shellQuote } from "./proxmox-target";

function lifecycleBindingVerificationBody(): string {
  return `if [ -n "$EXPECTED_BINDING_TAG" ]; then
  TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
    || { echo "refusing to mutate VMID $VMID without its exact Hivra binding tag" >&2; exit 1; }
fi`;
}

export function lifecycleVmAuthorityBody(): string {
  return `qm status "$VMID" >/dev/null
${lifecycleBindingVerificationBody()}`;
}

export function lifecycleMutationPrelude(
  vmid: number,
  bindingTag: string | null,
  allowMissingForManagedRestore = false,
): string {
  const vmAuthority = allowMissingForManagedRestore
    ? `if qm status "$VMID" >/dev/null 2>&1; then
  ${lifecycleBindingVerificationBody().replaceAll("\n", "\n  ")}
fi`
    : lifecycleVmAuthorityBody();
  return `set -euo pipefail
VMID=${vmid}
EXPECTED_BINDING_TAG=${shellQuote(bindingTag ?? "")}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra lifecycle lock" >&2; exit 1; }
${vmAuthority}`;
}


/**
 * Discards a hibernation so a stopped computer is really off. A hibernated VM
 * reads as stopped, but it carries `lock: suspended` and a saved memory image
 * (vmstate, runningmachine, runningcpu). While that lock is held, qm set, qm
 * stop and qm destroy are refused, and the next start would restore the old
 * memory instead of booting fresh. Needs VMID defined. Safe to run twice: it
 * does nothing once the lock and the image are gone. The unlock, the config
 * edit and the volume free are attempted in turn, and only the final read of
 * the config decides: it stops with an error unless both are gone.
 */
export function hibernationDiscardBody(): string {
  return `DISCARD_STATUS="$(qm status "$VMID" | awk '$1=="status:"{print $2;exit}')"
DISCARD_CONFIG="$(qm config "$VMID" 2>/dev/null)" || DISCARD_CONFIG=""
DISCARD_LOCK="$(printf '%s\\n' "$DISCARD_CONFIG" | awk '$1=="lock:"{print $2;exit}')"
DISCARD_VMSTATE="$(printf '%s\\n' "$DISCARD_CONFIG" | awk '$1=="vmstate:"{print $2;exit}')"
if [ "$DISCARD_STATUS" = "stopped" ] && { [ "$DISCARD_LOCK" = "suspended" ] || [ -n "$DISCARD_VMSTATE" ]; }; then
  DISCARD_VOLID="\${DISCARD_VMSTATE%%,*}"
  if [ "$DISCARD_LOCK" = "suspended" ]; then
    qm unlock "$VMID"
  fi
  qm set "$VMID" --delete vmstate,runningmachine,runningcpu >/dev/null 2>&1 || DISCARD_SET_FAILED=1
  if [ -n "$DISCARD_VOLID" ]; then
    pvesm free "$DISCARD_VOLID" >/dev/null 2>&1 || DISCARD_FREE_FAILED=1
  fi
  DISCARD_CONFIG="$(qm config "$VMID" 2>/dev/null)" || DISCARD_CONFIG=""
  if printf '%s\\n' "$DISCARD_CONFIG" | grep -Eq '^(lock:[[:space:]]*suspended|vmstate:)'; then
    echo "the saved memory of VMID $VMID could not be discarded" >&2
    exit 1
  fi
  echo "HIVRA_HIBERNATION_DISCARDED vmid=$VMID"
fi`;
}

export function verifiedStopVmBody(vmid: number, timeoutSeconds: number): string {
  return `VMID=${vmid}
STOP_MODE=already
${hibernationDiscardBody()}
CURRENT_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$CURRENT_STATUS" != "stopped" ]; then
  STOP_QMP="$(qm status "$VMID" --verbose 2>/dev/null | awk '$1=="qmpstatus:"{print $2;exit}')" || STOP_QMP=""
  if [ "$STOP_QMP" = "paused" ]; then
    # A napping computer cannot shut itself down. Switch it off.
    qm stop "$VMID"
    STOP_MODE=asleep
  else
    SHUTDOWN_STARTED="$(date +%s)"
    if qm shutdown "$VMID" --timeout ${timeoutSeconds}; then
      STOP_MODE=graceful
    else
      SHUTDOWN_WAITED="$(( $(date +%s) - SHUTDOWN_STARTED ))"
      [ "$SHUTDOWN_WAITED" -ge 0 ] || SHUTDOWN_WAITED=0
      qm stop "$VMID"
      STOP_MODE="forced $SHUTDOWN_WAITED ${timeoutSeconds}"
    fi
  fi
fi
FINAL_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$FINAL_STATUS" != "stopped" ]; then
  echo "VMID $VMID did not stop (status=$FINAL_STATUS)" >&2
  exit 1
fi
echo "stopped $VMID"
echo "HIVRA_STOP_MODE $STOP_MODE"`;
}


export function verifiedStopVmScript(vmid: number, timeoutSeconds: number, bindingTag: string | null, disableAutostart = false): string {
  // qm set is refused while a hibernation holds its lock, so the saved memory
  // is discarded before autostart is turned off.
  const boot = disableAutostart ? `VMID=${vmid}
${hibernationDiscardBody()}
ONBOOT_FAILED=0
qm set ${vmid} --onboot 0 >/dev/null 2>&1 || ONBOOT_FAILED=1` : "";
  const verify = disableAutostart ? `
ONBOOT="$(qm config ${vmid} | sed -n 's/^onboot:[[:space:]]*//p')"
[ "$ONBOOT_FAILED" = "0" ] && [ "\${ONBOOT:-0}" = "0" ] || { echo "autostart disable not confirmed" >&2; exit 1; }` : "";
  return `${lifecycleMutationPrelude(vmid, bindingTag)}
${boot}
${verifiedStopVmBody(vmid, timeoutSeconds)}${verify}`;
}
