/**
 * Who asked for a live update (applyLiveUpdate) of a Hermes webfree box.
 *
 * Every live update force-recreates the gateway and official-dashboard
 * containers, which ends any web-chat turn in flight. Whether that is acceptable
 * depends on who asked:
 *
 *   - "user": a signed-in owner pressed Save & apply, Update, Redeploy/Repair,
 *     "restart the agent now" on a wallet change, or unlocked compute. They asked
 *     for the restart now; it recreates immediately, as it always has.
 *   - "operator": a person running a targeted rescue (the CRON_SECRET POST on
 *     /api/cron/redeploy-webui-instances, or an ops script). Also immediate.
 *   - "system": scheduled automation nobody is watching (the daily fleet sync, the
 *     pending-resize sweep, unhealthy-box recovery). These pass the in-flight
 *     gate first and defer, bounded, while a turn is running (see
 *     inflight-update-gate.ts).
 *
 * Kept in its own module (not instance-orchestrator) so callers can import the
 * constants even where tests mock the orchestrator.
 */

export type SystemLiveUpdateTrigger = "fleet_sync" | "pending_resize_sweep" | "unhealthy_recovery";

export type LiveUpdateInitiator =
  | { kind: "user" }
  | { kind: "operator" }
  | { kind: "system"; trigger: SystemLiveUpdateTrigger };

export const USER_LIVE_UPDATE: LiveUpdateInitiator = Object.freeze({ kind: "user" as const });
export const OPERATOR_LIVE_UPDATE: LiveUpdateInitiator = Object.freeze({ kind: "operator" as const });

export function systemLiveUpdate(trigger: SystemLiveUpdateTrigger): LiveUpdateInitiator {
  return Object.freeze({ kind: "system" as const, trigger });
}

export function isSystemLiveUpdate(
  initiator: LiveUpdateInitiator
): initiator is { kind: "system"; trigger: SystemLiveUpdateTrigger } {
  return initiator.kind === "system";
}
