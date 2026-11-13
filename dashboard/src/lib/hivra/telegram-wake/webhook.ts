import "server-only";

import { ensureHivraAgentAwake, readHivraAgentRow } from "../agent-wake";
import { decryptTelegramToken, deleteWakeWebhook, type TelegramWakeDeps } from "./lifecycle";
import { readTelegramWakeRow, updateTelegramWakeRow } from "./store";

/**
 * What a verified Telegram call does, after the 503 is sent.
 *
 * Armed and the agent asleep: wake it. The wake takes the webhook down before
 * the computer runs, so the message waits for Hermes.
 * A webhook still set while the agent is awake or stopped (a wake that did not
 * go through the usual path): take it down now, so Hermes can poll.
 * Anything else: nothing, Telegram's next try finds the same.
 */

/** How long the wake may run here: this already runs after the answer. */
const WAKE_WAIT_MS = 120_000;

export type TelegramWakeCallResult = "woke" | "disarmed" | "nothing";

export async function handleTelegramWakeCall(agentId: string, deps: TelegramWakeDeps = {}): Promise<TelegramWakeCallResult> {
  const [row, agent] = await Promise.all([
    readTelegramWakeRow(agentId).catch(() => null),
    readHivraAgentRow(agentId).catch(() => null),
  ]);
  if (!row || !agent) return "nothing";
  const asleep = agent.status === "running" && (agent.sleep_state === "napping" || agent.sleep_state === "hibernated"
    || agent.sleep_state === "wake_failed");
  const hasWebhook = row.state === "armed" || row.state === "disarm_failed" || row.state === "arming";

  if (hasWebhook && asleep) {
    await ensureHivraAgentAwake(agentId, { trigger: "telegram", waitMs: WAKE_WAIT_MS });
    return "woke";
  }
  // A wake or sleep in flight settles the row itself.
  if (hasWebhook && agent.operation_id == null && row.state !== "arming") {
    const token = decryptTelegramToken(row);
    if (!token) return "nothing";
    const deleted = await deleteWakeWebhook(token, deps);
    if (deleted.ok) {
      await updateTelegramWakeRow(agentId, [row.state], { state: "idle", pending_since: null, next_attempt_at: null, last_error: null });
      return "disarmed";
    }
  }
  return "nothing";
}
