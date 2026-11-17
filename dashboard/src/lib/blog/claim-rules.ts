// Claim scanners for public copy (blog articles and docs). Copy here is rendered on
// the page and often shipped as JSON-LD, so a false product claim reaches search
// engines as structured data. Used by lib/blog/__tests__/blog-claims.test.ts and
// lib/docs/__tests__/docs-registry.test.ts.

import { CLI_RUN_FALSE_CLAIMS } from "@/lib/blog/runtime-facts";

/** Sentences (and table rows) that talk about Hivra itself. */
export function hivraSentences(copy: string): string[] {
  return copy
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => /\bHivra\b/.test(sentence) || /\| Hivra managed \|/.test(sentence));
}

// Claims the site may not make today (owner pricing decision 2026-09-14 and the
// public claims audit): no trial of any kind, no card-gated trial, no hosted
// free plan, no inactivity promises below the entry price, no agent counts, no
// guaranteed backups, no "cannot see your data", no unmeasured speed claims.
export const BANNED_ANYWHERE: Array<[string, RegExp]> = [
  ["free trial", /free[- ]trial/i],
  ["card required", /card required|no card required|no credit card/i],
  ["never sleeps", /never sleeps/i],
  ["unlimited agents", /unlimited agents/i],
  ["Hivra cannot see content", /cannot read your|never sees? (?:your|those|either)|never holds your|no access to your content/i],
  ["guaranteed backups", /nightly backups? handle|backed up automatically|automated (?:nightly )?backups/i],
  ["trial clause helper", /trialCard/],
  // `claude -p` cannot wait out a usage window.
  ["usage-window resume claim", /stalls until the usage window resets|window resets, then continues/i],
  // Claude Code and Codex keep-running claims, shared with /agents and /tools
  // (lib/blog/runtime-facts.ts): the old survives-anything claims, "stops when
  // you close the tab" (false on computers with the 2026.09.24.1 runtime) and
  // "the browser chat keeps going" (false on computers without it).
  ...CLI_RUN_FALSE_CLAIMS.map(({ label, pattern }): [string, RegExp] => [label, pattern]),
  // Hivra's chat bypasses the CLIs' permission prompts by default. (Hermes on a
  // Hivra computer is the official upstream install, see docs/STATUS.md; this
  // rule is about the CLI agents.)
  [
    "unmodified-runtime claim",
    /behave exactly as they would|not a fork or a wrapper|official unmodified runtimes|assumes the managed platform runs the same software/i,
  ],
  ["money-back guarantee without the card-payments limit", /money-back guarantee(?! on card payments)/i],
  // Found by the 2026-09-30 review: old sentences the scanners missed because
  // they do not name Hivra or use the exact retired phrasing.
  ["daily encrypted backups", /daily encrypted backups/i],
  ["natural-language schedule", /natural language or cron/i],
  ["official unmodified CLI", /official (?:CLIs?,? )?unmodified|unmodified CLIs?|CLIs, unmodified|both open-source projects unmodified/i],
  ["absolute privacy claim", /never used to train models and never shared/i],
  ["denies the Claude Code agent's Telegram tab", /does not claim a built-in Telegram connection|No built-in Hivra Telegram connection/i],
];

export const BANNED_ABOUT_HIVRA: Array<[string, RegExp]> = [
  ["hosted free plan", /free (?:tier|plan)|\$0(?![.\d])/i],
  ["agent-count limit", /\bup to \d+ (?:always-on )?agents\b|\b\d+ (?:always-on )?agents\b|agent slots?/i],
  ["plan names that collide with the public ladder", /\b(?:Pro|Power|Starter|Studio|Max) plan\b|Hivra (?:Pro|Power)\b/],
  ["unmeasured speed claim", /\b(?:in|under|about|within) (?:about )?\d+ minutes\b|~\s?\d+ minutes|a few minutes/i],
  ["bring-your-own-cloud providers", /\b(?:AWS|GCP|Google Cloud|Azure|DigitalOcean)\b/],
  ["Windows availability", /\bWindows\b/],
  // Backups are not guaranteed: a sentence about Hivra may mention backups only
  // to say so.
  ["backups as a guarantee", /^(?![\s\S]*\bnot\b)[\s\S]*\bbackups?\b/i],
  ["one-click claim", /one[- ]click|\binstantly\b/i],
  // Zero markup is true for your own key, login or subscription; Hivra also
  // sells managed credits.
  [
    "zero markup without the own-key scope",
    /^(?![\s\S]*\b(?:your own|own (?:key|login|account|subscription|API)|BYO|bring your own)\b)[\s\S]*\b(?:zero|no) markup\b/i,
  ],
  // State price and size together: $9.99 is 2 vCPU and 4 GB, $19.99 is 4 vCPU and 8 GB.
  ["Hivra price without its size", /^(?![\s\S]*\bvCPU\b)[\s\S]*\$(?:9\.99|19\.99)/],
  ["unmeasured speed claim", /hours to minutes/i],
  // The JSON export exists only for Claude Code and Codex agents
  // (api/hivra/agents/[id]/export reads hivra_agents).
  ["JSON export claimed beyond Claude Code and Codex", /^(?![\s\S]*\b(?:Claude Code|Codex)\b)[\s\S]*\bJSON\b/],
];

/**
 * Sentences that say Hivra runs or hosts Claude Code or Codex. Any article
 * containing one must carry the non-affiliation line.
 */
export function hostsVendorCli(copy: string): boolean {
  return hivraSentences(copy).some((sentence) => /\b(?:Claude Code|Codex)\b/.test(sentence));
}

/** Markdown table rows as cell arrays, for every table in the copy. */
export function markdownTables(copy: string): string[][][] {
  const tables: string[][][] = [];
  let current: string[][] = [];
  for (const line of copy.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      current.push(trimmed.slice(1, -1).split("|").map((cell) => cell.trim()));
    } else if (current.length) {
      tables.push(current);
      current = [];
    }
  }
  if (current.length) tables.push(current);
  return tables;
}

export const LAPTOP_CLOSED = /laptop|sleep|closed?\b/i;
export const BARE_YES = /^yes\.?$/i;

/**
 * Table rows that answer "does it survive a closed laptop" with a bare "Yes"
 * for Hivra, whether Hivra is a column or a row. A Claude Code or Codex run
 * started in the browser chat stops with its tab, so the Hivra cell must say
 * which runs keep going.
 */
export function bareYesHivraLaptopRows(copy: string): string[] {
  const found: string[] = [];
  for (const table of markdownTables(copy)) {
    const header = table[0];
    const hivraColumns = header.flatMap((cell, index) => (/\bHivra\b/.test(cell) ? [index] : []));
    const laptopColumns = header.flatMap((cell, index) => (LAPTOP_CLOSED.test(cell) ? [index] : []));
    for (const row of table.slice(1)) {
      const cells = [
        ...(LAPTOP_CLOSED.test(row[0] ?? "") ? hivraColumns : []),
        ...(row.some((cell) => /\bHivra\b/.test(cell)) ? laptopColumns : []),
      ];
      if (cells.some((index) => BARE_YES.test(row[index] ?? ""))) found.push(row.join(" | "));
    }
  }
  return found;
}

export function bannedAnywhere(copy: string): string[] {
  return BANNED_ANYWHERE.filter(([, pattern]) => pattern.test(copy)).map(([label]) => label);
}

/** Hivra-column table cells that quote a plan price without the size it buys. */
export function hivraTablePricesWithoutSize(copy: string): string[] {
  const found: string[] = [];
  for (const table of markdownTables(copy)) {
    const columns = table[0].flatMap((cell, index) => (/\bHivra\b/.test(cell) ? [index] : []));
    for (const row of table.slice(1)) {
      for (const index of columns) {
        const cell = row[index] ?? "";
        if (/\$(?:9\.99|19\.99)/.test(cell) && !/\bvCPU\b/.test(cell)) found.push(row.join(" | "));
      }
    }
  }
  return found;
}

export function bannedAboutHivra(copy: string): string[] {
  return hivraSentences(copy).flatMap((sentence) =>
    BANNED_ABOUT_HIVRA.filter(([, pattern]) => pattern.test(sentence)).map(([label]) => `${label}: ${sentence.slice(0, 160)}`)
  );
}
