import { z } from "zod";

// SCRIPTURE_ANCHOR: config-measure | Proverbs 24:3 | Verse: Through wisdom a house is built; by understanding it is established.
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8789),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["production", "development", "test"]).default("production"),

  PROFILES_DIR: z.string().default("/var/lib/hermes-browser/profiles"),
  FLOWS_DIR: z.string().default("/var/lib/hermes-browser/flows"),
  SCREENSHOTS_DIR: z.string().default("/var/lib/hermes-browser/screenshots"),

  SIGNING_SECRET: z.string().min(16, "SIGNING_SECRET must be at least 16 chars"),

  // Bearer token required on every tool route (/goto, /click_text, etc).
  // Optional during fleet migration: when unset, the preHandler logs a
  // warning per request but does not 401, so existing VMs whose agent
  // sidecar client hasn't been updated yet keep working. Provisioning
  // seeds this for new VMs; once every VM has it, the warn path can be
  // removed and the field becomes required.
  SIDECAR_AUTH_TOKEN: z
    .string()
    .min(16, "SIDECAR_AUTH_TOKEN must be at least 16 chars")
    .optional(),

  TIER_CHECK_URL: z.string().url().optional(),
  TIER_CHECK_INSTANCE_ID: z.string().optional(),
  TIER_CHECK_TOKEN: z.string().optional(),

  CLERK_EMAIL: z.string().optional(),
  CLERK_PASSWORD: z.string().optional(),
  CLERK_LOGIN_URL: z.string().url().optional(),
  CLERK_POST_LOGIN_PATH: z.string().default("/dashboard"),

  IMAP_HOST: z.string().optional(),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().optional(),
  IMAP_PASS: z.string().optional(),
  IMAP_TLS: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  IMAP_MAILBOX: z.string().default("INBOX"),
  IMAP_CODE_SUBJECT_PATTERN: z.string().default("(verification|sign-in|login)\\s+code|verify\\s+your\\s+email"),

  NOVNC_INTERNAL_PORT: z.coerce.number().int().positive().default(6080),
  DISPLAY: z.string().default(":99"),

  PLAYWRIGHT_HEADLESS: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  PLAYWRIGHT_SLOW_MO_MS: z.coerce.number().int().min(0).default(0),
  DEFAULT_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DEFAULT_ACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}

// Hard-coded constants. Not env-tunable on purpose.
//
// IMAP polling window is clamped to this regardless of caller request.
// A leaked credential checking mailbox indefinitely is the failure mode we're avoiding.
export const IMAP_MAX_POLL_MS = 60_000;

// noVNC signed-URL TTL. Deliberately short — re-mint a fresh URL if you need more time.
export const NOVNC_TTL_MS = 10 * 60 * 1000;
