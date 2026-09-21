import "server-only";

import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import {
  executeOmarchyGuardianAction,
  OmarchyGuardianGrant,
} from "@/lib/remote-computers/omarchy-native-guardian-host";
import {
  loadOmarchyNativeActivationGrant,
  revokeRemoteDesktopSession,
} from "@/lib/remote-computers/session-broker";
import { supabaseAdmin } from "@/lib/supabase";

const AGENT_FIELDS = [
  "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
  "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
  "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode", "proxmox_host",
  "infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision",
  "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel",
].join(",");

type Dependencies = {
  loadAgent: (userId: string, computerId: string) => Promise<RemoteDesktopAgentRow | null>;
  loadGrant: typeof loadOmarchyNativeActivationGrant;
  executeGuardian: typeof executeOmarchyGuardianAction;
  revokeSession: typeof revokeRemoteDesktopSession;
  wait: (milliseconds: number) => Promise<void>;
};

async function loadAgent(userId: string, computerId: string): Promise<RemoteDesktopAgentRow | null> {
  if (!supabaseAdmin) throw new Error("Native desktop database is unavailable.");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select(AGENT_FIELDS)
    .eq("id", computerId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Native desktop lookup failed.");
  return data as unknown as RemoteDesktopAgentRow | null;
}

const DEFAULTS: Dependencies = {
  loadAgent,
  loadGrant: loadOmarchyNativeActivationGrant,
  executeGuardian: executeOmarchyGuardianAction,
  revokeSession: revokeRemoteDesktopSession,
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

const STOP_ATTEMPTS = 40;

/** Stop, prove and release one exact persisted native Omarchy activation. */
export async function stopOmarchyNativeSession(
  userId: string,
  params: { computerId: string; sessionId: string; activationId: string },
  dependencies: Partial<Dependencies> = {},
): Promise<
  | { ok: true; sessionId: string; activationId: string; controllerReleased: true; desktopReady: false }
  | { ok: false; code: "stop_denied" | "stop_uncertain" }
> {
  const deps = { ...DEFAULTS, ...dependencies };
  const stored = await deps.loadGrant({
    userId,
    sessionId: params.sessionId,
    activationId: params.activationId,
  });
  if (!stored.ok) return { ok: false, code: "stop_denied" };
  const parsed = OmarchyGuardianGrant.safeParse(stored.guardianGrant);
  if (
    !parsed.success || parsed.data.ownerId !== userId
    || parsed.data.binding.computerId !== params.computerId
    || parsed.data.sessionId !== params.sessionId || parsed.data.leaseId !== params.activationId
  ) return { ok: false, code: "stop_denied" };
  let agent: RemoteDesktopAgentRow | null;
  try { agent = await deps.loadAgent(userId, params.computerId); }
  catch { return { ok: false, code: "stop_uncertain" }; }
  if (!agent) return { ok: false, code: "stop_uncertain" };

  const revoked = await deps.executeGuardian(userId, "revoke", parsed.data, agent);
  if (!revoked.ok) return { ok: false, code: "stop_uncertain" };
  const alreadyReleased = revoked.action === "revoke" && "releasePending" in revoked.result
    && revoked.result.releasePending === false;
  let stopped = false;
  for (let attempt = 0; !alreadyReleased && attempt < STOP_ATTEMPTS; attempt += 1) {
    const observed = await deps.executeGuardian(userId, "observe-stop", parsed.data, agent);
    if (observed.ok && observed.action === "observe-stop"
      && "ownedProcessBoundaryStopped" in observed.result) {
      stopped = true;
      break;
    }
    if (attempt + 1 < STOP_ATTEMPTS) await deps.wait(250);
  }
  if (!alreadyReleased) {
    if (!stopped) return { ok: false, code: "stop_uncertain" };
    const released = await deps.executeGuardian(userId, "release-stop", parsed.data, agent);
    if (!released.ok || released.action !== "release-stop"
      || !("controllerReleased" in released.result) || released.result.controllerReleased !== true) {
      return { ok: false, code: "stop_uncertain" };
    }
  }
  const session = await deps.revokeSession({
    userId,
    sessionId: params.sessionId,
    reason: "user_revoked",
  });
  if (!session.ok || session.inputState !== "released") {
    return { ok: false, code: "stop_uncertain" };
  }
  return {
    ok: true,
    sessionId: params.sessionId,
    activationId: params.activationId,
    controllerReleased: true,
    desktopReady: false,
  };
}
