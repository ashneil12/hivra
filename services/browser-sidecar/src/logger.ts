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
  "config.SIGNING_SECRET",
  "config.IMAP_PASS",
  "config.IMAP_USER",
  "config.CLERK_PASSWORD",
  "config.CLERK_EMAIL",
  "config.TIER_CHECK_TOKEN",
];

export function buildLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">) {
  const isDev = config.NODE_ENV === "development";
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    transport: isDev
      ? { target: "pino-pretty", options: { colorize: true, singleLine: false } }
      : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

// Best-effort redaction for tool-call args before they hit the request log.
// Pino paths cover known field names; this catches `fill { value }` payloads that
// might contain a password the caller was inattentive about.
export function redactArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (
      lower.includes("password") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("auth") ||
      lower === "value" // /fill {selector, value} could be a password
    ) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = redactArgs(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export type Logger = ReturnType<typeof buildLogger>;
