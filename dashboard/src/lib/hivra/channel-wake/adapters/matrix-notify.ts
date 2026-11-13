import "server-only";

import { channelWakeSecret } from "../config";
import { readChannelWakeRows, type ChannelWakeRow } from "../store";
import { requestChannelWake, type ChannelWakeRequest } from "../lifecycle";
import { readHivraAgentRow, type AgentRow } from "../../agent-wake";
import { MATRIX_PUSH_APP_ID, verifyMatrixPushkey } from "./matrix-pusher-program";

/**
 * What Hivra's Matrix push gateway does with one POST /_matrix/push/v1/notify
 * (https://spec.matrix.org/latest/push-gateway-api/). Only devices with
 * Hivra's app id are read; each one's pushkey must carry a valid HMAC.
 *
 * - A forged or malformed pushkey: 401, with no database read.
 * - A valid pushkey whose opt-in is gone (off, replaced, agent deleted): the
 *   pushkey is listed in `rejected`, so the homeserver deletes that pusher.
 * - The agent is awake or waking: nothing.
 * - The agent is asleep: woken (trigger "channel") within the hourly cap; a
 *   wake over the cap is deferred, never dropped (requestChannelWake).
 *
 * The event itself is never read or kept: with format event_id_only it holds
 * only ids and counts anyway.
 */

export type MatrixNotifyOutcome =
  | { status: 200; rejected: string[]; woke: string[]; deferred: string[] }
  | { status: 400 | 401 | 404 };

export interface MatrixNotifyDeps {
  env?: Record<string, string | undefined>;
  readRows?: (agentId: string) => Promise<ChannelWakeRow[]>;
  readAgent?: (agentId: string) => Promise<AgentRow | null>;
  /** Starts a wake and returns at once. Must not throw. */
  wake: (agentId: string) => void;
  request?: typeof requestChannelWake;
}

/** At most this many devices in one push are looked at. */
const MAX_DEVICES = 20;

const ASLEEP_STATES = new Set(["napping", "hibernated", "wake_failed"]);

function devicesOf(body: unknown): unknown[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const notification = (body as Record<string, unknown>).notification;
  if (!notification || typeof notification !== "object" || Array.isArray(notification)) return null;
  const devices = (notification as Record<string, unknown>).devices;
  return Array.isArray(devices) ? devices : null;
}

export async function handleMatrixNotify(body: unknown, deps: MatrixNotifyDeps): Promise<MatrixNotifyOutcome> {
  const secret = channelWakeSecret(deps.env ?? process.env);
  if (!secret) return { status: 404 };
  const devices = devicesOf(body);
  if (!devices || devices.length > MAX_DEVICES) return { status: 400 };

  // Every one of our devices must verify before anything is read.
  const ours: Array<{ pushkey: string; agentId: string; armId: string }> = [];
  for (const device of devices) {
    if (!device || typeof device !== "object" || Array.isArray(device)) return { status: 400 };
    const d = device as Record<string, unknown>;
    if (d.app_id !== MATRIX_PUSH_APP_ID) continue;
    const verified = verifyMatrixPushkey(secret, d.pushkey);
    if (!verified) return { status: 401 };
    ours.push({ pushkey: d.pushkey as string, ...verified });
  }
  if (ours.length === 0) return { status: 401 };

  const readRows = deps.readRows ?? readChannelWakeRows;
  const readAgent = deps.readAgent ?? readHivraAgentRow;
  const request = deps.request ?? requestChannelWake;
  const rejected: string[] = [];
  const woke: string[] = [];
  const deferred: string[] = [];
  const seen = new Set<string>();

  for (const { pushkey, agentId, armId } of ours) {
    let row: ChannelWakeRow | null;
    try {
      row = (await readRows(agentId)).find((r) => r.channel === "matrix") ?? null;
    } catch {
      // Unknown: a pushkey only Hivra could have made, so wake rather than miss a message.
      if (!seen.has(agentId)) {
        seen.add(agentId);
        deps.wake(agentId);
        woke.push(agentId);
      }
      continue;
    }
    if (!row || row.enabled !== true || !row.arm_id || row.arm_id.toLowerCase() !== armId) {
      rejected.push(pushkey);
      continue;
    }
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    let agent: AgentRow | null;
    try {
      agent = await readAgent(agentId);
    } catch {
      deps.wake(agentId);
      woke.push(agentId);
      continue;
    }
    if (!agent) {
      rejected.push(pushkey);
      continue;
    }
    const asleep = agent.status === "running" && ASLEEP_STATES.has(String(agent.sleep_state));
    if (!asleep) continue;
    const outcome: ChannelWakeRequest = await request(agentId, "matrix", (id) => deps.wake(id));
    if (outcome === "deferred") deferred.push(agentId);
    else if (outcome !== "no_row") woke.push(agentId);
  }
  return { status: 200, rejected, woke, deferred };
}
