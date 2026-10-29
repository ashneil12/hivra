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

// `inUrlField` is true for everything under a key named url, at any depth, so a
// url sent as a string, an array or an object is logged the same way.
function redactValue(value: unknown, inUrlField: boolean): unknown {
  if (typeof value === "string") return inUrlField ? logSafeUrl(value) : value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, inUrlField));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? "[REDACTED]" : redactValue(v, inUrlField || k.toLowerCase() === "url");
  }
  return out;
}

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
// link) in its query or fragment, so the log keeps the scheme, host and path only.
function logSafeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "[REDACTED]";
  }
}

export type Logger = ReturnType<typeof buildLogger>;
