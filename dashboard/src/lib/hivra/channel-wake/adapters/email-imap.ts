import "server-only";

import { readHivraAgentRow, resolveSleepTarget } from "@/lib/hivra/agent-wake";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { buildIdleProbeHostScript, parseIdleProbeOutput, parseIdleProbeRefusal } from "../../agent-sleep-scripts";
import { EMAIL_CHANNEL_SPEC } from "../registry";
import { readChannelWakeRows } from "../store";
import type { ChannelCoverageInput, ChannelWakeAdapter, ChannelWakeAdapterContext } from "../types";
import {
  buildDoorbellDisarmHostScript,
  buildEmailDoorbellArmHostScript,
  parseDoorbellArmOutput,
  parseDoorbellDisarmOutput,
  wakeDoorbellEnabled,
  type DoorbellArmResult,
} from "../doorbell-scripts";

/**
 * Email as a channel wake adapter, through the host wake doorbell.
 *
 * Before the stop (inside the framework's arm box), one host script reads the
 * computer's mail settings through the vmid-bound guest exec and hands them to
 * the doorbell on the same host; the doorbell records the INBOX baseline with
 * STATUS and answers armed. Only then does the sleep go on. The credentials
 * never come back here: Hivra stores the baseline and the host, nothing else.
 *
 * While the agent sleeps, a message from a sender Hermes would answer makes
 * the doorbell call wake-request (through the wake proxy's helper, signed with
 * the host credential), and the normal wake runs. Every wake takes the arm
 * down here (disarmForWake); a ring that lands while the agent is still
 * going to sleep is repeated by the doorbell until then.
 *
 * Needs HIVRA_WAKE_DOORBELLS to list email, on top of the channel wake
 * switches and the owner's opt-in. Without it email is never covered, so an
 * agent with live email stays awake exactly as before.
 */

const ARM_SCRIPT_TIMEOUT_MS = 13_000;
const DISARM_SCRIPT_TIMEOUT_MS = 7_000;
const LOG_SOURCE = "channel-wake-email";

type RunScript = typeof runProxmoxHostScript;
type HostTarget = { vmid: number; bindingTag: string | null; env: unknown };

export interface EmailImapDeps {
  run?: RunScript;
  env?: Record<string, string | undefined>;
  readCredFp?: (agentId: string) => Promise<string | null>;
  resolveTarget?: (agentId: string) => Promise<HostTarget | null>;
}

async function credFpOf(agentId: string): Promise<string | null> {
  const rows = await readChannelWakeRows(agentId);
  const row = rows.find((r) => r.channel === "email");
  return row?.enabled === true && typeof row.cred_fp === "string" ? row.cred_fp : null;
}

async function targetOf(agentId: string): Promise<HostTarget | null> {
  const agent = await readHivraAgentRow(agentId);
  if (!agent) return null;
  const resolved = await resolveSleepTarget(agent, LOG_SOURCE);
  if (!resolved.ok) return null;
  return { vmid: resolved.target.vmid, bindingTag: resolved.target.bindingTag, env: resolved.target.env };
}

/** Arms the doorbell for one computer. Never throws; a failure keeps the agent awake. */
export async function armEmailDoorbell(ctx: ChannelWakeAdapterContext, deps: EmailImapDeps = {}): Promise<DoorbellArmResult> {
  if (!wakeDoorbellEnabled("email", deps.env ?? process.env)) return { ok: false, reason: "doorbell_off" };
  const target = ctx.target;
  if (!target || !target.bindingTag) return { ok: false, reason: "no_target" };
  try {
    const credFp = await (deps.readCredFp ?? credFpOf)(ctx.agentId);
    if (!credFp) return { ok: false, reason: "no_fingerprint" };
    const script = buildEmailDoorbellArmHostScript({ vmid: target.vmid, bindingTag: target.bindingTag, armId: ctx.armId, credFp });
    const run = await (deps.run ?? runProxmoxHostScript)(script, target.env as Parameters<RunScript>[1], { timeoutMs: ARM_SCRIPT_TIMEOUT_MS });
    return parseDoorbellArmOutput(run?.stdout ?? "", { vmid: target.vmid, armId: ctx.armId });
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}

/** Takes one arm down on the host. Never throws. The vmid comes from what the arm stored, the host from the agent's record. */
export async function disarmEmailDoorbell(ctx: ChannelWakeAdapterContext, deps: EmailImapDeps = {}): Promise<{ ok: boolean; reason?: string }> {
  try {
    const target = ctx.target ?? await (deps.resolveTarget ?? targetOf)(ctx.agentId);
    if (!target) return { ok: false, reason: "no_target" };
    const armedVmid = ctx.armData.vmid;
    if (typeof armedVmid === "number" && armedVmid !== target.vmid) {
      // The computer moved since the arm: the old host's doorbell rings, its wake-request names a vmid Hivra no longer knows there, and the ring expires.
      return { ok: true, reason: "moved" };
    }
    const script = buildDoorbellDisarmHostScript({ vmid: target.vmid, armId: ctx.armData.vmid === undefined ? null : ctx.armId });
    const run = await (deps.run ?? runProxmoxHostScript)(script, target.env as Parameters<RunScript>[1], { timeoutMs: DISARM_SCRIPT_TIMEOUT_MS });
    const answer = parseDoorbellDisarmOutput(run?.stdout ?? "");
    return answer.ok ? { ok: true } : { ok: false, reason: "disarm_failed" };
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}

const OPT_IN_SCRIPT_TIMEOUT_MS = 30_000;

export type EmailOptInRead = { ok: true; fp: string; imapHost: string } | { ok: false; reason: string };

/**
 * The opt-in read: the idle probe, asked for email's fingerprint, in the
 * awake computer. It prints the fingerprint and the IMAP host name, never a
 * value, so nothing secret leaves the computer at opt-in either.
 */
export async function readEmailOptIn(target: HostTarget, deps: { run?: RunScript } = {}): Promise<EmailOptInRead> {
  try {
    const script = buildIdleProbeHostScript({ vmid: target.vmid, bindingTag: target.bindingTag }, { channels: ["email"] });
    const run = await (deps.run ?? runProxmoxHostScript)(script, target.env as Parameters<RunScript>[1], { timeoutMs: OPT_IN_SCRIPT_TIMEOUT_MS });
    const stdout = run?.stdout ?? "";
    const probe = parseIdleProbeOutput(stdout);
    if (!probe) return { ok: false, reason: parseIdleProbeRefusal(stdout) ?? "no_answer" };
    const fp = probe.channelFps?.email;
    if (typeof fp !== "string") return { ok: false, reason: "no_email" };
    const imapHost = probe.channelFacts?.email?.imapHost;
    if (!imapHost) return { ok: false, reason: "no_imap_host" };
    return { ok: true, fp, imapHost };
  } catch {
    return { ok: false, reason: "run_failed" };
  }
}

export function createEmailImapAdapter(deps: EmailImapDeps = {}): ChannelWakeAdapter {
  return {
    ...EMAIL_CHANNEL_SPEC,
    coverageBlockers(input: ChannelCoverageInput): string[] {
      const reasons = EMAIL_CHANNEL_SPEC.coverageBlockers(input);
      if (!wakeDoorbellEnabled("email", deps.env ?? process.env)) reasons.push("doorbell_off");
      return reasons;
    },
    async armBeforeSleep(ctx) {
      const result = await armEmailDoorbell(ctx, deps);
      if (!result.ok) return { ok: false, reason: result.reason };
      // Never a secret: the baseline, and the vmid it was taken for.
      return { ok: true, armData: { vmid: ctx.target?.vmid, uidvalidity: result.uidvalidity, uidnext: result.uidnext, idle: result.idle } };
    },
    /** Each arm replaces the last one for the same computer on the doorbell, so nothing can be left over. */
    async verifyClear() {
      return true;
    },
    disarmForWake: (ctx) => disarmEmailDoorbell(ctx, deps),
    async release(ctx) {
      await disarmEmailDoorbell(ctx, deps);
    },
  };
}

export const EMAIL_IMAP_ADAPTER: ChannelWakeAdapter = createEmailImapAdapter();
