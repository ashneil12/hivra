// The one list of how a bridge request may move. The database trigger in
// 20261112130000_explicit_state_transitions.sql enforces the same list, so a
// cron, a route or hand-written SQL cannot skip a step (pending -> done) or
// bring a finished request back.

export const BRIDGE_STATUSES = ["pending", "approved", "running", "done", "denied", "expired", "failed"] as const;
export type BridgeStatus = (typeof BRIDGE_STATUSES)[number];

export const BRIDGE_TRANSITIONS: Readonly<Record<BridgeStatus, readonly BridgeStatus[]>> = {
  pending: ["approved", "denied", "expired"],
  approved: ["running", "expired"],
  running: ["done", "failed"],
  done: [],
  denied: [],
  expired: [],
  failed: [],
};

export function canMoveBridgeRequest(from: BridgeStatus, to: BridgeStatus): boolean {
  return BRIDGE_TRANSITIONS[from].includes(to);
}

export function isFinalBridgeStatus(status: BridgeStatus): boolean {
  return BRIDGE_TRANSITIONS[status].length === 0;
}

/** A running request still unfinished this long after its own timeout is treated as lost. */
export const RUNNING_GRACE_MS = 5 * 60_000;
