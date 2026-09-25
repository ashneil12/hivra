// Shared by host-transport-size-limits.test.ts and
// transport-payload-budgets.test.ts. Not a test file.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TRANSPORT_BUDGETS_PATH = path.join(__dirname, "transport-payload-budgets.json");

export type TransportLimitId =
  | "linux-argument"
  | "host-script-with-stdin.script"
  | "host-script-with-stdin.stdin"
  | "guest-exec-stdin"
  | "sudo-transport-script"
  | "provider-guest-seed"
  | "windows-command-line"
  | "cloud-init-user-data";

export type RecordedMeasure = { bytes: number; limit: TransportLimitId; percent: number };
export type TransportBudgets = {
  about: string[];
  budgetFraction: number;
  limits: Record<TransportLimitId, { bytes: number; what: string }>;
  overBudget: Record<string, string>;
  payloads: Record<string, Record<string, RecordedMeasure>>;
};

export function readTransportBudgets(): TransportBudgets {
  return JSON.parse(readFileSync(TRANSPORT_BUDGETS_PATH, "utf8")) as TransportBudgets;
}

export function writeTransportBudgets(budgets: TransportBudgets): void {
  writeFileSync(TRANSPORT_BUDGETS_PATH, JSON.stringify(budgets, null, 2) + "\n");
}

/**
 * The words of one simple command, read the way bash reads them, starting at
 * `needle` (which must occur exactly once and begin the command) and ending at
 * the first unquoted newline, `;`, `|`, `&`, `<`, `>` or `)`. A needle that
 * spans lines only anchors the command: reading starts after its last newline.
 * Single quotes,
 * backslash escapes and double quotes are honoured; nothing is expanded, so a
 * word with `$` in it keeps its literal text. Enough for the quoted programs
 * and payloads Hivra's builders put in their scripts (shellQuote output).
 */
export function shellWordsFrom(text: string, needle: string): string[] {
  const first = text.indexOf(needle);
  if (first < 0) throw new Error(`Command not found: ${needle.slice(0, 80)}`);
  if (text.indexOf(needle, first + 1) >= 0) throw new Error(`Command is not unique: ${needle.slice(0, 80)}`);
  const words: string[] = [];
  let word: string | null = null;
  const push = () => { if (word !== null) words.push(word); word = null; };
  for (let index = first + needle.lastIndexOf("\n") + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) throw new Error("Unterminated single quote");
      word = (word ?? "") + text.slice(index + 1, end);
      index = end;
    } else if (char === "\\") {
      if (text[index + 1] === "\n") { index += 1; continue; }
      word = (word ?? "") + text[index + 1];
      index += 1;
    } else if (char === '"') {
      let value = "";
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        if (text[index] === "\\" && '"\\$`'.includes(text[index + 1])) index += 1;
        value += text[index];
      }
      if (index >= text.length) throw new Error("Unterminated double quote");
      word = (word ?? "") + value;
    } else if (char === " " || char === "\t") {
      push();
    } else if ("\n;|&<>)".includes(char)) {
      break;
    } else {
      word = (word ?? "") + char;
    }
  }
  push();
  return words;
}

/** The step body: the one argument `underHostLock` hands python3 (then bash). */
export function hostStepArgument(script: string): string {
  const words = shellWordsFrom(script, "\nexec /usr/bin/python3 -I -B -c ");
  if (words.length !== 7) throw new Error("Unexpected host lock command");
  return words[6];
}

export const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
