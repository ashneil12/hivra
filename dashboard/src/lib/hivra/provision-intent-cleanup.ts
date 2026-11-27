import { shellQuote } from "@/lib/hivra/proxmox-target";

export function releaseExactProvisionIntentScript(
  operationId: string | null,
  vmid: number,
  bindingTag: string | null,
): string {
  if (
    !operationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId) ||
    !Number.isSafeInteger(vmid) || vmid <= 0 ||
    !bindingTag || !/^hivra-bind-[0-9a-f]{32}$/.test(bindingTag)
  ) return "";

  return `INTENT=${shellQuote(`/var/lib/hivra/provision-operations/operation-${operationId}.selected`)}
if [ -e "$INTENT" ] || [ -L "$INTENT" ]; then
  [ ! -L "$INTENT" ] && [ -f "$INTENT" ] \\
    && [ "$(stat -c '%a:%u:%g' "$INTENT")" = "600:0:0" ] \\
    && awk -F= -v op=${shellQuote(operationId)} -v vmid=${vmid} -v tag=${shellQuote(bindingTag)} '
      $1 == "operation_id" { op_count++; if ($0 != "operation_id=" op) bad=1 }
      $1 == "vmid" { vmid_count++; if ($0 != "vmid=" vmid) bad=1 }
      $1 == "binding_tag" { tag_count++; if ($0 != "binding_tag=" tag) bad=1 }
      $1 == "binding_enforced" { policy_count++; if ($0 != "binding_enforced=1") bad=1 }
      END { exit !(op_count == 1 && vmid_count == 1 && tag_count == 1 && policy_count == 1 && !bad) }
    ' "$INTENT" || { echo "Refusing to remove a mismatched provision reservation" >&2; exit 1; }
  rm -f -- "$INTENT"
fi`;
}
