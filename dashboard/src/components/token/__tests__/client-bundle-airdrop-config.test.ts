/** @jest-environment node */
/**
 * The airdrop config (hivra-airdrop-config.ts) also holds the Sablier campaign
 * link and the claim window, which exist for /token/airdrop and
 * /token/migration only while the claim is open. /token and the "Check a token
 * address" form are client components, so anything their import graph reaches is
 * in the browser bundle for every viewer, including a viewer the token geo-policy
 * blocks and a viewer before the claim opens. This walks the value imports of
 * those client entry points and fails if the config is reachable.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SRC = resolve(__dirname, "../../..");
const CONFIG = join(SRC, "lib/claim/hivra-airdrop-config.ts");

const CLIENT_ENTRY_POINTS = [
  "components/token/TokenPageClient.tsx",
  "components/token/TokenLaunchedView.tsx",
  "components/token/CopyAddressButton.tsx",
  "components/claim/TokenAddressChecker.tsx",
];

function resolveModule(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Local modules a file imports as values (`import type` and `export type` are erased and do not count). */
function valueImports(file: string): string[] {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[2]) continue; // import type / export type
    const clause = match[3] ?? "";
    // `import { type A, type B } from` has no value left once every name is a type.
    if (/^\{[^}]*\}$/.test(clause.trim())) {
      const names = clause.trim().slice(1, -1).split(",").map((name) => name.trim()).filter(Boolean);
      if (names.length > 0 && names.every((name) => name.startsWith("type "))) continue;
    }
    const specifier = match[4] ?? match[5] ?? match[6];
    const resolved = specifier ? resolveModule(file, specifier) : null;
    if (resolved) found.push(resolved);
  }
  return found;
}

function reachable(entry: string): Map<string, string> {
  const parent = new Map<string, string>();
  const queue = [entry];
  parent.set(entry, "");
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const next of valueImports(file)) {
      if (parent.has(next)) continue;
      parent.set(next, file);
      queue.push(next);
    }
  }
  return parent;
}

function chain(parent: Map<string, string>, target: string): string {
  const path: string[] = [];
  for (let file = target; file; file = parent.get(file) ?? "") path.unshift(file.replace(`${SRC}/`, ""));
  return path.join(" -> ");
}

describe("the client bundle never reaches the airdrop config", () => {
  it("finds the config file this guard is about", () => {
    expect(existsSync(CONFIG)).toBe(true);
  });

  it("sees real imports (so a silent empty walk cannot pass)", () => {
    const parent = reachable(join(SRC, "components/token/TokenLaunchedView.tsx"));
    expect(parent.size).toBeGreaterThan(5);
    expect([...parent.keys()].some((file) => file.endsWith("lib/token-verification-content.ts"))).toBe(true);
  });

  it.each(CLIENT_ENTRY_POINTS)("%s does not import it, directly or through another module", (entry) => {
    const file = join(SRC, entry);
    expect(readFileSync(file, "utf8")).toMatch(/^"use client";/);
    const parent = reachable(file);
    expect(parent.has(CONFIG) ? chain(parent, CONFIG) : null).toBeNull();
  });
});
