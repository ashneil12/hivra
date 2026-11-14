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
import { loadRemoteDesktopAgentForUser, waitForMilliseconds } from "@/lib/remote-computers/agent-row";

type Dependencies = {
  loadAgent: (userId: string, computerId: string) => Promise<RemoteDesktopAgentRow | null>;
  loadGrant: typeof loadOmarchyNativeActivationGrant;
  executeGuardian: typeof executeOmarchyGuardianAction;
  revokeSession: typeof revokeRemoteDesktopSession;
  wait: (milliseconds: number) => Promise<void>;
};

const DEFAULTS: Dependencies = {
  loadAgent: loadRemoteDesktopAgentForUser,
  loadGrant: loadOmarchyNativeActivationGrant,
  executeGuardian: executeOmarchyGuardianAction,
  revokeSession: revokeRemoteDesktopSession,
  wait: waitForMilliseconds,
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
