import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildLlmsTxt } from "@/lib/llms-txt";

const DASHBOARD = path.join(__dirname, "..", "..");
const PAID_ONLY = /\b(?:every|all)\s+(?:Hivra Cloud computers?|Hivra-run computers?|computers?\s+(?:that\s+)?Hivra Cloud runs(?:\s+for you)?)\s+(?:needs? a paid plan|requires? a paid plan|(?:is|are) (?:a )?paid)\b|\bHivra (?:does not|doesn['’]t) run a computer for you without a paid plan\b/i;

function* copyFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "__tests__") {
      yield* copyFiles(file);
    } else if (entry.isFile() && /\.(?:tsx?|jsx?|mdx?|html|json|txt)$/.test(entry.name) && !/\.(?:test|spec)\.[jt]sx?$/.test(entry.name)) {
      yield file;
    }
  }
}

it("does not publish a categorical paid-only claim in site copy or llms.txt", () => {
  const offenders = ["src", "public"].flatMap((dir) =>
    [...copyFiles(path.join(DASHBOARD, dir))].flatMap((file) => {
      const copy = readFileSync(file, "utf8").replace(/^\s*(?:\/\/|\*)[^\n]*$/gm, "").replace(/\s+/g, " ");
      return PAID_ONLY.test(copy) ? [path.relative(DASHBOARD, file)] : [];
    }),
  );
  expect(offenders).toEqual([]);

  for (const view of [{}, { restricted: true }, { tokenSurfaces: false }]) {
    expect(buildLlmsTxt({ siteUrl: "https://hivra.cloud", ...view })).not.toMatch(PAID_ONLY);
  }
});
