import "server-only";

import { z } from "zod";

import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import type { ComputerTemplateId } from "./computer-catalog";
import { resolvePlanAgentSlots } from "./resource-gate";

const Slot = z.object({
  host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  node: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(100).max(999999999),
  ip: z.string().ip({ version: "v4" }),
  claim: z.string().uuid(),
}).strict();
const Slots = z.object({ omarchy: Slot, windows: Slot }).strict();
export type PreparedCanaryProfile = "omarchy" | "windows";
export type PreparedCanarySlot = z.infer<typeof Slot>;
export type PreparedCanaryLifecycleAction = "start" | "stop" | "restart";

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
  const slot = readPreparedCanarySlot(profile, env);
  if (!slot
    || row.type !== "linux-desktop"
    || row.managed_provisioner_channel !== "canary"
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
  const desiredOnboot = action === "stop" ? 0 : 1;
  const transition = action === "stop"
    ? `if [ "$CURRENT_STATUS" != stopped ]; then
  qm shutdown "$VMID" --timeout 60 || qm stop "$VMID"
fi
EXPECTED_STATUS=stopped`
    : action === "restart"
      ? `if [ "$CURRENT_STATUS" != stopped ]; then
  qm shutdown "$VMID" --timeout 60 || qm stop "$VMID"
fi
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
printf '%s\\n' "$CONFIG" | grep -F -- ${shellQuote(`name: hivra-${profile}-canary`)} >/dev/null || exit 72
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

export function readPreparedCanarySlot(
  profile: PreparedCanaryProfile,
  env: NodeJS.ProcessEnv = process.env,
): PreparedCanarySlot | null {
  if (env.HIVRA_MANAGED_PROVISIONER_CHANNEL !== "canary") return null;
  try {
    const parsed = Slots.parse(JSON.parse(env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON ?? ""));
    return parsed[profile];
  } catch {
    return null;
  }
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

type Dependencies = {
  runHost: (script: string, slot: PreparedCanarySlot) => Promise<HostScriptResult>;
  findOwnerProfile: (userId: string, profile: PreparedCanaryProfile) => Promise<AgentRow | null>;
  findSlotOwner: (slot: PreparedCanarySlot) => Promise<AgentRow | null>;
  insert: (row: Record<string, unknown>) => Promise<AgentRow>;
  markBindingEnforced: (row: AgentRow) => Promise<AgentRow>;
};

const defaults: Dependencies = {
  runHost: (script, slot) => runProxmoxHostScript(
    script,
    resolveProxmoxTargetConfiguration(process.env, slot.host).env,
    { timeoutMs: 30_000, maxOutputBytes: 16_384 },
  ),
  findOwnerProfile: async (userId, profile) => {
    if (!supabaseAdmin) throw new Error("database_unavailable");
    const { data, error } = await supabaseAdmin.from("hivra_agents").select("*")
      .eq("user_id", userId).eq("computer_profile", profile).neq("status", "deleted")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data as AgentRow | null;
  },
  findSlotOwner: async slot => {
    if (!supabaseAdmin) throw new Error("database_unavailable");
    const { data, error } = await supabaseAdmin.from("hivra_agents").select("*")
      .eq("proxmox_host", slot.host).eq("vmid", slot.vmid).neq("status", "deleted").maybeSingle();
    if (error) throw error;
    return data as AgentRow | null;
  },
  insert: async row => {
    if (!supabaseAdmin) throw new Error("database_unavailable");
    // A prepared computer is a Hivra-managed row, so the database writes it
    // only after counting the owner's plan slots under the slot lock (T35).
    const slots = await resolvePlanAgentSlots(String(row.user_id));
    if (!slots) throw new Error("plan_access_required");
    const { data, error } = await supabaseAdmin.rpc("insert_hivra_managed_agent", { p_row: row, p_agent_limit: slots.agentLimit });
    if (error) throw error;
    const result = data as { status?: unknown; row?: unknown } | null;
    if (result?.status === "plan_agent_limit") throw new Error("plan_agent_limit");
    if (result?.status !== "inserted" || !result.row || typeof result.row !== "object") throw new Error("insert_unconfirmed");
    return result.row as AgentRow;
  },
  markBindingEnforced: async row => {
    if (!supabaseAdmin) throw new Error("database_unavailable");
    const { data, error } = await supabaseAdmin.from("hivra_agents")
      .update({ infrastructure_binding_token_enforced: true })
      .eq("id", row.id).eq("user_id", row.user_id).eq("proxmox_host", row.proxmox_host)
      .eq("vmid", row.vmid).eq("infrastructure_binding_token_hash", row.infrastructure_binding_token_hash)
      .eq("infrastructure_binding_token_enforced", false).select().single();
    if (error || !data) throw error ?? new Error("binding_update_unconfirmed");
    return data as AgentRow;
  },
};

function verificationScript(profile: PreparedCanaryProfile, slot: PreparedCanarySlot): string {
  const encodedMarker = `hivra-${profile}-operation%3A${slot.claim}`;
  const plainMarker = `hivra-${profile}-operation:${slot.claim}`;
  return `set -euo pipefail
VMID=${slot.vmid}
CONFIG="$(qm config "$VMID")"
case "$CONFIG" in *${shellQuote(encodedMarker)}*|*${shellQuote(plainMarker)}*) ;; *) exit 31 ;; esac
printf '%s\\n' "$CONFIG" | grep -F -- ${shellQuote(`name: hivra-${profile}-canary`)} >/dev/null
qm set "$VMID" --onboot 1 --startup order=30,up=15,down=60 >/dev/null
STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$STATUS" = stopped ]; then qm start "$VMID" >/dev/null; fi
for _ in $(seq 1 20); do
  if [ "$(qm status "$VMID" | awk '{print $2}')" = running ] \
    && qm agent "$VMID" ping >/dev/null 2>&1; then
    echo HIVRA_PREPARED_COMPUTER_READY
    exit 0
  fi
  sleep 1
done
echo "prepared computer guest agent is unavailable" >&2
exit 32`;
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
printf '%s\n' "$CONFIG" | grep -F -- ${shellQuote(`name: hivra-${profile}-canary`)} >/dev/null || exit 42
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

async function enforcePreparedCanaryBinding(
  row: AgentRow,
  profile: PreparedCanaryProfile,
  slot: PreparedCanarySlot,
  deps: Dependencies,
): Promise<AgentRow> {
  if (row.infrastructure_binding_token_enforced === true) return row;
  const bindingHash = typeof row.infrastructure_binding_token_hash === "string"
    ? row.infrastructure_binding_token_hash : "";
  const script = preparedCanaryBindingScript(profile, slot, bindingHash);
  const verified = await deps.runHost(script, slot);
  if (!verified.ok || !verified.stdout.split(/\r?\n/).includes("HIVRA_PREPARED_BINDING_READY")) {
    throw new Error("prepared_binding_unavailable");
  }
  return deps.markBindingEnforced(row);
}

export async function claimPreparedCanaryComputer(
  input: { userId: string; profile: PreparedCanaryProfile; name: string },
  dependencies: Partial<Dependencies> = {},
): Promise<AgentRow> {
  const deps = { ...defaults, ...dependencies };
  const slot = readPreparedCanarySlot(input.profile);
  if (!slot) throw new Error("prepared_profile_unavailable");
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("invalid_name");

  const prior = await deps.findOwnerProfile(input.userId, input.profile);
  if (prior) {
    if (prior.proxmox_host !== slot.host || prior.vmid !== slot.vmid) throw new Error("profile_already_claimed");
    return enforcePreparedCanaryBinding(prior, input.profile, slot, deps);
  }
  const currentOwner = await deps.findSlotOwner(slot);
  if (currentOwner) {
    if (currentOwner.user_id !== input.userId || currentOwner.computer_profile !== input.profile) {
      throw new Error("prepared_slot_claimed");
    }
    return enforcePreparedCanaryBinding(currentOwner, input.profile, slot, deps);
  }

  const verified = await deps.runHost(verificationScript(input.profile, slot), slot);
  if (!verified.ok || !verified.stdout.split(/\r?\n/).includes("HIVRA_PREPARED_COMPUTER_READY")) {
    throw new Error("prepared_guest_unavailable");
  }
  const inserted = await deps.insert({
    user_id: input.userId,
    type: "linux-desktop",
    computer_profile: input.profile,
    name,
    status: "running",
    desired_state: "running",
    deployment_mode: "hivra-managed",
    computer_substrate: "proxmox-kvm",
    managed_provisioner_channel: "canary",
    proxmox_host: slot.host,
    vmid: slot.vmid,
    ip: slot.ip,
    cpu: 4,
    ram: 8,
    provisioned_at: new Date().toISOString(),
    infrastructure_binding_token_enforced: false,
  });
  return enforcePreparedCanaryBinding(inserted, input.profile, slot, deps);
}
