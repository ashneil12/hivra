import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadEnvConfig } from "@next/env";

import { CURATED_SKILLS } from "../src/data/curated-skills";

loadEnvConfig(process.cwd());

const CATALOG_PATH = path.join(process.cwd(), "src/data/curated-skills.ts");
const RAW_BASE_URL = "https://raw.githubusercontent.com/BankrBot/skills/main";
const SKILL_FILE_CANDIDATES = ["SKILL.md", "skill.md"];

function stringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function patchSkillContent(source: string, identifier: string, content: string): string {
  const identifierNeedle = `identifier: "${identifier}"`;
  const identifierIndex = source.indexOf(identifierNeedle);
  if (identifierIndex === -1) {
    throw new Error(`Could not find curated skill identifier ${identifier}`);
  }

  const entryStart = source.lastIndexOf("\n  {", identifierIndex);
  const repoUrlIndex = source.indexOf("\n    repoUrl:", identifierIndex);
  if (entryStart === -1 || repoUrlIndex === -1) {
    throw new Error(`Could not locate repoUrl for ${identifier}`);
  }

  const entryPrefix = source.slice(entryStart, repoUrlIndex);
  const contentLine = `\n    content: ${stringLiteral(content)},`;
  const contentPattern = new RegExp(`\\n\\s{4}content: (?:"(?:\\\\.|[^"\\\\])*"|\\\`[\\s\\S]*?\\\`),`);

  if (contentPattern.test(entryPrefix)) {
    const patchedPrefix = entryPrefix.replace(contentPattern, () => contentLine);
    return `${source.slice(0, entryStart)}${patchedPrefix}${source.slice(repoUrlIndex)}`;
  }

  return `${source.slice(0, repoUrlIndex)}${contentLine}${source.slice(repoUrlIndex)}`;
}

function skillPathFromIdentifier(identifier: string): string {
  const skillPath = identifier.replace(/^BankrBot\/skills\//, "");
  if (!skillPath || skillPath === identifier) {
    throw new Error(`Cannot derive Bankr skill path from ${identifier}`);
  }

  return skillPath;
}

export function rawSkillContentUrl(identifier: string, fileName = "SKILL.md"): string {
  const skillPath = skillPathFromIdentifier(identifier)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `${RAW_BASE_URL}/${skillPath}/${encodeURIComponent(fileName)}`;
}

async function fetchSkillContent(identifier: string): Promise<string> {
  let lastStatus = "not attempted";
  for (const fileName of SKILL_FILE_CANDIDATES) {
    const url = rawSkillContentUrl(identifier, fileName);
    const response = await fetch(url);
    lastStatus = `HTTP ${response.status}`;
    if (!response.ok) {
      continue;
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new Error(`Empty ${fileName} for ${identifier}`);
    }

    return text.replace(/\r\n/g, "\n").trimEnd() + "\n";
  }

  throw new Error(`Fetch failed for ${identifier}: ${lastStatus}`);
}

async function main() {
  const bankrSkills = CURATED_SKILLS.filter((skill) => skill.category === "bankr");
  let source = readFileSync(CATALOG_PATH, "utf8");
  let vendored = 0;
  let skipped = 0;

  for (const skill of bankrSkills) {
    try {
      const content = await fetchSkillContent(skill.identifier);
      source = patchSkillContent(source, skill.identifier, content);
      vendored += 1;
      process.stdout.write(`[vendor-bankr-skills] vendored ${skill.identifier}\n`);
    } catch (err) {
      skipped += 1;
      process.stderr.write(
        `[vendor-bankr-skills] skipped ${skill.identifier}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  writeFileSync(CATALOG_PATH, source, "utf8");
  process.stdout.write(`[vendor-bankr-skills] updated ${vendored} Bankr skills; skipped ${skipped}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[vendor-bankr-skills] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
