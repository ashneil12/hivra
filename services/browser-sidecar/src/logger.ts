import pino from "pino";
import type { Config } from "./config.js";

// SCRIPTURE_ANCHOR: log-light | Ephesians 5:13 | Verse: All things, when they are reproved, are revealed by the light.

// Redaction paths. Pino replaces these with "[REDACTED]" in log output.
// Be aggressive — over-redacting is a non-issue, leaking a credential once is.
const REDACT_PATHS = [
  "*.password",
  "*.pass",
  "*.secret",
  "*.token",
  "*.signing_secret",
  "*.signingSecret",
  "*.imap_pass",
  "*.clerk_password",
  "*.authorization",
  "*.cookie",
  "*.set-cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "args.value",
  "args.password",
  "args.email",
  "args.file", // /cookies/import: the user's whole session export
  "config.SIGNING_SECRET",
  "config.IMAP_PASS",
  "config.IMAP_USER",
  "config.CLERK_PASSWORD",
  "config.CLERK_EMAIL",
  "config.TIER_CHECK_TOKEN",
];

// `destination` defaults to stdout; tests pass a stream to capture what is logged.
export function buildLogger(
  config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">,
  destination?: pino.DestinationStream,
) {
  const isDev = config.NODE_ENV === "development";
  const options = {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    transport: isDev
      ? { target: "pino-pretty", options: { colorize: true, singleLine: false } }
      : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

// Best-effort redaction for tool-call args before they hit the request log.
// Pino paths cover known field names; this catches `fill { value }` payloads that
// might contain a password the caller was inattentive about.
export function redactArgs(args: unknown): unknown {
  return redactValue(args, false);
}

// `inUrlField` is true for everything under a key that ends in "url" (url,
// login_url, ...), at any depth, so a url sent as a string, an array or an
// object is logged the same way. A string that is a whole absolute http(s) url
// is logged that way under any key, because a url can be passed under any
// name (for example in flow args).
function redactValue(value: unknown, inUrlField: boolean): unknown {
  if (typeof value === "string") {
    return inUrlField || HTTP_URL.test(value) ? logSafeUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, inUrlField));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? "[REDACTED]" : redactValue(v, inUrlField || /url$/i.test(k));
  }
  return out;
}

const HTTP_URL = /^https?:\/\//i;

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("auth") ||
    lower.includes("cookie") ||
    lower.includes("storagestate") ||
    lower === "value" || // /fill {selector, value} could be a password
    lower === "file" // /cookies/import {file} is the user's whole session export
  );
}

// A url in a request body can carry a one-time token (a sign-in ticket or magic
// link) in its query or fragment, so the log keeps only the scheme, host and
// path. A token written into the path itself is still logged, so one-time
// links belong in the query. An opaque url such as "magic:TOKEN" has no host
// and its whole value sits in the path, so it is not logged at all.
function logSafeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (!u.host) return "[REDACTED]";
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "[REDACTED]";
  }
}

// The route a request matched, or for a request that matched none, its path
// without the query string. A one-time token sent in a query is never logged
// through a route label.
export function routeLabel(req: { url: string; routeOptions: { url?: string } }): string {
  return req.routeOptions.url ?? req.url.split("?")[0];
}

export type Logger = ReturnType<typeof buildLogger>;
