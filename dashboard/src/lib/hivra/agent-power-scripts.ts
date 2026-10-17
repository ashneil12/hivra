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


export function verifiedStopVmBody(vmid: number, timeoutSeconds: number): string {
  return `VMID=${vmid}
STOP_MODE=already
CURRENT_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$CURRENT_STATUS" != "stopped" ]; then
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
FINAL_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$FINAL_STATUS" != "stopped" ]; then
  echo "VMID $VMID did not stop (status=$FINAL_STATUS)" >&2
  exit 1
fi
echo "stopped $VMID"
echo "HIVRA_STOP_MODE $STOP_MODE"`;
}


export function verifiedStopVmScript(vmid: number, timeoutSeconds: number, bindingTag: string | null, disableAutostart = false): string {
  const boot = disableAutostart ? `ONBOOT_FAILED=0
qm set ${vmid} --onboot 0 >/dev/null 2>&1 || ONBOOT_FAILED=1` : "";
  const verify = disableAutostart ? `
ONBOOT="$(qm config ${vmid} | sed -n 's/^onboot:[[:space:]]*//p')"
[ "$ONBOOT_FAILED" = "0" ] && [ "\${ONBOOT:-0}" = "0" ] || { echo "autostart disable not confirmed" >&2; exit 1; }` : "";
  return `${lifecycleMutationPrelude(vmid, bindingTag)}
${boot}
${verifiedStopVmBody(vmid, timeoutSeconds)}${verify}`;
}

