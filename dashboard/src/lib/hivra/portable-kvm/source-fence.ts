import { shellQuote } from "@/lib/hivra/proxmox-target";
import { z } from "zod";

const prefix = "HIVRA_KVM_PORTABLE_FENCE_V1 ";
const scopeSchema = z.object({
  agentId: z.string().uuid(),
  operationId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  hostId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(100).max(999_999_999).refine(value => value !== 9302),
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
}).strict();
const fenceSchema = scopeSchema.extend({
  configurationSha256: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.literal("fenced"),
}).strict();

export type PortableKvmSourceScope = z.infer<typeof scopeSchema>;
export type PortableKvmSourceFence = z.infer<typeof fenceSchema>;

export function buildPortableKvmSourceFenceScript(input: PortableKvmSourceScope, mode: "acquire" | "verify" = "acquire") {
  const scope = scopeSchema.parse(input);
  const evidence = JSON.stringify({ ...scope, state: "fenced" }).slice(0, -1);
  return `set -euo pipefail
umask 077
VMID=${scope.vmid}
TAG=${shellQuote(scope.bindingTag)}
HOST=${shellQuote(scope.hostId)}
[ "$(hostname -s)" = "$HOST" ]
ROOT=/var/lib/hivra-sleep
DIR="$ROOT/portable-kvm-fences"
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || exit 1
case "$(stat -c '%u:%a' "$ROOT")" in 0:700|0:755) ;; *) exit 1 ;; esac
${mode === "acquire" ? 'mkdir -m 0700 "$DIR" 2>/dev/null || :' : ':'}
[ -d "$DIR" ] && [ ! -L "$DIR" ] && [ "$(stat -c '%u:%a' "$DIR")" = 0:700 ] || exit 1
MARK="$DIR/$VMID"
RECEIPT=${shellQuote(JSON.stringify(scope))}
exec 9>"/run/lock/hivra-vm-$VMID.lock"
flock -x -w 20 9
check_stopped() {
  CONFIG="$(timeout 12 qm config "$VMID" --current 1 </dev/null)"
  [ "$(timeout 12 qm status "$VMID" </dev/null)" = 'status: stopped' ]
  [ ! -e "/run/qemu-server/$VMID.pid" ]
  [ -r "/etc/pve/qemu-server/$VMID.conf" ]
  if grep -Eq '^\\[' "/etc/pve/qemu-server/$VMID.conf" ||
    grep -Eq '^vmstate:|^template:[[:space:]]+1$|^onboot:[[:space:]]+1$' <<<"$CONFIG"; then return 1; fi
  TAGS="$(sed -n 's/^tags:[[:space:]]*//p' <<<"$CONFIG" | tr ';' '\\n' | grep '^hivra-bind-' || true)"
  [ "$TAGS" = "$TAG" ] || return 1
  [ ! -L "$ROOT/cold-$VMID" ] && [ "$(cat "$ROOT/cold-$VMID")" = "$TAG" ] || return 1
  [ ! -e "$ROOT/stored-$VMID" ] && [ ! -L "$ROOT/stored-$VMID" ] || return 1
}
check_stopped
LOCK="$(sed -n 's/^lock:[[:space:]]*//p' <<<"$CONFIG")"
if [ -e "$MARK" ] || [ -L "$MARK" ]; then
  [ -f "$MARK" ] && [ ! -L "$MARK" ] && [ "$(stat -c '%u:%a:%h' "$MARK")" = 0:600:1 ] || exit 1
  [ "$(cat "$MARK")" = "$RECEIPT" ]
  ${mode === "acquire" ? '[ -z "$LOCK" ] || [ "$LOCK" = backup ]' : '[ "$LOCK" = backup ]'}
else
  ${mode === "verify" ? "exit 1" : ""}
  [ -z "$LOCK" ]
  TMP="$(mktemp "$DIR/.new-$VMID.XXXXXXXX")"
  trap 'rm -f -- "$TMP"' EXIT
  printf '%s\\n' "$RECEIPT" >"$TMP"
  sync -f "$TMP"
  mv -T -- "$TMP" "$MARK"
  sync -f "$DIR"
  trap - EXIT
fi
${mode === "acquire" ? 'if [ -z "$LOCK" ]; then timeout 12 qm set "$VMID" --lock backup </dev/null >/dev/null; fi' : ':'}
check_stopped
[ "$(sed -n 's/^lock:[[:space:]]*//p' <<<"$CONFIG")" = backup ]
SHA="$(printf '%s\\n' "$CONFIG" | sha256sum | cut -d' ' -f1)"
printf '%s%s,"configurationSha256":"%s"}\\n' ${shellQuote(prefix)} ${shellQuote(evidence)} "$SHA"
`;
}

export function parsePortableKvmSourceFence(stdout: string, input: PortableKvmSourceScope): PortableKvmSourceFence | null {
  const scope = scopeSchema.parse(input);
  const receipts = stdout.split("\n").filter(line => line.startsWith(prefix));
  if (receipts.length !== 1) return null;
  try {
    const result = fenceSchema.safeParse(JSON.parse(receipts[0].slice(prefix.length)));
    if (!result.success || result.data.agentId !== scope.agentId || result.data.generation !== scope.generation
      || result.data.operationId !== scope.operationId
      || result.data.hostId !== scope.hostId || result.data.vmid !== scope.vmid || result.data.bindingTag !== scope.bindingTag) return null;
    return result.data;
  } catch { return null; }
}
