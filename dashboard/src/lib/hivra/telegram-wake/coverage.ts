// Which live chat channels a Telegram wake covers for one agent: the channels
// that may stay connected while the agent sleeps, because a message on them
// wakes it. Pure, no imports with side effects, so the sleep scripts and the
// tests use the same rules.
//
// Phase 1 covers exactly one case: a Hermes agent reading Telegram by polling,
// with its token in ~/.hermes/.env, and no other live channel. Anything else,
// or anything unknown, covers nothing, and the agent stays awake as before.
//
// The host gate in the sleep script (agent-sleep-scripts.ts) checks the same
// probe facts against the same list, so the two answers agree.

/** The only channels a wake can ever cover. Both gates refuse anything else. */
export const TELEGRAM_WAKE_COVERABLE_CHANNELS: readonly string[] = ["hermes:telegram"];

/** What the idle probe reports about Hermes' Telegram setup. Never the token. */
export interface TelegramProbeFacts {
  /** First 16 hex of the sha256 of the .env token, or null when there is none. */
  hermesFp: string | null;
  hermesTokenInEnv: boolean;
  /** TELEGRAM_WEBHOOK_URL is set, so Hermes runs its own webhook. */
  hermesWebhookMode: boolean;
  /** config.yaml has a Telegram token of its own, which the fingerprint cannot vouch for. */
  hermesConfigToken: boolean;
}

/** The parts of the stored row that coverage reads. */
export interface TelegramWakeRowFacts {
  enabled: boolean;
  tokenFp: string | null;
  hasToken: boolean;
  blockedUntil: string | null;
}

export interface TelegramCoverageInput {
  /** The server switch is fully configured (mode canary or on, secret and base URL set). */
  configured: boolean;
  /** The host's sleep switch lets the mode act there. */
  hostAllowed: boolean;
  row: TelegramWakeRowFacts | null;
  probe: { liveChannels: readonly string[]; telegram?: TelegramProbeFacts | null } | null;
  nowMs: number;
}

const FINGERPRINT = /^[0-9a-f]{16}$/;

/** Every reason the agent's Telegram is not covered. Empty means covered. */
export function telegramCoverageBlockers(input: TelegramCoverageInput): string[] {
  const reasons: string[] = [];
  if (!input.configured) reasons.push("not_configured");
  if (!input.hostAllowed) reasons.push("host_not_allowed");
  const row = input.row;
  if (!row || row.enabled !== true) reasons.push("not_opted_in");
  else {
    if (!row.hasToken || !row.tokenFp || !FINGERPRINT.test(row.tokenFp)) reasons.push("no_token");
    if (row.blockedUntil) {
      const until = Date.parse(row.blockedUntil);
      if (!Number.isFinite(until) || until > input.nowMs) reasons.push("blocked");
    }
  }
  const probe = input.probe;
  if (!probe) {
    reasons.push("no_probe");
    return reasons;
  }
  const channels = probe.liveChannels;
  if (channels.length === 0) reasons.push("no_live_channel");
  if (channels.some((channel) => !TELEGRAM_WAKE_COVERABLE_CHANNELS.includes(channel))) reasons.push("other_channel");
  const tg = probe.telegram;
  if (!tg) reasons.push("no_telegram_facts");
  else {
    if (!tg.hermesTokenInEnv || !tg.hermesFp) reasons.push("token_not_in_env");
    else if (!row?.tokenFp || tg.hermesFp !== row.tokenFp) reasons.push("token_changed");
    if (tg.hermesWebhookMode) reasons.push("hermes_webhook_mode");
    if (tg.hermesConfigToken) reasons.push("token_in_config");
  }
  return reasons;
}

/** The channels the wake covers: ["hermes:telegram"] when every condition holds, else none. */
export function telegramWakeCoverage(input: TelegramCoverageInput): string[] {
  return telegramCoverageBlockers(input).length === 0 ? [...input.probe!.liveChannels] : [];
}

/** Keeps only names on the allowlist, once each. */
export function allowedCoveredChannels(channels: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const channel of channels ?? []) {
    if (typeof channel === "string" && TELEGRAM_WAKE_COVERABLE_CHANNELS.includes(channel) && !out.includes(channel)) out.push(channel);
  }
  return out;
}
