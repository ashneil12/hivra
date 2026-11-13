import "server-only";

import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { isAgentAwake } from "../agent-sleep-store";
import { readSleepHostRow } from "../agent-sleep";
import { resolveSleepTarget, type AgentRow } from "../agent-wake";
import { channelWakeHostAllowed, resolveChannelWakeConfig, type ChannelWakeChannel } from "./config";
import { readChannelWakeRows, updateChannelWakeRow, type ChannelWakeRow } from "./store";
import { runMatrixPusherProgram } from "./adapters/matrix-pusher";
import { matrixPushkey, matrixPushUrl, type MatrixPusherRequest, type MatrixPusherResult } from "./adapters/matrix-pusher-program";

/**
 * The owner's "Wake on <channel> messages" switch for one agent, for the
 * generic channels. Only Matrix has one today.
 *
 * Matrix: turning it on runs a program in the agent's own computer, while it
 * is awake, that adds Hivra's pusher on the agent's homeserver with the
 * agent's own access token. The token never leaves the computer and is never
 * stored; the row keeps only its fingerprint (to notice a changed login) and
 * the opt-in's id (the pushkey derives from it). Turning it off forgets the
 * opt-in first, so the agent stops sleeping on it at once, and then removes the
 * pusher if the computer is awake. A pusher left behind is removed by its
 * homeserver on its next push, which the route answers with "rejected".
 *
 * Dark unless HIVRA_CHANNEL_WAKE, HIVRA_CHANNEL_WAKE_SECRET,
 * HIVRA_CHANNEL_WAKE_CHANNELS (naming the channel) and
 * HIVRA_CHANNEL_WAKE_BASE_URL are configured.
 */

const LOG_SOURCE = "channel-wake-owner";
const TABLE = "hivra_agent_channel_wake";

/** Channels with an owner switch. */
export const OWNER_SWITCH_CHANNELS: readonly ChannelWakeChannel[] = ["matrix"];
/** Agent kinds that can have one. */
const COVERED_KINDS: readonly string[] = ["hermes"];

export interface ChannelWakeView {
  channel: ChannelWakeChannel;
  /** The switch can be shown for this agent. */
  available: boolean;
  enabled: boolean;
  /** A message would wake the agent while it sleeps. For Matrix, the same as enabled. */
  armed: boolean;
}

export type ChannelWakeChange =
  | { ok: true; view: ChannelWakeView; wake: boolean }
  | { ok: false; status: number; code: string; message: string };

type Env = Record<string, string | undefined>;

export interface ChannelOwnerDeps {
  env?: Env;
  runPusher?: (target: { vmid: number; bindingTag: string | null; env: unknown }, request: MatrixPusherRequest) => Promise<MatrixPusherResult>;
  newArmId?: () => string;
  now?: () => number;
}

export function isOwnerSwitchChannel(value: unknown): value is ChannelWakeChannel {
  return typeof value === "string" && (OWNER_SWITCH_CHANNELS as readonly string[]).includes(value);
}

/** The switches for this channel, or null. Matrix also needs a push gateway address. */
function switchConfig(channel: ChannelWakeChannel, env: Env) {
  const config = resolveChannelWakeConfig(env);
  if (!config || !config.channels.has(channel) || !isOwnerSwitchChannel(channel)) return null;
  const pushUrl = channel === "matrix" ? matrixPushUrl(config.baseUrl) : null;
  if (channel === "matrix" && !pushUrl) return null;
  return { config, pushUrl };
}

async function availability(agent: AgentRow, channel: ChannelWakeChannel, env: Env): Promise<boolean> {
  const sw = switchConfig(channel, env);
  if (!sw) return false;
  if (!COVERED_KINDS.includes(String(agent.type ?? ""))) return false;
  if (agent.deployment_mode !== "hivra-managed" || agent.computer_substrate !== "proxmox-kvm") return false;
  if (sw.config.mode === "canary") {
    const host = await readSleepHostRow(agent);
    if (!host || !channelWakeHostAllowed(sw.config, host.sleep_mode)) return false;
  }
  return true;
}

async function readRow(agentId: string, channel: ChannelWakeChannel): Promise<ChannelWakeRow | null> {
  return (await readChannelWakeRows(agentId)).find((row) => row.channel === channel) ?? null;
}

function viewOf(channel: ChannelWakeChannel, available: boolean, row: Pick<ChannelWakeRow, "enabled"> | null): ChannelWakeView {
  const enabled = row?.enabled === true;
  return { channel, available, enabled, armed: available && enabled };
}

export async function readChannelWakeView(agent: AgentRow, channel: ChannelWakeChannel, deps: ChannelOwnerDeps = {}): Promise<ChannelWakeView> {
  const available = await availability(agent, channel, deps.env ?? process.env).catch(() => false);
  if (!available) return viewOf(channel, false, null);
  const row = await readRow(String(agent.id), channel).catch(() => null);
  return viewOf(channel, true, row);
}

const refuse = (status: number, code: string, message: string): ChannelWakeChange => ({ ok: false, status, code, message });

const MATRIX_MESSAGES: Record<string, string> = {
  no_env: "Your agent has no Matrix account set up yet. Connect Matrix first.",
  no_homeserver: "Your agent has no Matrix account set up yet. Connect Matrix first.",
  no_token: "Your agent has no Matrix account set up yet. Connect Matrix first.",
  password_login: "Your agent signs in to Matrix with a password. Give it an access token instead to use this.",
  bad_homeserver: "Your agent's Matrix homeserver address does not look right.",
  token_rejected: "Your Matrix homeserver did not accept your agent's access token. Connect Matrix again.",
  homeserver_unreachable: "Your agent could not reach its Matrix homeserver. Try again in a moment.",
  homeserver_error: "Your Matrix homeserver refused the request. Try again in a moment.",
  asleep: "Your agent needs to be awake to turn this on. Open it and try again.",
  guest_busy: "Your agent is busy. Try again in a moment.",
};

async function targetOf(agent: AgentRow): Promise<{ vmid: number; bindingTag: string | null; env: unknown } | null> {
  try {
    const resolved = await resolveSleepTarget(agent, LOG_SOURCE);
    if (!resolved.ok || !resolved.target.bindingTag) return null;
    return { vmid: resolved.target.vmid, bindingTag: resolved.target.bindingTag, env: resolved.target.env };
  } catch {
    return null;
  }
}

/** Creates or replaces the opt-in row. True when saved. */
async function saveOptIn(row: Pick<ChannelWakeRow, "agent_id" | "channel" | "cred_fp" | "arm_id" | "arm_data">, nowIso: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { error } = await supabaseAdmin.from(TABLE).upsert({
      ...row,
      enabled: true,
      state: "idle",
      pending_since: null,
      next_attempt_at: null,
      arm_failures: 0,
      blocked_until: null,
      last_error: null,
      updated_at: nowIso,
    }, { onConflict: "agent_id,channel" });
    return !error;
  } catch {
    return false;
  }
}

export async function enableChannelWake(agent: AgentRow, channel: ChannelWakeChannel, deps: ChannelOwnerDeps = {}): Promise<ChannelWakeChange> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const agentId = String(agent.id);
  const sw = switchConfig(channel, env);
  if (!sw || !(await availability(agent, channel, env).catch(() => false))) {
    return refuse(409, "not_available", "Waking on these messages is not available for this agent.");
  }
  if (agent.status !== "running" || !isAgentAwake(agent)) {
    return refuse(409, "not_awake", "Your agent needs to be awake to turn this on. Open it and try again.");
  }
  let current: ChannelWakeRow | null;
  try {
    current = await readRow(agentId, channel);
  } catch {
    return refuse(503, "not_saved", "Could not save this setting.");
  }
  // An earlier opt-in is switched off first: its pusher is replaced below, and
  // if anything after this fails the agent must not sleep counting on it.
  if (current?.enabled) {
    const off = await updateChannelWakeRow(agentId, channel, [current.state], { enabled: false });
    if (!off) return refuse(409, "changed", "This setting just changed. Try again.");
  }
  const target = await targetOf(agent);
  if (!target) return refuse(409, "not_awake", "Your agent needs to be awake to turn this on. Open it and try again.");

  const armId = (deps.newArmId ?? randomUUID)();
  const runPusher = deps.runPusher ?? runMatrixPusherProgram;
  const result = await runPusher(target, {
    op: "register",
    pushkey: matrixPushkey(sw.config.secret, agentId, armId),
    url: sw.pushUrl!,
  });
  if (!result.ok) {
    log.warn("channel wake opt-in could not register the pusher", {
      source: LOG_SOURCE,
      failureType: "channel_wake_register_failed",
      instanceId: agentId,
      channel,
      reason: result.reason,
    });
    return refuse(409, result.reason.slice(0, 40), MATRIX_MESSAGES[result.reason] ?? "Could not set this up on your agent. Try again in a moment.");
  }
  const saved = await saveOptIn({
    agent_id: agentId,
    channel,
    cred_fp: result.fp,
    arm_id: armId,
    arm_data: { homeserverHost: result.homeserverHost, registeredAt: new Date(now()).toISOString() },
  }, new Date(now()).toISOString());
  if (!saved) {
    // Not saved: the new pusher's pushes find no opt-in and are rejected, so the homeserver drops it.
    return refuse(503, "not_saved", "Could not save this setting.");
  }
  return { ok: true, view: viewOf(channel, true, { enabled: true }), wake: false };
}

/**
 * Turns it off: the opt-in is forgotten first (so the agent no longer sleeps
 * on it and its pushes are rejected), then the pusher is removed while the
 * computer is awake. An agent that was asleep is woken by the caller.
 */
export async function disableChannelWake(agent: AgentRow, channel: ChannelWakeChannel, deps: ChannelOwnerDeps = {}): Promise<ChannelWakeChange> {
  const env = deps.env ?? process.env;
  const agentId = String(agent.id);
  let row: ChannelWakeRow | null;
  try {
    row = await readRow(agentId, channel);
  } catch {
    return refuse(503, "not_saved", "Could not save this setting.");
  }
  const available = await availability(agent, channel, env).catch(() => false);
  if (!row || (!row.enabled && !row.arm_id)) return { ok: true, view: viewOf(channel, available, null), wake: false };
  const off = await updateChannelWakeRow(agentId, channel, [row.state], {
    enabled: false, cred_fp: null, arm_id: null, arm_data: {}, deferred_wake_at: null, last_error: null,
  });
  if (!off) return refuse(409, "changed", "This setting just changed. Try again.");

  const awake = agent.status === "running" && isAgentAwake(agent);
  if (awake) {
    const target = await targetOf(agent);
    const removed = target ? await (deps.runPusher ?? runMatrixPusherProgram)(target, { op: "remove" }) : { ok: false as const, reason: "no_target" };
    if (!removed.ok) {
      log.warn("channel wake opt-out could not remove the pusher; the homeserver drops it on its next push", {
        source: LOG_SOURCE,
        failureType: "channel_wake_remove_failed",
        instanceId: agentId,
        channel,
        reason: removed.reason,
      });
    }
  }
  return { ok: true, view: viewOf(channel, available, { enabled: false }), wake: !awake && row.enabled };
}
