// Switches and small derivations for channel wake: waking a sleeping agent
// when a message arrives on one of its channels. Generalises Telegram wake,
// whose own switches (HIVRA_TELEGRAM_WAKE*) stay as they are. Pure apart from
// node:crypto; nothing here talks to the network or the database.
//
// All needed, or the feature is off:
//   HIVRA_CHANNEL_WAKE           off (default), canary or on
//   HIVRA_CHANNEL_WAKE_CHANNELS  comma-separated list of channels that may act;
//                                empty means none, unknown names are ignored
//   HIVRA_CHANNEL_WAKE_SECRET    at least 32 characters; per-arm secrets are
//                                derived from it. Shorter or unset means off.
// Optional:
//   HIVRA_CHANNEL_WAKE_BASE_URL  the public https address of the webhook routes,
//                                for channels that call Hivra. Never in the code.
//
// canary: only agents whose owner opted in, on hosts whose sleep_mode is canary
// or on. on: every agent whose owner opted in. Either way the owner's opt-in
// (an enabled row) is required.

import { createHmac } from "node:crypto";

import { parseTelegramWakeBaseUrl } from "@/lib/hivra/telegram-wake/config";

export type ChannelWakeMode = "off" | "canary" | "on";

/**
 * Every channel name this code knows. Telegram is here so the framework can
 * name it, but its own switches still decide whether it acts.
 */
export const CHANNEL_WAKE_CHANNEL_NAMES = [
  "telegram", "email", "matrix", "whatsapp_cloud", "discord", "slack",
] as const;

export type ChannelWakeChannel = (typeof CHANNEL_WAKE_CHANNEL_NAMES)[number];

export interface ChannelWakeConfig {
  mode: "canary" | "on";
  secret: string;
  /** Never empty. */
  channels: ReadonlySet<ChannelWakeChannel>;
  /** Without a trailing slash, or null when not set or not a plain https address. */
  baseUrl: string | null;
}

/** The opt-in row for one agent and channel, as far as the switches care. */
export interface ChannelWakeRow {
  enabled?: unknown;
}

/** The agent's host row, as far as the switches care. */
export interface ChannelWakeHostRow {
  sleep_mode?: unknown;
}

type Env = Record<string, string | undefined>;

/** A secret shorter than this is treated as missing. */
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChannelWakeChannel(value: unknown): value is ChannelWakeChannel {
  return typeof value === "string" && (CHANNEL_WAKE_CHANNEL_NAMES as readonly string[]).includes(value);
}

export function parseChannelWakeMode(value: string | undefined | null): ChannelWakeMode {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "canary" || mode === "on" ? mode : "off";
}

/** The known channels a list names. Unknown names are dropped. */
export function parseChannelWakeChannels(value: string | undefined | null): ReadonlySet<ChannelWakeChannel> {
  const names = String(value ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  return new Set(CHANNEL_WAKE_CHANNEL_NAMES.filter((channel) => names.includes(channel)));
}

function secretFrom(env: Env): string | null {
  const secret = String(env.HIVRA_CHANNEL_WAKE_SECRET ?? "").trim();
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/** The full config, or null when the feature is off, the secret is missing or short, or no known channel is listed. */
export function resolveChannelWakeConfig(env: Env = process.env): ChannelWakeConfig | null {
  const mode = parseChannelWakeMode(env.HIVRA_CHANNEL_WAKE);
  if (mode === "off") return null;
  const secret = secretFrom(env);
  if (!secret) return null;
  const channels = parseChannelWakeChannels(env.HIVRA_CHANNEL_WAKE_CHANNELS);
  if (channels.size === 0) return null;
  return { mode, secret, channels, baseUrl: parseTelegramWakeBaseUrl(env.HIVRA_CHANNEL_WAKE_BASE_URL) };
}

/**
 * Whether the clean-up side runs: undoing arms that should not be set any
 * more. It needs only the secret, so turning the mode back to off (or taking a
 * channel off the list) still drains every row to idle. With nothing
 * configured it does nothing, so a server that never used the feature behaves
 * as before.
 */
export function channelWakeCleanupEnabled(env: Env = process.env): boolean {
  return secretFrom(env) !== null;
}

/** The key per-arm secrets are derived from, whenever it is configured (the mode may be off while rows drain). */
export function channelWakeSecret(env: Env = process.env): string | null {
  return secretFrom(env);
}

/** Whether a host's own sleep switch lets this mode act there. */
export function channelWakeHostAllowed(config: Pick<ChannelWakeConfig, "mode">, hostSleepMode: unknown): boolean {
  if (config.mode === "on") return true;
  return hostSleepMode === "canary" || hostSleepMode === "on";
}

/**
 * Whether channel wake may act for one agent on one channel: the feature is
 * configured, the channel is known and listed, the owner opted in (enabled is
 * exactly true), and the host allows the mode. Pass a config or an env.
 */
export function channelWakeActsFor(
  channel: unknown,
  row: ChannelWakeRow | null | undefined,
  host: ChannelWakeHostRow | null | undefined,
  source: ChannelWakeConfig | Env | null = process.env,
): boolean {
  const config = source && isConfig(source) ? source : resolveChannelWakeConfig((source ?? {}) as Env);
  if (!config) return false;
  if (!isChannelWakeChannel(channel) || !config.channels.has(channel)) return false;
  if (!row || row.enabled !== true) return false;
  return channelWakeHostAllowed(config, host?.sleep_mode);
}

function isConfig(value: ChannelWakeConfig | Env): value is ChannelWakeConfig {
  return typeof (value as ChannelWakeConfig).channels === "object" && (value as ChannelWakeConfig).channels instanceof Set;
}

/**
 * A secret for one arm of one channel (a webhook secret, a pushkey). It
 * changes with every arm, so an earlier arm's secret stops being accepted, and
 * the channel name keeps one channel's secret from being used on another.
 * Hex, 64 characters.
 */
export function channelWakeArmSecret(secret: string, channel: ChannelWakeChannel, agentId: string, armId: string): string {
  if (!isChannelWakeChannel(channel)) throw new Error("Unknown channel.");
  if (!UUID.test(agentId) || !UUID.test(armId)) throw new Error("Invalid id.");
  return createHmac("sha256", secret)
    .update(`hivra-channel-wake:v1:${channel}:${agentId.toLowerCase()}:${armId.toLowerCase()}`)
    .digest("hex");
}
