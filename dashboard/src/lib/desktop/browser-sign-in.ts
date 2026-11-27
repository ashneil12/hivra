import crypto from "node:crypto";

export { desktopBrowserSignInEnabled } from "./browser-sign-in-enabled";

/**
 * Browser sign-in for the desktop app.
 *
 * Google and some other sign-in providers refuse to run inside an app's
 * embedded web view, so the desktop app signs people in through their normal
 * browser and is handed the session back:
 *
 *   1. The app makes a random `verifier`, keeps it in memory, and opens
 *      /desktop/sign-in?challenge=<sha256(verifier)>&state=<random> in the
 *      default browser.
 *   2. The person signs in there as usual. The page then sends the browser to
 *      hivra://auth/callback?code=<code>&state=<state>.
 *   3. The app checks `state`, then POSTs { code, verifier } to
 *      /api/desktop/session. The server checks the code and that
 *      sha256(verifier) matches the challenge sealed inside it, and answers
 *      with a short-lived, single-use Clerk sign-in ticket.
 *   4. The app opens /desktop/finish?ticket=<ticket> in its own web view,
 *      which turns the ticket into a session there.
 *
 * Another app that registers the hivra:// scheme could see the code, but
 * without the verifier (which never leaves the desktop app's memory) the code
 * is useless. The code is sealed (AES-256-GCM) so the account id inside it is
 * not readable in the browser's history, and it expires after two minutes.
 *
 * Off unless HIVRA_DESKTOP_BROWSER_SIGNIN is on.
 */

export const HANDOFF_TTL_SECONDS = 120;
/** How long the Clerk ticket the app receives stays usable. */
export const TICKET_TTL_SECONDS = 120;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KEY_INFO = "hivra-desktop-browser-sign-in-v1";

/** A base64url SHA-256 digest: exactly 43 characters. */
export function isValidChallenge(value: unknown): value is string {
  return typeof value === "string" && value.length === 43 && BASE64URL.test(value);
}

/** The app's random state, echoed back so it can refuse callbacks it did not start. */
export function isValidState(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && BASE64URL.test(value);
}

/** RFC 7636 verifier length and alphabet (base64url subset is enough here). */
export function isValidVerifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 43 && value.length <= 128 && BASE64URL.test(value);
}

export function challengeFor(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function sealingKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), KEY_INFO, 32));
}

/** The server secret the code is sealed with. Clerk's secret key is always set where sign-in works. */
export function handoffSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.CLERK_SECRET_KEY?.trim();
  return secret ? secret : null;
}

type SealedPayload = { v: 1; u: string; c: string; e: number };

export function createHandoffCode(input: {
  userId: string;
  challenge: string;
  secret: string;
  nowMs?: number;
}): string {
  const nowMs = input.nowMs ?? Date.now();
  const payload: SealedPayload = {
    v: 1,
    u: input.userId,
    c: input.challenge,
    e: Math.floor(nowMs / 1000) + HANDOFF_TTL_SECONDS,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealingKey(input.secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

export type RedeemResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "malformed" | "expired" | "verifier_mismatch" };

export function redeemHandoffCode(input: {
  code: string;
  verifier: string;
  secret: string;
  nowMs?: number;
}): RedeemResult {
  if (typeof input.code !== "string" || input.code.length > 1024 || !BASE64URL.test(input.code)) {
    return { ok: false, reason: "malformed" };
  }
  const raw = Buffer.from(input.code, "base64url");
  if (raw.length < 12 + 16 + 2) return { ok: false, reason: "malformed" };
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(12, raw.length - 16);
  let payload: SealedPayload;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealingKey(input.secret), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    payload = JSON.parse(text) as SealedPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload?.v !== 1 || typeof payload.u !== "string" || !isValidChallenge(payload.c) || typeof payload.e !== "number") {
    return { ok: false, reason: "malformed" };
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (nowSeconds > payload.e) return { ok: false, reason: "expired" };
  if (!isValidVerifier(input.verifier)) return { ok: false, reason: "verifier_mismatch" };
  const expected = Buffer.from(payload.c, "utf8");
  const actual = Buffer.from(challengeFor(input.verifier), "utf8");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "verifier_mismatch" };
  }
  return { ok: true, userId: payload.u };
}

/** The address the browser is sent to so the desktop app picks the sign-in up. */
export function desktopCallbackUrl(code: string, state: string): string {
  const params = new URLSearchParams({ code, state });
  return `hivra://auth/callback?${params.toString()}`;
}
