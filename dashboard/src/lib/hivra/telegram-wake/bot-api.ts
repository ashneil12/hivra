// The only place the server calls the Telegram Bot API for wake-on-message.
//
// The bot token sits in the request path, so neither the URL nor the token is
// ever logged, thrown or returned: every answer is reduced to a short code.
// Telegram's own error text is dropped too. Every call has a time limit, and
// a 429 says how long to wait (retry_after) so the caller can honour it.
//
// fetch is injectable so the tests never touch the network.

import { createHash } from "node:crypto";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
/** An answer bigger than this is not one of ours. */
const MAX_ANSWER_BYTES = 64 * 1024;

export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;

export type TelegramCallReason =
  | "ok"
  | "bad_token"
  | "timeout"
  | "network"
  | "rate_limited"
  | "unauthorized"
  | "rejected"
  | "bad_response";

export interface TelegramCallResult<T> {
  ok: boolean;
  reason: TelegramCallReason;
  /** The HTTP status, or 0 when there was no answer. */
  status: number;
  result?: T;
  /** Seconds to wait, from a 429. */
  retryAfterS?: number;
}

export interface TelegramCallOptions {
  fetchImpl?: TelegramFetch;
  timeoutMs?: number;
}

export function isTelegramBotTokenShape(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

/** A short, non-reversible fingerprint of a token: the first 16 hex characters of its sha256. */
export function telegramTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 16);
}

async function readAnswer(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (text.length > MAX_ANSWER_BYTES) return null;
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function retryAfter(answer: Record<string, unknown> | null): number | undefined {
  const parameters = answer?.parameters;
  if (!parameters || typeof parameters !== "object") return undefined;
  const seconds = (parameters as Record<string, unknown>).retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? Math.min(3_600, Math.ceil(seconds)) : undefined;
}

/** One Bot API call. Never throws. */
export async function callTelegram<T>(
  token: string,
  method: string,
  params: Record<string, unknown>,
  options: TelegramCallOptions = {},
): Promise<TelegramCallResult<T>> {
  if (!isTelegramBotTokenShape(token)) return { ok: false, reason: "bad_token", status: 0 };
  if (!/^[A-Za-z]{1,40}$/.test(method)) return { ok: false, reason: "rejected", status: 0 };
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", status: 0 };
  }
  const answer = await readAnswer(response);
  if (response.status === 429) {
    const wait = retryAfter(answer);
    return { ok: false, reason: "rate_limited", status: 429, ...(wait !== undefined ? { retryAfterS: wait } : {}) };
  }
  if (response.status === 401 || response.status === 404) return { ok: false, reason: "unauthorized", status: response.status };
  if (!answer) return { ok: false, reason: "bad_response", status: response.status };
  if (!response.ok || answer.ok !== true) return { ok: false, reason: "rejected", status: response.status };
  return { ok: true, reason: "ok", status: response.status, result: answer.result as T };
}

export interface TelegramBotIdentity {
  id: number;
}

/** getMe: the bot's numeric id, which proves the token works. */
export async function telegramGetBot(token: string, options?: TelegramCallOptions): Promise<TelegramCallResult<TelegramBotIdentity>> {
  const result = await callTelegram<Record<string, unknown>>(token, "getMe", {}, options);
  if (!result.ok) return { ok: false, reason: result.reason, status: result.status, ...(result.retryAfterS !== undefined ? { retryAfterS: result.retryAfterS } : {}) };
  const id = result.result?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: "bad_response", status: result.status };
  return { ok: true, reason: "ok", status: result.status, result: { id } };
}

export interface TelegramWebhookState {
  /** The webhook address, or "" when the bot is read by polling. */
  url: string;
  pendingUpdates: number;
}

/** getWebhookInfo, reduced to the address and the number of queued updates. */
export async function telegramGetWebhook(token: string, options?: TelegramCallOptions): Promise<TelegramCallResult<TelegramWebhookState>> {
  const result = await callTelegram<Record<string, unknown>>(token, "getWebhookInfo", {}, options);
  if (!result.ok) return { ok: false, reason: result.reason, status: result.status, ...(result.retryAfterS !== undefined ? { retryAfterS: result.retryAfterS } : {}) };
  const url = result.result?.url;
  if (typeof url !== "string") return { ok: false, reason: "bad_response", status: result.status };
  const pending = result.result?.pending_update_count;
  return {
    ok: true,
    reason: "ok",
    status: result.status,
    result: { url, pendingUpdates: typeof pending === "number" && Number.isSafeInteger(pending) && pending >= 0 ? pending : 0 },
  };
}

/**
 * setWebhook for a wake: one connection at a time, and neither allowed_updates
 * nor drop_pending_updates, so the bot's own update filter and queue stay as
 * Hermes left them.
 */
export async function telegramSetWakeWebhook(
  token: string,
  input: { url: string; secretToken: string },
  options?: TelegramCallOptions,
): Promise<TelegramCallResult<true>> {
  const result = await callTelegram<unknown>(token, "setWebhook", {
    url: input.url,
    secret_token: input.secretToken,
    max_connections: 1,
  }, options);
  return result.ok ? { ok: true, reason: "ok", status: result.status, result: true } : { ...result, result: undefined };
}

/** deleteWebhook, keeping every queued update for the bot's own polling. */
export async function telegramDeleteWebhook(token: string, options?: TelegramCallOptions): Promise<TelegramCallResult<true>> {
  const result = await callTelegram<unknown>(token, "deleteWebhook", { drop_pending_updates: false }, options);
  return result.ok ? { ok: true, reason: "ok", status: result.status, result: true } : { ...result, result: undefined };
}
