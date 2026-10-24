import fs from "fs";
import path from "path";

import { findBannedClaims } from "@/lib/tools/copy-rules";

// metadata-titles.test.ts reads only a literal `title: "..."` at the top level of
// `export const metadata`. A finished browser title written with `absoluteTitle(...)`
// or `{ absolute: "..." }` (lib/metadata.ts, so the root layout does not add
// " | Hivra" a second time) is invisible to it, so this file scans those titles
// with the same rules: no dashes, no retired offer or speed claim, not empty.
const APP_ROOT = path.join(__dirname, "..");

// "deploy ... in under 5 minutes" is missed by the shared list; metadata-titles.test.ts names it too.
const SPEED_CLAIM = /\bin under \d+ (?:minutes|seconds)\b/i;
const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;

export interface AbsoluteTitleLiteral {
  /** Where the title was written: the call, an `absolute:` key, or a constant the call names. */
  form: "call" | "key" | "constant";
  text: string;
}

/** Every finished-title string literal one page or layout source writes, plus any constant it names. */
export function absoluteTitleLiterals(source: string): { found: AbsoluteTitleLiteral[]; unresolved: string[] } {
  const found: AbsoluteTitleLiteral[] = [];
  const unresolved: string[] = [];
  for (const match of source.matchAll(new RegExp(String.raw`absoluteTitle\(\s*${STRING}\s*\)`, "g"))) {
    found.push({ form: "call", text: match[1] });
  }
  for (const match of source.matchAll(new RegExp(String.raw`\babsolute:\s*${STRING}`, "g"))) {
    found.push({ form: "key", text: match[1] });
  }
  for (const match of source.matchAll(/absoluteTitle\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const name = match[1];
    const declared = source.match(new RegExp(String.raw`\b(?:const|let)\s+${name}\s*(?::\s*string)?\s*=\s*${STRING}`));
    if (declared) found.push({ form: "constant", text: declared[1] });
    else unresolved.push(name);
  }
  return { found, unresolved };
}

function pageSources(): { file: string; source: string }[] {
  const sources: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "api") walk(full);
        continue;
      }
      if (!/^(page|layout)\.tsx$/.test(entry.name)) continue;
      sources.push({ file: path.relative(APP_ROOT, full), source: fs.readFileSync(full, "utf8") });
    }
  };
  walk(APP_ROOT);
  return sources;
}

describe("absolute page titles in static metadata", () => {
  it("finds the title forms it is meant to guard", () => {
    const source = [
      'const TITLE = "Pricing | Hivra";',
      "export const metadata = {",
      "  title: absoluteTitle(TITLE),",
      '  other: absoluteTitle("Direct title"),',
      '  third: { absolute: "Key title" },',
      "  fourth: absoluteTitle(imported),",
      "};",
    ].join("\n");
    expect(absoluteTitleLiterals(source)).toEqual({
      found: [
        { form: "call", text: "Direct title" },
        { form: "key", text: "Key title" },
        { form: "constant", text: "Pricing | Hivra" },
      ],
      unresolved: ["imported"],
    });
  });

  it("rejects a title with a dash or a retired claim, so the scan below can fail", () => {
    const { found } = absoluteTitleLiterals('x(absoluteTitle("Run agents \u2014 in under 5 minutes, free trial"));');
    expect(found).toHaveLength(1);
    expect(found[0].text).toMatch(/[\u2013\u2014]/);
    expect(SPEED_CLAIM.test(found[0].text)).toBe(true);
    expect(findBannedClaims(found[0].text).length).toBeGreaterThan(0);
  });

  it("writes no dash, no retired offer claim and no unmeasured speed claim in any finished title", () => {
    const offenders: string[] = [];
    for (const { file, source } of pageSources()) {
      for (const { form, text } of absoluteTitleLiterals(source).found) {
        if (!text.trim()) offenders.push(`${file}: empty ${form} title`);
        if (/[\u2013\u2014]/.test(text)) offenders.push(`${file}: dash in "${text}"`);
        if (SPEED_CLAIM.test(text)) offenders.push(`${file}: unmeasured speed claim in "${text}"`);
        for (const hit of findBannedClaims(text)) offenders.push(`${file}: "${hit.match}" in "${text}" (${hit.why})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
