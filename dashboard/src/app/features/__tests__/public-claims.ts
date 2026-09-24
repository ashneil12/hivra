import type { Metadata } from "next";

// Claims the /features and /compare pages may not make today. These pages ship
// their copy three ways (rendered text, meta description and FAQPage JSON-LD),
// so a false claim here reaches search engines and answer engines, not just
// readers. Evidence for each ban: no measured launch timing, backups are not
// guaranteed, built-in orchestration is not shipped, checkout has no trial,
// agent caps and plan names differ between checkout and the public price
// ladder, and Hivra has no OpenClaw import of its own. Added after the
// 2026-09-24 review: every agent runs on its own computer (not one server);
// the JSON export and account memory exist only for Claude Code and Codex
// agents (api/hivra/agents/[id]/export reads hivra_agents only, and
// account-memory.ts seeds only new Hivra boxes); /pricing shows a preview
// ladder, so sizes are stated inline instead of sending readers there; no
// proxy setting exists; the Tasks tab offers a frequency picker, not a
// natural-language schedule, and delivers to Telegram, Discord or email; the
// money-back guarantee covers card payments only.
export const BANNED_PUBLIC_CLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "unmeasured speed claim",
    /\b\d+(?:\s*(?:-|–|to)\s*\d+)?\s*(?:min|mins|minute|minutes|sec|secs|second|seconds)\b[^.!?]*\b(?:deploy|running|first|live|set ?up|provision|migrat|sign ?up)/i,
  ],
  [
    "unmeasured speed claim",
    /\b(?:deploy|running|first|live|set ?up|setup|provision|migrat|sign ?up|signup)\w*\b[^.!?]*\b(?:in|under|about|within|takes?|typically)\s+(?:about\s+)?\d+(?:\s*(?:-|–|to)\s*\d+)?\s*(?:min|mins|minute|minutes|sec|secs|second|seconds)\b/i,
  ],
  [
    "unmeasured speed claim",
    /\b(?:in|under|within) (?:about )?\d+ min(?:ute)?s?\b|\ba few minutes\b|\btakes? (?:about )?\d+(?:\s*(?:-|–)\s*\d+)? min/i,
  ],
  ["free trial", /free[- ]trial/i],
  ["card required", /card[- ]required|requires? a (?:credit )?card|no (?:credit )?card/i],
  ["multi-agent coordination as a shipped feature", /multi-agent coordination|coordinated multi-agent|cross-agent references/i],
  [
    "guaranteed backups",
    /nightly backups?|daily (?:encrypted )?backups?|backed up daily|backups? (?:are )?(?:included|automatic)|automatic (?:daily|nightly)/i,
  ],
  ["agent-count limit", /\bup to \d+ (?:active )?agents\b|\b\d+ active agents\b|\b\d+ on (?:Pro|Power)\b|\b\d+ agents on\b/i],
  ["checkout or ladder plan name", /\b(?:Pro|Power|Starter|Studio|Max) plan\b|\bHivra (?:Free|Pro|Power)\b/],
  ["hosted free plan", /free starter (?:agent|plan)|free plan for one/i],
  // $19.99 is the larger size, never the starting price, and it is always
  // stated with the size it buys.
  ["$19.99 as the entry price or without its size", /\bfrom \$19\.99|^(?![\s\S]*\b4 vCPU\b)[\s\S]*\$19\.99/i],
  ["one-server claim", /\bone server\b/i],
  [
    "JSON export claimed beyond Claude Code and Codex",
    /^(?![\s\S]*\b(?:Claude Code|Codex)\b)[\s\S]*(?:\bJSON (?:export|file)\b|\bexport\b[^.!?]*\bJSON\b)/i,
  ],
  ["account memory claimed beyond Claude Code and Codex", /^(?![\s\S]*\b(?:Claude Code|Codex)\b)[\s\S]*\baccount memory\b/i],
  [
    "sends readers to /pricing for sizes or caps",
    /\b(?:sizes?|caps?)\b[^.!?]*\b(?:on|listed on|shown on) the pricing page|pricing page[^.!?]*\b(?:sizes?|caps?)\b/i,
  ],
  ["proxy setting that does not exist", /residential proxy (?:credentials|support|configuration)|\bSOCKS5\b|proxy configuration accepts/i],
  ["headless browser as the Hivra default", /default is (?:local )?headless Chromium|headless Chromium browser/i],
  ["natural-language schedule input", /schedule[^.!?]*\bnatural language\b|natural language[^.!?]*\bcron\b/i],
  ["delivery the task form does not offer", /Telegram, email, Slack|Slack, or a webhook/i],
  ["money-back guarantee without the card-payments limit", /\b7-day money-back guarantee(?! on card payments)|Yes \(7-day\)/i],
  ["native OpenClaw import", /native (?:OpenClaw )?migration|hermes import --from openclaw|dashboard import flow/i],
  ["absolute privacy claim", /cannot read your|can't read your|never sees? your|no access to your/i],
  ["Hermes-only framing", /\bpurpose-built\b[^.!?]*\bfor Hermes\b|\b(?:hosting|infrastructure) for Hermes agents\b|only purpose-built/i],
  ["unverified hosting regions", /\bUS West\b|\bEU West\b/],
];

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function jsonStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => jsonStrings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => jsonStrings(item, out));
  return out;
}

/** Visible text blocks plus every string in the page's JSON-LD. */
export function renderedCopy(container: HTMLElement): string[] {
  const blocks = Array.from(container.querySelectorAll("h1, h2, h3, p, li, th, td, summary, a, button")).map(
    (element) => element.textContent ?? ""
  );
  const structured = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).flatMap((script) =>
    jsonStrings(JSON.parse(script.textContent ?? "{}"), [])
  );
  return [...blocks, ...structured].filter(Boolean);
}

/** Title and descriptions a search or social crawler reads. */
export function metadataCopy(metadata: Metadata): string[] {
  const og = (metadata.openGraph ?? {}) as { title?: unknown; description?: unknown };
  const twitter = (metadata.twitter ?? {}) as { title?: unknown; description?: unknown };
  return [metadata.title, metadata.description, og.title, og.description, twitter.title, twitter.description].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

export function findBannedClaims(label: string, copy: string[]): string[] {
  const found = new Set<string>();
  for (const block of copy) {
    for (const sentence of sentences(block)) {
      for (const [name, pattern] of BANNED_PUBLIC_CLAIMS) {
        if (pattern.test(sentence)) found.add(`${label}: ${name}: ${sentence.slice(0, 160)}`);
      }
    }
  }
  return [...found];
}

// Copy these pages carried before the 2026-09-24 truth pass. Each must still be
// caught, so a loosened pattern cannot let the old claims back in unnoticed.
export const KNOWN_FALSE_CLAIMS = [
  "Deploy in 5 Min",
  "Host a Hermes AI agent without Docker. Deploy in under 5 minutes. From $9.99/mo.",
  "Deployed in 5 minutes without touching a terminal.",
  "Hivra starts at $9.99/mo and takes 5 minutes.",
  "From signup to running agent in under 5 minutes",
  "Sign up, paste an API key, running agent in under 5 minutes.",
  "The full migration takes 15-30 minutes for a typical OpenClaw setup.",
  "Infrastructure provisions automatically, typically 60-90 seconds.",
  "Hivra imports your existing agent configuration and memory. The migration takes about 15 minutes.",
  "Coordinated multi-agent workflows built in.",
  "Multi-agent coordination",
  "Automatic daily encrypted backups",
  "Pre-configured, daily backups",
  "Pro includes up to 3 active agents and Power includes up to 5.",
  "3 on Pro, 5 on Power",
  "Hivra Power plan is $19.99/month for 4 vCPU and 8 GB RAM.",
  "7-day free trial, card required",
  "Native migration built in.",
  "Hivra is purpose-built managed infrastructure for Hermes agents.",
  "At signup you choose from US East, US West, EU Central, and EU West.",
  "Run Multiple AI Agents on One Server",
  "One server. Multiple active agents.",
  "Pre-configured, with JSON export",
  "Chats and memory as one JSON file",
  "You can also download an agent's chats and memory files as one JSON file from the agent's page.",
  "notes you write once on the dashboard's shared memory page are copied into each new agent you launch. The one shared piece is optional account memory.",
  "Each agent gets its own memory, tools, and role, and how many can run at once depends on your plan size, shown on the pricing page.",
  "Current sizes are listed on the pricing page.",
  "Hosting starts at $9.99/mo for 2 vCPU and 4 GB RAM; larger sizes are listed on the pricing page.",
  "Hosting from $19.99/mo.",
  "Residential proxy support for sites with strict bot detection",
  "The proxy configuration accepts any SOCKS5 or HTTP proxy endpoint and routes browser traffic through it.",
  "Hermes agents use a pre-configured headless Chromium browser.",
  "The schedule accepts natural language (\"every weekday at 8am\") or standard cron expressions for precise timing.",
  "Send results to Telegram, email, Slack, or a webhook",
  "7-day money-back guarantee on paid plans.",
  "Yes (7-day)",
];

// True copy the scanner must leave alone.
export const KNOWN_TRUE_CLAIMS = [
  "Render's free tier spins down web services after 15 minutes without inbound traffic, and free services cannot use a persistent disk.",
  "Hosting starts at $9.99/month for 2 vCPU and 4 GB RAM.",
  "Backup coverage depends on the agent and provider and is not guaranteed.",
  "Hivra does not coordinate work between them today; built-in orchestration is planned, not shipped.",
  "Initial setup: 4-8 hours for a developer who knows Linux.",
  "Runs at 7am, arrives in Telegram as a formatted message by 7:15am.",
  "Hosting is $9.99/mo for 2 vCPU and 4 GB RAM, or $19.99/mo for 4 vCPU and 8 GB RAM.",
  "The $19.99/mo size (4 vCPU, 8 GB RAM) adds room for parallel work.",
  "Claude Code and Codex agents add an Export data link on the agent's page that downloads their chats and memory as one JSON file.",
  "The one shared piece is optional account memory for Claude Code and Codex agents.",
  "7-day money-back guarantee on card payments.",
  "Hivra does not have a one-click OpenClaw import, so moving is a manual step.",
];

/** Search results cut descriptions past about 155 characters. */
export const MAX_META_DESCRIPTION_LENGTH = 155;

/** Every description a search or social crawler reads, with its length. */
export function metadataDescriptions(metadata: Metadata): string[] {
  const og = (metadata.openGraph ?? {}) as { description?: unknown };
  const twitter = (metadata.twitter ?? {}) as { description?: unknown };
  return [metadata.description, og.description, twitter.description].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}
