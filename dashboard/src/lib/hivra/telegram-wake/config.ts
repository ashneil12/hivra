// Switches and small derivations for Telegram wake-on-message. Pure apart from
// node:crypto, and nothing here talks to the network or the database.
//
// Three server settings, all needed, or the feature is off:
//   HIVRA_TELEGRAM_WAKE           off (default), canary or on
//   HIVRA_TELEGRAM_WAKE_SECRET    the key every per-agent webhook secret is derived from
//   HIVRA_TELEGRAM_WAKE_BASE_URL  the public https address of the webhook route; the
//                                 agent id is added to it. Never written into the code.
//
// canary: only agents whose owner opted in, on hosts whose sleep_mode is canary
// or on. on: every agent whose owner opted in. Either way the owner's opt-in is
// required.

import { createHmac } from "node:crypto";

export type TelegramWakeMode = "off" | "canary" | "on";

export interface TelegramWakeConfig {
  mode: "canary" | "on";
  secret: string;
  /** Without a trailing slash. */
  baseUrl: string;
}

/** A secret shorter than this is treated as missing. */
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTelegramWakeMode(value: string | undefined | null): TelegramWakeMode {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "canary" || mode === "on" ? mode : "off";
}

/** The base URL, or null unless it is a plain https address with no credentials, query or fragment. */
export function parseTelegramWakeBaseUrl(value: string | undefined | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function secretFrom(env: Record<string, string | undefined>): string | null {
  const secret = String(env.HIVRA_TELEGRAM_WAKE_SECRET ?? "").trim();
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/** The full config, or null when the feature is off or any setting is missing. */
export function resolveTelegramWakeConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramWakeConfig | null {
  const mode = parseTelegramWakeMode(env.HIVRA_TELEGRAM_WAKE);
  if (mode === "off") return null;
  const secret = secretFrom(env);
  const baseUrl = parseTelegramWakeBaseUrl(env.HIVRA_TELEGRAM_WAKE_BASE_URL);
  if (!secret || !baseUrl) return null;
  return { mode, secret, baseUrl };
}

/**
 * Whether the clean-up side runs: deleting webhooks that should not be set any
 * more. It needs only the secret to have been configured, so turning the mode
 * back to off still drains every row to idle. With nothing configured it does
 * nothing at all, so a server that never used the feature behaves as before.
 */
export function telegramWakeCleanupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return secretFrom(env) !== null;
}

/** The key webhook secrets are derived from, whenever it is configured (the mode may be off while rows drain). */
export function telegramWakeSecret(env: Record<string, string | undefined> = process.env): string | null {
  return secretFrom(env);
}

/** Whether a host's own sleep switch lets this mode act there. */
export function telegramWakeHostAllowed(config: TelegramWakeConfig, hostSleepMode: unknown): boolean {
  if (config.mode === "on") return true;
  return hostSleepMode === "canary" || hostSleepMode === "on";
}

/** The webhook address for one agent. */
export function telegramWakeWebhookUrl(config: Pick<TelegramWakeConfig, "baseUrl">, agentId: string): string {
  if (!UUID.test(agentId)) throw new Error("Invalid agent id.");
  return `${config.baseUrl}/${agentId.toLowerCase()}`;
}

/**
 * The secret_token Telegram sends back on every call for one arm. It changes
 * with every arm, so a webhook from an earlier arm stops being accepted.
 * Hex, 64 characters: inside Telegram's 1-256 character [A-Za-z0-9_-] rule.
 */
export function telegramWakeSecretToken(secret: string, agentId: string, armId: string): string {
  return createHmac("sha256", secret).update(`${agentId.toLowerCase()}:${armId.toLowerCase()}`).digest("hex").slice(0, 64);
}

export function isAgentUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
