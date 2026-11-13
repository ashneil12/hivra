// The shape every channel wake adapter has. Pure types, no imports with side
// effects, so the sleep scripts (which must stay pure) can read the specs.
//
// One rule for every adapter: an agent may sleep only if every live channel
// the idle probe reports is covered by an adapter that is armed, or that can
// arm itself before a message would be lost. Anything unknown stays awake.
//
// Telegram has its own table and its own switches (telegram-wake/*). It is
// described here by a spec so the gates can name it, but its runtime side is
// the telegram-wake module, unchanged. Every other channel keeps its state in
// hivra_agent_channel_wake (channel-wake/store.ts).

import type { ChannelWakeChannel } from "./config";
import type { ChannelProbeFacts } from "@/lib/hivra/sleep/idle-probe-program";

/** How an adapter learns that a message arrived while the agent sleeps. */
export type ChannelWakeDetector = "server-push" | "server-poll" | "ingress" | "host-doorbell";

/**
 * How the agent gets the messages that arrived while it slept: by itself
 * (native), only with a Hermes setting turned on, or not at all.
 */
export type ChannelWakeCatchUp = "native" | `needs-config:${string}` | "none";

/** The parts of a stored row that coverage reads. */
export interface ChannelWakeRowFacts {
  enabled: boolean;
  /** First 16 hex of the sha256 of the channel credential, taken at opt-in. */
  credFp: string | null;
  blockedUntil: string | null;
}

/** What the probe said about one channel: the credential fingerprint and its facts. Never a secret. */
export interface ChannelWakeProbeView {
  liveChannels: readonly string[];
  /** Fingerprints per channel, present only when the probe was asked for them. */
  channelFps?: Partial<Record<ChannelWakeChannel, string | null>>;
  channelFacts?: ChannelProbeFacts;
}

export interface ChannelCoverageInput {
  /** The channel wake switches let this channel act for this agent on this host. */
  acts: boolean;
  row: ChannelWakeRowFacts | null;
  probe: ChannelWakeProbeView | null;
  nowMs: number;
}

/**
 * The pure half of an adapter: what both gates (the server and the host)
 * need to know. Lives in registry.ts.
 */
export interface ChannelWakeSpec {
  channel: ChannelWakeChannel;
  /** The tag the idle probe reports while this channel is live, e.g. "hermes:email". */
  probeTag: string;
  detector: ChannelWakeDetector;
  catchUp: ChannelWakeCatchUp;
  /** The server must take something down before the computer runs again (Telegram's webhook). */
  needsServerDisarm: boolean;
  /** Hermes holds a long-lived socket for this channel, which is dead after a resume. */
  socketBased: boolean;
  /**
   * ~/.hermes/.env keys whose values identify the credential. The probe
   * prints the first 16 hex of the sha256 of their values joined by a
   * newline, never the values.
   */
  credKeys: readonly string[];
  /** Every reason this channel is not covered. Empty means covered. Pure. */
  coverageBlockers(input: ChannelCoverageInput): string[];
  /**
   * Extra host-side condition, a Perl boolean expression. It may read $f (this
   * channel's probe facts, a hash ref or undef). The generated gate already
   * checks the fingerprint. "1" when there is nothing more to check.
   */
  hostFactsPerl: string;
}

/** The host target an adapter may need to arm through the host (a doorbell). */
export interface ChannelWakeTargetRef {
  vmid: number;
  bindingTag: string | null;
  /** Opaque host connection handle, passed through to the host script runner. */
  env: unknown;
}

export interface ChannelWakeAdapterContext {
  agentId: string;
  channel: ChannelWakeChannel;
  /** Changes with every arm; per-arm secrets derive from it. */
  armId: string;
  /** What the last arm stored (a mailbox baseline, a pushkey id). Never secrets. */
  armData: Record<string, unknown>;
  /** Set on the sleep path only. */
  target?: ChannelWakeTargetRef;
}

export type ChannelArmResult =
  | { ok: true; armData?: Record<string, unknown> }
  | { ok: false; reason: string; retryAfterMs?: number };

/**
 * The full adapter: the spec plus the runtime steps. Every step must time
 * itself out; the framework also time-boxes each one.
 */
export interface ChannelWakeAdapter extends ChannelWakeSpec {
  /** Runs in the sleep flow, before the lease and the stop. A failure keeps the agent awake. */
  armBeforeSleep?(ctx: ChannelWakeAdapterContext): Promise<ChannelArmResult>;
  /** Runs from the sweep once the agent has slept a while. Only safe where the sender queues (Telegram). */
  armLater?(ctx: ChannelWakeAdapterContext): Promise<ChannelArmResult>;
  /** Runs after wake admission and before the computer resumes. Never blocks the wake. */
  disarmForWake(ctx: ChannelWakeAdapterContext): Promise<{ ok: boolean; reason?: string }>;
  /** Before a sleep: nothing left over from an earlier arm. False keeps the agent awake. */
  verifyClear(ctx: ChannelWakeAdapterContext): Promise<boolean>;
  /** Opt-out or agent delete: undo everything this adapter set up. Never throws. */
  release(ctx: ChannelWakeAdapterContext): Promise<void>;
}
