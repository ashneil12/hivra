/** @jest-environment node */
// User-facing vocabulary ratchet. Hivra's glossary is agent, computer, Hivra
// Cloud, My cloud, My server and Capacity; release-stage and plumbing words
// ("Canary", "self-managed", "Box Terminal"...) confuse the people the product
// is for. This test reads the words people see in components and pages (JSX
// text, copy-carrying attributes, and sentence strings) and fails when a banned
// term appears more often in a file than the recorded baseline. The baseline
// may only shrink: when you remove a term, lower its count with
//   UPDATE_COPY_BASELINE=1 npx jest src/__tests__/user-copy-vocabulary.test.ts
// and never raise it to make new copy pass. Use the glossary instead.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "..");
const SCAN = ["components", "app"].map((dir) => path.join(ROOT, dir));
const BASELINE_PATH = path.join(__dirname, "fixtures", "user-copy-vocabulary-baseline.json");

/** Each term, what to say instead, and the pattern that finds it in user copy. */
export const BANNED_TERMS: Array<{ term: string; instead: string; pattern: RegExp }> = [
  { term: "Canary", instead: "product language (\"early access\", \"Preview\")", pattern: /\bcanary\b/gi },
  { term: "self-managed", instead: "My cloud / My server", pattern: /\bself[- ]managed\b/gi },
  { term: "customer-owned", instead: "My cloud / My server", pattern: /\bcustomer[- ]owned\b/gi },
  { term: "Command Center", instead: "Home", pattern: /\bcommand center\b/gi },
  { term: "Box Terminal", instead: "Computer terminal", pattern: /\bbox terminal\b/gi },
  { term: "the box", instead: "the computer", pattern: /\b(?:the|your|this|each) box(?:es)?\b/gi },
  { term: "New resource", instead: "agent or computer", pattern: /\bnew resource\b/gi },
  { term: "Hermes runtimes", instead: "agents", pattern: /\bhermes runtimes?\b/gi },
  { term: "instance", instead: "agent or computer", pattern: /\binstances?\b/gi },
  { term: "runtime", instead: "agent", pattern: /\bruntimes?\b/gi },
  { term: "escape hatch", instead: "plain description of the action", pattern: /\bescape hatch\b/gi },
  { term: "balloon floor", instead: "\"Guaranteed\" / \"Can burst to\"", pattern: /\bballoon floor\b/gi },
  { term: "Available alpha", instead: "\"Preview\"", pattern: /\bavailable alpha\b/gi },
];

/** Attributes whose string values people read. */
const COPY_ATTRIBUTES = /^(?:aria-label|aria-description|title|placeholder|alt|label|description|hint|message|summary|heading|subtitle|eyebrow|text|body|cta|helperText|emptyText|tooltip|caption|confirmLabel|cancelLabel)$/;
/** Attributes and calls that never carry copy. */
const NON_COPY_ATTRIBUTES = /^(?:className|class|style|key|href|src|id|type|role|name|value|htmlFor|target|rel|method|action|as|variant|size|tone|mode|kind|testId)$|^data-/;
const NON_COPY_CALLS = /^(?:log\.\w+|console\.\w+|require|import|fetch|new URL|URL|searchParams\.\w+|router\.\w+|redirect|jest\.\w+|expect)$/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "api" || entry === "node_modules") continue;
      sourceFiles(full, found);
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      found.push(full);
    }
  }
  return found;
}

function calleeText(node: ts.CallExpression | ts.NewExpression, source: ts.SourceFile): string {
  const text = node.expression.getText(source);
  return node.kind === ts.SyntaxKind.NewExpression ? `new ${text}` : text;
}

/** The strings in one file that a person could read on screen. */
export function userCopy(sourceText: string, fileName = "file.tsx"): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const copy: string[] = [];

  const stringValue = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
    return null;
  };

  const excluded = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
      if (ts.isJsxAttribute(parent)) {
        const name = parent.name.getText(source);
        if (NON_COPY_ATTRIBUTES.test(name)) return true;
        return false;
      }
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && NON_COPY_CALLS.test(calleeText(parent, source))) return true;
      if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) return true;
      if (ts.isCaseClause(parent) && parent.expression === node) return true;
      if (ts.isElementAccessExpression(parent) || ts.isLiteralTypeNode(parent) || ts.isTypeNode(parent)) return true;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(source).replace(/\s+/g, " ").trim();
      if (text) copy.push(text);
    } else {
      const value = stringValue(node);
      if (value !== null && /[A-Za-z]/.test(value) && !excluded(node)) {
        const attribute = ts.isJsxAttribute(node.parent) ? node.parent
          : ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) ? node.parent.parent : null;
        const inJsxChild = ts.isJsxExpression(node.parent) && !attribute;
        const namedCopy = attribute && COPY_ATTRIBUTES.test(attribute.name.getText(source));
        // Elsewhere, only sentences count: identifiers and enum values are single tokens.
        const sentence = /\s/.test(value.trim()) && !/^[\w./:@#?&=%-]+$/.test(value) && !/var\(--|^\s*[.#][\w-]+\s*\{/.test(value);
        if (namedCopy || inJsxChild || (!attribute && sentence)) copy.push(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return copy;
}

type Counts = Record<string, Record<string, number>>;

function countTerms(copy: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { term, pattern } of BANNED_TERMS) {
    const found = copy.reduce((total, text) => total + (text.match(pattern)?.length ?? 0), 0);
    if (found) counts[term] = found;
  }
  return counts;
}

function scanRepository(): Counts {
  const counts: Counts = {};
  for (const file of SCAN.flatMap((dir) => sourceFiles(dir)).sort()) {
    const found = countTerms(userCopy(readFileSync(file, "utf8"), file));
    if (Object.keys(found).length) counts[path.relative(ROOT, file).split(path.sep).join("/")] = found;
  }
  return counts;
}

describe("user copy extraction", () => {
  it("reads JSX text, copy attributes and sentences, and skips code-only strings", () => {
    const copy = userCopy(`
      import x from "self-managed";
      const MODE = "self-managed";
      const note = "Runs on your self-managed host.";
      export function A({ mode }: { mode: string }) {
        if (mode === "customer-owned host") return null;
        log.warn("canary gate hit", {});
        return <div className="box terminal" aria-label="Open Box Terminal" data-x="canary ready">
          Canary ready {"New resource"} <input placeholder="Hermes runtimes here" />
        </div>;
      }
    `);
    expect(copy).toEqual(expect.arrayContaining(["Runs on your self-managed host.", "Open Box Terminal", "Canary ready", "New resource", "Hermes runtimes here"]));
    expect(copy.join(" | ")).not.toMatch(/customer-owned host|canary gate hit|box terminal"|canary ready"/);
    expect(copy).not.toContain("self-managed");
  });
});

describe("user copy vocabulary", () => {
  it("adds no banned term to any component or page beyond the recorded baseline", () => {
    const current = scanRepository();
    if (process.env.UPDATE_COPY_BASELINE === "1") {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Counts;
    const regressions: string[] = [];
    for (const [file, terms] of Object.entries(current)) {
      for (const [term, count] of Object.entries(terms)) {
        const allowed = baseline[file]?.[term] ?? 0;
        if (count > allowed) {
          const instead = BANNED_TERMS.find((entry) => entry.term === term)?.instead;
          regressions.push(`${file}: "${term}" ×${count} (baseline ${allowed}). Say ${instead} instead.`);
        }
      }
    }
    expect(regressions).toEqual([]);
  });
});
