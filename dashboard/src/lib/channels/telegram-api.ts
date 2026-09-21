// Client-side helpers for the Telegram Bot API.
//
// api.telegram.org is CORS-open, so these run straight from the browser. The
// unified <TelegramConnect> flow uses them to validate a freshly-pasted
// BotFather token and read the bot's @username, then hands off to the per-lane
// adapter's native pairing flow:
//   - Hermes (gateway): bot DMs the owner an 8-char one-time code; owner pastes
//     the code into the dashboard, which calls `hermes pairing approve` in the
//     runtime container.
//   - Hivra (bux): dashboard renders a `t.me/<bot>?start=<setup-token>` deep
//     link; the first chat to redeem the deeplink binds as owner and the token
//     burns single-use.
//
// Both bypass the brittle `getUpdates` long-poll auto-capture this module used
// to ship — that path is gone. A manual-id fallback still exists in the UI for
// pre-pairing-runtime version skew (writes TELEGRAM_ALLOWED_USERS / TG_OWNER_ID
// directly), gated behind an "advanced" disclosure.

const TELEGRAM_BOT_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_OWNER_ID_RE = /^\d{3,}$/;

export function isValidBotTokenShape(token: string): boolean {
  return TELEGRAM_BOT_TOKEN_RE.test((token ?? "").trim());
}

export function isValidOwnerIdShape(id: string): boolean {
  return TELEGRAM_OWNER_ID_RE.test((id ?? "").trim());
}

const TELEGRAM_API = "https://api.telegram.org";
// Bound the getMe request. api.telegram.org is blocked/blackholed on many
// networks (regional filters, corporate proxies, some mobile carriers) where a
// bare fetch neither resolves nor rejects — it just hangs. Left unbounded, that
// hangs the connect flow's CONTINUE spinner indefinitely with no error banner
// (the exact "times out" symptom). It also runs server-side inside the
// integrations POST function; unbounded there it can burn the whole Vercel
// budget and 504. AbortSignal.timeout rejects with a TimeoutError the catch
// below turns into a friendly, retryable message on both sides.
const TELEGRAM_GETME_TIMEOUT_MS = 8000;

type FetchLike = typeof fetch;

interface TgEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramBotInfo {
  ok: boolean;
  username: string | null;
  botId: number | null;
  /** Set when ok === false — a user-facing reason. */
  error: string | null;
}

// Verify a bot token and read its @username. A green getMe is what lets us show
// the "Open @yourbot" deep link before the user has connected anything.
export async function telegramGetMe(botToken: string, fetchImpl: FetchLike = fetch): Promise<TelegramBotInfo> {
  const token = (botToken ?? "").trim();
  if (!isValidBotTokenShape(token)) {
    return {
      ok: false,
      username: null,
      botId: null,
      error: "That doesn't look like a bot token. Copy the whole token BotFather gave you (it looks like 123456789:ABC…).",
    };
  }
  try {
    const r = await fetchImpl(`${TELEGRAM_API}/bot${token}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(TELEGRAM_GETME_TIMEOUT_MS),
    });
    const j = (await r.json().catch(() => ({}))) as TgEnvelope<{ id: number; username?: string }>;
    if (!r.ok || !j.ok || !j.result) {
      return {
        ok: false,
        username: null,
        botId: null,
        error: j.description || "Telegram rejected that token. Double-check you copied it correctly.",
      };
    }
    return { ok: true, username: j.result.username || null, botId: j.result.id ?? null, error: null };
  } catch {
    return {
      ok: false,
      username: null,
      botId: null,
      error: "Couldn't reach Telegram to verify the token. Check your connection and try again.",
    };
  }
}

/** The deep link that, when opened and Started, sends `/start <payload>` from
 *  the owner — used by the Hivra-lane bux setup-token bind. */
export function telegramStartLink(username: string, payload = "connect"): string {
  return `https://t.me/${username}?start=${encodeURIComponent(payload)}`;
}
