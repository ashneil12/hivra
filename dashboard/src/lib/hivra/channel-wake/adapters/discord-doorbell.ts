import "server-only";

import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { buildIdleProbeHostScript, parseIdleProbeOutput, parseIdleProbeRefusal } from "../../agent-sleep-scripts";
import { DISCORD_CHANNEL_SPEC } from "../registry";
import { readChannelWakeRows } from "../store";
import type { ChannelCoverageInput, ChannelWakeAdapter, ChannelWakeAdapterContext } from "../types";
import { wakeDoorbellEnabled } from "../doorbell-scripts";
import {
  buildDiscordDoorbellArmHostScript,
  parseDiscordDoorbellArmOutput,
  type DiscordDoorbellArmResult,
} from "./discord-doorbell-scripts";
import { disarmEmailDoorbell } from "./email-imap";

/**
 * Discord as a channel wake adapter, through the host wake doorbell.
 *
 * Before the stop (inside the framework's arm box), one host script reads the
 * computer's Discord bot token and reply settings through the vmid-bound
 * guest exec and hands them to the doorbell on the same host. The doorbell
 * checks the bot's login budget, opens its own gateway session and answers
 * armed once Discord said READY; only then does the sleep go on. The token
 * never comes back here: Hivra stores the budget it saw and the vmid, nothing
 * else.
 *
 * While the agent sleeps, a DM, a mention, a reply to the bot or a message in
 * a free-response channel makes the doorbell call wake-request (through the
 * wake proxy's helper) and send one typing indicator; it never posts. Every
 * wake takes the arm down here (disarmForWake); the doorbell then stays
 * connected about a minute while the agent's own session comes back.
 *
 * Covered only with Hermes's own catch-up on and a DM channel listed for it
 * (registry.ts), and only when HIVRA_WAKE_DOORBELLS lists discord. Built
 * ahead of the Canary Discord measurements, so it stays inert until they pass.
 */

const ARM_SCRIPT_TIMEOUT_MS = 13_000;
const OPT_IN_SCRIPT_TIMEOUT_MS = 30_000;

type RunScript = typeof runProxmoxHostScript;
type HostTarget = { vmid: number; bindingTag: string | null; env: unknown };

export interface DiscordDoorbellDeps {
  run?: RunScript;
  env?: Record<string, string | undefined>;
  readCredFp?: (agentId: string) => Promise<string | null>;
  resolveTarget?: (agentId: string) => Promise<HostTarget | null>;
}

async function credFpOf(agentId: string): Promise<string | null> {
  const rows = await readChannelWakeRows(agentId);
  const row = rows.find((r) => r.channel === "discord");
  return row?.enabled === true && typeof row.cred_fp === "string" ? row.cred_fp : null;
}

/** Arms the doorbell's Discord session for one computer. Never throws; a failure keeps the agent awake. */
export async function armDiscordDoorbell(ctx: ChannelWakeAdapterContext, deps: DiscordDoorbellDeps = {}): Promise<DiscordDoorbellArmResult> {
  if (!wakeDoorbellEnabled("discord", deps.env ?? process.env)) return { ok: false, reason: "doorbell_off" };
  const target = ctx.target;
  if (!target || !target.bindingTag) return { ok: false, reason: "no_target" };
  try {
    const credFp = await (deps.readCredFp ?? credFpOf)(ctx.agentId);
    if (!credFp) return { ok: false, reason: "no_fingerprint" };
    const script = buildDiscordDoorbellArmHostScript({ vmid: target.vmid, bindingTag: target.bindingTag, armId: ctx.armId, credFp });
    const run = await (deps.run ?? runProxmoxHostScript)(script, target.env as Parameters<RunScript>[1], { timeoutMs: ARM_SCRIPT_TIMEOUT_MS });
    return parseDiscordDoorbellArmOutput(run?.stdout ?? "", { vmid: target.vmid, armId: ctx.armId });
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}

export type DiscordOptInRead =
  | { ok: true; fp: string; backfill: boolean; dmBackfilled: boolean }
  | { ok: false; reason: string };

/**
 * The opt-in read: the idle probe, asked for Discord's fingerprint, in the
 * awake computer. It prints the fingerprint and the catch-up facts, never the
 * token. The owner is told plainly when Hermes's catch-up is off or lists no
 * DM channel, since the agent would then never sleep on Discord.
 */
export async function readDiscordOptIn(target: HostTarget, deps: { run?: RunScript } = {}): Promise<DiscordOptInRead> {
  try {
    const script = buildIdleProbeHostScript({ vmid: target.vmid, bindingTag: target.bindingTag }, { channels: ["discord"] });
    const run = await (deps.run ?? runProxmoxHostScript)(script, target.env as Parameters<RunScript>[1], { timeoutMs: OPT_IN_SCRIPT_TIMEOUT_MS });
    const stdout = run?.stdout ?? "";
    const probe = parseIdleProbeOutput(stdout);
    if (!probe) return { ok: false, reason: parseIdleProbeRefusal(stdout) ?? "no_answer" };
    const fp = probe.channelFps?.discord;
    if (typeof fp !== "string") return { ok: false, reason: "no_discord" };
    const facts = probe.channelFacts?.discord;
    if (!facts) return { ok: false, reason: "no_discord" };
    if (!facts.backfill) return { ok: false, reason: "backfill_off" };
    const dmBackfilled = !facts.dmsAllowed || facts.backfillChannels > 0;
    if (!dmBackfilled) return { ok: false, reason: "dm_not_backfilled" };
    return { ok: true, fp, backfill: true, dmBackfilled };
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}

export function createDiscordDoorbellAdapter(deps: DiscordDoorbellDeps = {}): ChannelWakeAdapter {
  return {
    ...DISCORD_CHANNEL_SPEC,
    coverageBlockers(input: ChannelCoverageInput): string[] {
      const reasons = DISCORD_CHANNEL_SPEC.coverageBlockers(input);
      if (!wakeDoorbellEnabled("discord", deps.env ?? process.env)) reasons.push("doorbell_off");
      return reasons;
    },
    async armBeforeSleep(ctx) {
      const result = await armDiscordDoorbell(ctx, deps);
      if (!result.ok) return { ok: false, reason: result.reason };
      // Never a secret: the vmid the session was opened for and the login budget Discord reported.
      return { ok: true, armData: { vmid: ctx.target?.vmid, loginRemaining: result.loginRemaining } };
    },
    /** Each arm replaces the last one for the same computer on the doorbell (closing any lingering session first). */
    async verifyClear() {
      return true;
    },
    // The doorbell's disarm is the same for every channel: one computer's arm, by vmid and arm id.
    disarmForWake: (ctx) => disarmEmailDoorbell(ctx, deps),
    async release(ctx) {
      await disarmEmailDoorbell(ctx, deps);
    },
  };
}

export const DISCORD_DOORBELL_ADAPTER: ChannelWakeAdapter = createDiscordDoorbellAdapter();
