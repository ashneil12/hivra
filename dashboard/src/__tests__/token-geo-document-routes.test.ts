/** @jest-environment node */
/**
 * The four token documents (LITEPAPER.md, WHITEPAPER.md, TOKENOMICS.md and the
 * litepaper page) fail closed for a listed country: they are not files in
 * public/, so no spelling of the path reaches a full copy as a static file, and
 * the route handlers decide by country.
 *
 * Before this, a path rule matched the raw path while the platform decoded it
 * for its static-file lookup, so /LITEPAPER%2Emd, /%4CITEPAPER.md and
 * /docs/litepaper/%69ndex.html served the full documents to a UK visitor.
 *
 * The documents are staged by the real scripts/stage-litepaper.mjs from the real
 * repository sources into a temporary dashboard directory, and the real route
 * handlers read them with the real country list. scripts/verify-token-geo-documents.mjs
 * runs the same checks against a running server.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { NextRequest } from "next/server";

import { GET as getLitepaperPage } from "@/app/docs/litepaper/index.html/route";
import { GET as getLitepaper } from "@/app/LITEPAPER.md/route";
import { GET as getTokenomics } from "@/app/TOKENOMICS.md/route";
import { GET as getWhitepaper } from "@/app/WHITEPAPER.md/route";
import { BLOCKED_COUNTRIES } from "@/lib/compliance/token-geo-list";
import { GEO_DOCUMENTS_DIRECTORY, TOKEN_GEO_DOCUMENTS } from "@/lib/compliance/token-geo-documents";

import nextConfig from "../../next.config";

// The setup file empties the list for the other suites; this one needs the real one.
jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

const DASHBOARD = path.resolve(__dirname, "../..");
const REPO = path.resolve(DASHBOARD, "..");
const STAGE_SCRIPT = pathToFileURL(path.join(DASHBOARD, "scripts/stage-litepaper.mjs")).href;

type StageModule = {
  GEO_DOCUMENTS: Array<{ name: string; route: string; full: string; restricted: string }>;
  GEO_DOCUMENTS_DIRECTORY: string;
  FORBIDDEN_PUBLIC_PATHS: string[];
};

function runStageScript(body: string): string {
  const result = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(STAGE_SCRIPT)}).then(async (stage) => { ${body} })`], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`stage script failed: ${result.stderr}`);
  return result.stdout;
}

const stage: StageModule = JSON.parse(
  runStageScript("console.log(JSON.stringify({ GEO_DOCUMENTS: stage.GEO_DOCUMENTS, GEO_DOCUMENTS_DIRECTORY: stage.GEO_DOCUMENTS_DIRECTORY, FORBIDDEN_PUBLIC_PATHS: stage.FORBIDDEN_PUBLIC_PATHS }));"),
);

const HANDLERS: Record<string, (request: NextRequest) => Promise<Response>> = {
  "/LITEPAPER.md": getLitepaper,
  "/WHITEPAPER.md": getWhitepaper,
  "/TOKENOMICS.md": getTokenomics,
  "/docs/litepaper/index.html": getLitepaperPage,
};

const source = (relative: string) => readFileSync(path.join(REPO, relative), "utf8");

function call(route: string, country?: string) {
  const request = new Request(`https://hivra.test${route}`, country === undefined ? {} : { headers: { "x-vercel-ip-country": country } });
  return HANDLERS[route](request as NextRequest);
}

/**
 * Every single-character percent-encoding of each document's address, in both
 * hex cases, plus the encoded-slash spellings and the exact ones that were
 * confirmed live against the canary deployment.
 */
function encodedVariants(): string[] {
  const variants = new Set<string>([
    "/LITEPAPER%2Emd", "/%4CITEPAPER.md", "/LITEPAPER.m%64",
    "/WHITEPAPER%2Emd", "/%57HITEPAPER.md",
    "/TOKENOMICS%2Emd", "/%54OKENOMICS.md",
    "/docs/litepaper/%69ndex.html", "/docs/litepaper/index%2ehtml", "/docs/litepaper/index%2Ehtml",
    "/docs/%6citepaper/index.html", "/docs/litepaper/index.htm%6C",
    "/docs%2Flitepaper/index.html", "/docs/litepaper%2Findex.html", "/docs%2Flitepaper%2Findex.html",
  ]);
  for (const route of Object.keys(HANDLERS)) {
    for (let index = 1; index < route.length; index += 1) {
      const code = route.charCodeAt(index).toString(16).padStart(2, "0");
      for (const hex of [code.toUpperCase(), code.toLowerCase()]) {
        variants.add(`${route.slice(0, index)}%${hex}${route.slice(index + 1)}`);
      }
    }
  }
  return [...variants];
}

/** What the platform's static-file lookup sees: the raw path with every %XX decoded. */
function decodedPath(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

describe("token documents by country", () => {
  let dashboardRoot: string;
  let cwd: jest.SpyInstance;

  beforeAll(() => {
    dashboardRoot = mkdtempSync(path.join(os.tmpdir(), "hivra-geo-routes-"));
    runStageScript(`stage.stageLitepaper({ repoRoot: ${JSON.stringify(REPO)}, dashboardRoot: ${JSON.stringify(dashboardRoot)} });`);
  });
  afterAll(() => rmSync(dashboardRoot, { recursive: true, force: true }));
  beforeEach(() => {
    cwd = jest.spyOn(process, "cwd").mockReturnValue(dashboardRoot);
  });
  afterEach(() => cwd.mockRestore());

  it("runs against the real country list", () => {
    expect(BLOCKED_COUNTRIES).toContain("GB");
  });

  describe("the real handlers", () => {
    it.each(stage.GEO_DOCUMENTS)("$route: a viewer in a listed country gets the token-free copy, byte for byte", async ({ route, restricted }) => {
      const response = await call(route, "GB");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(source(restricted));
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });

    it.each(stage.GEO_DOCUMENTS)("$route: any other viewer still gets the full document, byte for byte", async ({ route, full }) => {
      for (const country of ["US", "FR", "XX", undefined]) {
        const response = await call(route, country);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(source(full));
        expect(response.headers.get("cache-control")).toBe("private, no-store");
      }
    });

    it("gives a listed country no token word, except in the one-line notice that says why", async () => {
      for (const { route } of stage.GEO_DOCUMENTS) {
        const text = await (await call(route, "GB")).text();
        if (route === "/TOKENOMICS.md") expect(text).toContain("aren't available");
        else expect(text).not.toMatch(/\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b/i);
      }
    });
  });

  describe("every spelling of the address", () => {
    const variants = encodedVariants();

    it("covers the variants confirmed live and every one-character encoding", () => {
      expect(variants.length).toBeGreaterThan(Object.keys(HANDLERS).join("").length);
      for (const confirmed of ["/LITEPAPER%2Emd", "/%4CITEPAPER.md", "/docs/litepaper/%69ndex.html", "/docs%2Flitepaper%2Findex.html"]) {
        expect(variants).toContain(confirmed);
      }
    });

    it("none of them names a file in public/, so none can be served as a static file", () => {
      for (const variant of variants) {
        const decoded = decodedPath(variant);
        expect(decoded).not.toBeNull();
        expect(existsSync(path.join(dashboardRoot, "public", decoded as string))).toBe(false);
      }
    });

    it("each one that decodes to a document reaches its handler, and a listed country gets the token-free copy", async () => {
      let reached = 0;
      for (const variant of variants) {
        const decoded = decodedPath(variant) as string;
        if (!HANDLERS[decoded]) continue;
        reached += 1;
        const document = stage.GEO_DOCUMENTS.find(({ route }) => route === decoded)!;
        expect(await (await call(decoded, "GB")).text()).toBe(source(document.restricted));
        expect(await (await call(decoded, "US")).text()).toBe(source(document.full));
      }
      expect(reached).toBeGreaterThan(0);
    });
  });

  describe("fail closed", () => {
    it("stages no full document into public/, and the four handlers are the only way to reach one", () => {
      for (const relative of stage.FORBIDDEN_PUBLIC_PATHS) {
        expect(existsSync(path.join(dashboardRoot, "public", relative))).toBe(false);
      }
      for (const { name } of stage.GEO_DOCUMENTS) {
        expect(existsSync(path.join(dashboardRoot, GEO_DOCUMENTS_DIRECTORY, "full", name))).toBe(true);
        expect(existsSync(path.join(dashboardRoot, GEO_DOCUMENTS_DIRECTORY, "restricted", name))).toBe(true);
      }
    });

    it("keeps the token-free copies and the litepaper assets public", () => {
      for (const relative of [
        "restricted/LITEPAPER.md", "restricted/WHITEPAPER.md", "restricted/TOKENOMICS.md",
        "docs/litepaper/restricted.html", "docs/litepaper/litepaper.css", "docs/litepaper/litepaper.js",
        "docs/litepaper/assets/agent-computer-hero-v2.png", "THOUGHTS.md",
      ]) {
        expect(existsSync(path.join(dashboardRoot, "public", relative))).toBe(true);
      }
    });

    it("the checked-out public/ holds no full document under any name (run node scripts/stage-litepaper.mjs if this fails)", () => {
      const fullDocuments = stage.GEO_DOCUMENTS.map(({ full }) => {
        const bytes = readFileSync(path.join(REPO, full));
        return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      });
      const publicRoot = path.join(DASHBOARD, "public");
      const found: string[] = [];
      const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) walk(file);
          else if (entry.isFile()) {
            const relative = path.relative(publicRoot, file).split(path.sep).join("/");
            const candidates = fullDocuments.filter(({ size }) => size === statSync(file).size);
            const sha256 = candidates.length ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
            if (stage.FORBIDDEN_PUBLIC_PATHS.includes(relative) || candidates.some((candidate) => candidate.sha256 === sha256)) {
              found.push(relative);
            }
          }
        }
      };
      walk(publicRoot);
      expect(found).toEqual([]);
    });
  });

  describe("wiring", () => {
    it("the stage script and the handlers name the same four documents in the same directory", () => {
      expect(stage.GEO_DOCUMENTS_DIRECTORY).toBe(GEO_DOCUMENTS_DIRECTORY);
      expect(Object.fromEntries(stage.GEO_DOCUMENTS.map(({ name, route }) => [name, route]))).toEqual(
        Object.fromEntries(Object.entries(TOKEN_GEO_DOCUMENTS).map(([name, { route }]) => [name, route])),
      );
    });

    it.each(stage.GEO_DOCUMENTS)("$route has a dynamic route file that asks for its own document", ({ name, route }) => {
      const file = path.join(DASHBOARD, "src/app", route, "route.ts");
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toContain(`serveTokenGeoDocument(request, "${name}")`);
      expect(text).toContain('export const dynamic = "force-dynamic"');
    });

    it.each(stage.GEO_DOCUMENTS)("$route carries both copies into its serverless function", ({ name, route }) => {
      const includes = (nextConfig.outputFileTracingIncludes ?? {})[route];
      expect(includes).toEqual([
        `./${GEO_DOCUMENTS_DIRECTORY}/full/${name}`,
        `./${GEO_DOCUMENTS_DIRECTORY}/restricted/${name}`,
      ]);
      for (const include of includes as string[]) {
        expect(existsSync(path.join(dashboardRoot, include))).toBe(true);
      }
    });

    it("no longer rewrites the documents by path, which is what the encoded spellings got around", async () => {
      const rewrites = (await nextConfig.rewrites?.()) as { beforeFiles?: unknown[] } | unknown[];
      const beforeFiles = Array.isArray(rewrites) ? [] : rewrites.beforeFiles ?? [];
      expect(beforeFiles).toEqual([]);
    });

    it("keeps the /docs/litepaper redirect to the page", async () => {
      const redirects = await nextConfig.redirects?.();
      expect(redirects).toContainEqual({ source: "/docs/litepaper", destination: "/docs/litepaper/index.html", permanent: false });
    });
  });
});
