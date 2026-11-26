import "server-only";

import { z } from "zod";
import { PreparedDesktopSlotSchema, preparedOmarchyRefreshPending } from "./prepared-omarchy-refresh-contract";

import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import type { ComputerTemplateId } from "./computer-catalog";
import { managedHivraProvisionerChannelForServerEnvironment } from "./managed-provisioner-channel";

const Slot = PreparedDesktopSlotSchema;
const Slots = z.object({ omarchy: Slot.optional(), windows: Slot.optional() }).strict()
  .refine((slots) => slots.omarchy !== undefined || slots.windows !== undefined, {
    message: "A prepared-computer configuration needs at least one profile.",
  });
export type PreparedCanaryProfile = "omarchy" | "windows";
export type PreparedCanarySlot = z.infer<typeof Slot>;
export type PreparedCanaryLifecycleAction = "start" | "stop" | "restart" | "force_stop" | "force_restart";

const PREPARED_PROFILES: readonly PreparedCanaryProfile[] = ["omarchy", "windows"];

/** The guest name the host scripts assert before they touch anything. */
export function preparedSlotName(profile: PreparedCanaryProfile, slot: PreparedCanarySlot): string {
  return slot.name ?? `hivra-${profile}-canary`;
}

type PreparedCanaryComputerRow = {
  type?: unknown;
  computer_profile?: unknown;
  managed_provisioner_channel?: unknown;
  proxmox_host?: unknown;
  vmid?: unknown;
  ip?: unknown;
};

/**
 * Prepared desktop fixtures are deliberately outside the Ubuntu provisioner.
 * Only the exact server-configured slot may enter their lifecycle adapter.
 */
export function matchPreparedCanaryComputer(
  row: PreparedCanaryComputerRow,
  env: NodeJS.ProcessEnv = process.env,
): { profile: PreparedCanaryProfile; slot: PreparedCanarySlot } | null {
  const profile = row.computer_profile;
  if (profile !== "omarchy" && profile !== "windows") return null;
  const slot = readPreparedSlot(profile, env);
  const channel = deploymentChannel(env);
  if (!slot
    || !channel
    || row.type !== "linux-desktop"
    || row.managed_provisioner_channel !== channel
    || row.proxmox_host !== slot.host
    || row.vmid !== slot.vmid
    || row.ip !== slot.ip) return null;
  return { profile, slot };
}

/**
 * Exact-identity lifecycle script for the two retained Canary desktop guests.
 * Persisted desired power state is mirrored into Proxmox `onboot`, so a host
 * restart cannot silently invert a user's stopped/running choice. This helper
 * never invokes the Ubuntu/Hermes guest provisioner.
 */
export function preparedCanaryLifecycleScript(
  profile: PreparedCanaryProfile,
  slot: PreparedCanarySlot,
  action: PreparedCanaryLifecycleAction,
): string {
  const encodedMarker = `hivra-${profile}-operation%3A${slot.claim}`;
  const plainMarker = `hivra-${profile}-operation:${slot.claim}`;
  const desiredOnboot = action === "stop" || action === "force_stop" ? 0 : 1;
  // Stop and Restart ask the computer to shut down and switch it off only if
  // it hasn't after 60 s, and say which (HIVRA_STOP_MODE, with the wait
  // measured on the host and that 60 s budget: a shutdown can also fail
  // sooner). Force off and Force restart switch it off at once.
  const shutdown = `if [ "$CURRENT_STATUS" != stopped ]; then
  SHUTDOWN_STARTED="$(date +%s)"
  if qm shutdown "$VMID" --timeout 60; then
    echo "HIVRA_STOP_MODE graceful"
  else
    SHUTDOWN_WAITED="$(( $(date +%s) - SHUTDOWN_STARTED ))"
    [ "$SHUTDOWN_WAITED" -ge 0 ] || SHUTDOWN_WAITED=0
    qm stop "$VMID"
    echo "HIVRA_STOP_MODE forced $SHUTDOWN_WAITED 60"
  fi
fi`;
  const switchOff = `if [ "$CURRENT_STATUS" != stopped ]; then
  qm stop "$VMID" --overrule-shutdown 1 --timeout 30 || qm stop "$VMID" --timeout 30
fi`;
  const transition = action === "stop"
    ? `${shutdown}
EXPECTED_STATUS=stopped`
    : action === "force_stop"
      ? `${switchOff}
EXPECTED_STATUS=stopped`
      : action === "restart" || action === "force_restart"
        ? `${action === "restart" ? shutdown : switchOff}
qm start "$VMID" 8>&-
EXPECTED_STATUS=running`
        : `if [ "$CURRENT_STATUS" = stopped ]; then qm start "$VMID" 8>&-; fi
EXPECTED_STATUS=running`;
  return `set -euo pipefail
VMID=${slot.vmid}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-prepared-${slot.vmid}.lock
flock -w 60 8 || { echo "prepared computer lifecycle is busy" >&2; exit 70; }
CONFIG="$(qm config "$VMID")"
case "$CONFIG" in *${shellQuote(encodedMarker)}*|*${shellQuote(plainMarker)}*) ;; *) exit 71 ;; esac
printf '%s\\n' "$CONFIG" | grep -F -- ${shellQuote(`name: ${preparedSlotName(profile, slot)}`)} >/dev/null || exit 72
qm set "$VMID" --onboot ${desiredOnboot} --startup order=30,up=15,down=60 >/dev/null
CURRENT_STATUS="$(qm status "$VMID" | awk '{print $2}')"
${transition}
for _ in $(seq 1 90); do
  CURRENT_STATUS="$(qm status "$VMID" | awk '{print $2}')"
  [ "$CURRENT_STATUS" = "$EXPECTED_STATUS" ] && {
    printf 'HIVRA_PREPARED_LIFECYCLE %s %s %s\\n' ${shellQuote(profile)} ${shellQuote(action)} "$CURRENT_STATUS"
    exit 0
  }
  sleep 1
done
echo "prepared computer did not reach $EXPECTED_STATUS" >&2
exit 73`;
}

export function preparedConsoleHostPreparationScript(profile: PreparedCanaryProfile, vmid: number): string {
  const displayWake = profile === "omarchy" ? `qm sendkey ${vmid} ctrl-alt-f1\nsleep 1` : ":";
  return `STATUS="$(qm status ${vmid} | awk '{print $2}')"
if [ "$STATUS" = stopped ]; then qm start ${vmid} >/dev/null; fi
for _ in $(seq 1 20); do
  [ "$(qm status ${vmid} | awk '{print $2}')" = running ] && break
  sleep 1
done
[ "$(qm status ${vmid} | awk '{print $2}')" = running ]
${displayWake}`;
}

/**
 * The prepared desktop slots this deployment can manage, or null when it
 * manages none. Slot identity is not proof that the guest is clean.
 */
export function readPreparedSlots(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<PreparedCanaryProfile, PreparedCanarySlot>> | null {
  const raw = env.HIVRA_PREPARED_COMPUTERS_JSON ?? env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON;
  if (!raw) return null;
  let parsed: z.infer<typeof Slots>;
  try {
    parsed = Slots.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  const usable: Partial<Record<PreparedCanaryProfile, PreparedCanarySlot>> = {};
  for (const profile of PREPARED_PROFILES) {
    const slot = parsed[profile];
    if (slot && proxmoxHostConfigured(env, slot.host)) usable[profile] = slot;
  }
  return usable;
}

export function readPreparedSlot(
  profile: PreparedCanaryProfile,
  env: NodeJS.ProcessEnv = process.env,
): PreparedCanarySlot | null {
  return readPreparedSlots(env)?.[profile] ?? null;
}

/** A slot host is usable only where this deployment holds that host's own
 * credentials. An unknown host must never fall back to another host's key, so
 * the per-host pair is required and there is no generic fallback. */
function proxmoxHostConfigured(env: NodeJS.ProcessEnv, host: string): boolean {
  const upper = host.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return Boolean(env[`PROXMOX_${upper}_SSH_HOST`]?.trim() && env[`PROXMOX_${upper}_SSH_USER`]?.trim());
}

/** The delivery lane this deployment provisions on. A prepared row carries it
 * so the deployment recognises its own fixture; an unreadable lane matches
 * nothing rather than guessing. */
function deploymentChannel(env: NodeJS.ProcessEnv): "default" | "canary" | null {
  try {
    return managedHivraProvisionerChannelForServerEnvironment(env as Record<string, string | undefined>);
  } catch {
    return null;
  }
}

/**
 * The gateway origin an admitted desktop console may be opened through. Only a
 * Hivra console host is accepted, and an unset or foreign origin fails closed.
 */
export function preparedConsoleOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.HIVRA_PREPARED_CONSOLE_ORIGIN ?? env.HIVRA_CANARY_CONSOLE_ORIGIN ?? "")
    .trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.hermesos\.cloud$/i.test(raw)) {
    return null;
  }
  return raw;
}

type AgentRow = Record<string, unknown> & {
  id: string;
  user_id: string;
  computer_profile: ComputerTemplateId | null;
  proxmox_host: string;
  vmid: number | null;
  infrastructure_binding_token_hash?: unknown;
  infrastructure_binding_token_enforced?: unknown;
};

export type PreparedCanaryAgentRow = AgentRow;

async function findPreparedSlotOwner(slot: PreparedCanarySlot): Promise<AgentRow | null> {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select("*")
    .eq("proxmox_host", slot.host).eq("vmid", slot.vmid).neq("status", "deleted").maybeSingle();
  if (error) throw error;
  return data as AgentRow | null;
}

export function preparedCanaryBindingScript(
  profile: PreparedCanaryProfile,
  slot: PreparedCanarySlot,
  bindingHash: string,
): string {
  if (!/^[a-f0-9]{64}$/.test(bindingHash)) throw new Error("prepared_binding_unavailable");
  const encodedMarker = `hivra-${profile}-operation%3A${slot.claim}`;
  const plainMarker = `hivra-${profile}-operation:${slot.claim}`;
  const bindingTag = `hivra-bind-${bindingHash.slice(0, 32)}`;
  return `set -euo pipefail
VMID=${slot.vmid}
CONFIG="$(qm config "$VMID")"
case "$CONFIG" in *${shellQuote(encodedMarker)}*|*${shellQuote(plainMarker)}*) ;; *) exit 41 ;; esac
printf '%s\n' "$CONFIG" | grep -F -- ${shellQuote(`name: ${preparedSlotName(profile, slot)}`)} >/dev/null || exit 42
TAGS="$(printf '%s\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
EXPECTED_TAG=${shellQuote(bindingTag)}
if printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_TAG"; then
  :
elif printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Eq '^hivra-bind-[a-f0-9]{32}$'; then
  exit 43
else
  NEW_TAGS="$EXPECTED_TAG"
  [ -z "$TAGS" ] || NEW_TAGS="$TAGS;$EXPECTED_TAG"
  qm set "$VMID" --tags "$NEW_TAGS" >/dev/null
fi
qm config "$VMID" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_TAG"
echo HIVRA_PREPARED_BINDING_READY`;
}

/**
 * Deleting a claim releases the prepared computer instead of destroying it
 * (docs/release/OMARCHY-PREPARED-REFRESH.md): under the slot's VM lock, the
 * claim's own binding tag is removed and every other tag is kept. The VM is
 * never stopped or destroyed. A slot bound to another claim is refused, and a
 * slot whose tag is already gone (a retried delete) succeeds unchanged.
 */
export function preparedCanaryReleaseScript(
  profile: PreparedCanaryProfile,
  slot: PreparedCanarySlot,
  bindingHash: string | null,
): string {
  if (bindingHash !== null && !/^[a-f0-9]{64}$/.test(bindingHash)) throw new Error("prepared_binding_unavailable");
  const encodedMarker = `hivra-${profile}-operation%3A${slot.claim}`;
  const plainMarker = `hivra-${profile}-operation:${slot.claim}`;
  const bindingTag = bindingHash ? `hivra-bind-${bindingHash.slice(0, 32)}` : "";
  return `set -euo pipefail
VMID=${slot.vmid}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-prepared-${slot.vmid}.lock
flock -x -w 60 8 || { echo "prepared computer lifecycle is busy" >&2; exit 50; }
CONFIG="$(qm config "$VMID")"
case "$CONFIG" in *${shellQuote(encodedMarker)}*|*${shellQuote(plainMarker)}*) ;; *) echo "prepared computer identity mismatch" >&2; exit 51 ;; esac
printf '%s\\n' "$CONFIG" | grep -F -- ${shellQuote(`name: ${preparedSlotName(profile, slot)}`)} >/dev/null \\
  || { echo "prepared computer name mismatch" >&2; exit 52; }
TAGS="$(printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
EXPECTED_TAG=${shellQuote(bindingTag)}
HELD=""; OTHER=""; KEEP=""
for TAG in $(printf '%s' "$TAGS" | tr ';,' '  '); do
  if [ -n "$EXPECTED_TAG" ] && [ "$TAG" = "$EXPECTED_TAG" ]; then HELD=1; continue; fi
  case "$TAG" in hivra-bind-*) OTHER=1 ;; esac
  KEEP="\${KEEP:+$KEEP;}$TAG"
done
if [ -n "$OTHER" ]; then
  echo "prepared computer is bound to another claim" >&2
  exit 53
fi
if [ -n "$HELD" ]; then
  if [ -n "$KEEP" ]; then qm set "$VMID" --tags "$KEEP" >/dev/null; else qm set "$VMID" --delete tags >/dev/null; fi
  AFTER="$(qm config "$VMID" | sed -n 's/^tags:[[:space:]]*//p')"
  for TAG in $(printf '%s' "$AFTER" | tr ';,' '  '); do
    [ "$TAG" != "$EXPECTED_TAG" ] || { echo "prepared computer binding was not released" >&2; exit 54; }
  done
fi
echo HIVRA_PREPARED_BINDING_RELEASED`;
}

/**
 * Which prepared slot a Hivra-managed prepared-profile row's Delete must
 * release: the matched slot, "unconfigured" when the row matches no slot
 * configured here (Delete must then keep the VM and refuse), or null for any
 * other row (including a self-managed Windows computer), which owns its VM.
 */
export function preparedComputerForDelete(
  row: PreparedCanaryComputerRow & { deployment_mode?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): { profile: PreparedCanaryProfile; slot: PreparedCanarySlot } | "unconfigured" | null {
  if (row.deployment_mode !== "hivra-managed") return null;
  if (row.computer_profile !== "omarchy" && row.computer_profile !== "windows") return null;
  return matchPreparedCanaryComputer(row, env) ?? "unconfigured";
}

/** Deleting a prepared claim releases its binding and keeps the VM. */
export async function releasePreparedComputerClaim(
  row: { infrastructure_binding_token_hash?: unknown },
  prepared: { profile: PreparedCanaryProfile; slot: PreparedCanarySlot },
  runHost: (script: string, slot: PreparedCanarySlot) => Promise<HostScriptResult> = (script, slot) => runProxmoxHostScript(
    script,
    resolveProxmoxTargetConfiguration(process.env, slot.host).env,
    { timeoutMs: 90_000, maxOutputBytes: 16_384 },
  ),
): Promise<HostScriptResult> {
  const bindingHash = typeof row.infrastructure_binding_token_hash === "string"
    && /^[a-f0-9]{64}$/.test(row.infrastructure_binding_token_hash)
    ? row.infrastructure_binding_token_hash
    : null;
  const result = await runHost(preparedCanaryReleaseScript(prepared.profile, prepared.slot, bindingHash), prepared.slot);
  if (result.ok && !result.stdout.split(/\r?\n/).includes("HIVRA_PREPARED_BINDING_RELEASED")) {
    return { ...result, ok: false, error: "prepared computer release was not confirmed" };
  }
  return result;
}

export async function resumePreparedCanaryComputer(
  input: { userId: string; profile: PreparedCanaryProfile; operator: boolean },
  findSlotOwner = findPreparedSlotOwner,
): Promise<AgentRow> {
  if (input.operator !== true) throw new Error("prepared_computer_operator_only");
  const slot = readPreparedSlot(input.profile);
  if (!slot) throw new Error("prepared_profile_unavailable");

  // An empty slot or absent binding is not proof of a clean guest. Until a
  // trusted reset exists this endpoint is read-only and cannot assign a slot.
  const row = await findSlotOwner(slot);
  if (!row || row.status === "deleted") throw new Error("prepared_profile_unavailable");
  if (row.user_id !== input.userId) throw new Error("prepared_slot_claimed");
  if (row.deployment_mode !== "hivra-managed" || row.computer_profile !== input.profile
    || !matchPreparedCanaryComputer(row)
    || row.operation_kind === "delete" || row.desired_state === "deleted"
    || (row.infrastructure_binding_token_enforced !== true
      && !(row.status === "provisioning" && preparedOmarchyRefreshPending(row)))) {
    throw new Error("prepared_profile_unavailable");
  }
  return row;
}
