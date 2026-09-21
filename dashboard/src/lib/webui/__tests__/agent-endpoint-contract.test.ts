/**
 * Contract guard: the dashboard may only call HTTP endpoints the agent image
 * actually serves.
 *
 * WHY THIS EXISTS
 * ---------------
 * `client.ts` was written against the legacy `hermes-webui` HTTP server. The
 * fleet no longer runs it. Every bearer-authed `/api/*` request now lands on
 * the agent's own dashboard (`hermes_cli/web_server.py`), whose `serve_spa`
 * catch-all answers any unregistered `/api/*` path with
 *
 *     404 {"detail":"No such API endpoint: <path>"}
 *
 * Routes that call those paths fail — usually SOFT, swallowed into an empty
 * value, so a feature silently never works and nobody notices for months.
 * That produced the send-stream retirement (prod #529), the approval/clarify
 * retirement (prod #532), and the sweep this guard ships with.
 *
 * WHAT IT ENFORCES
 * ----------------
 *  1. Every path `client.ts` requests is statically extractable (a literal or
 *     template). A path assembled at runtime is invisible to this guard, so it
 *     is a hard failure.
 *  2. Every extracted (method, path) exists in `agent-endpoints.json` — the
 *     route table of the image the fleet runs — unless the method is declared
 *     LEGACY_WEBUI_DEV_ONLY.
 *  3. LEGACY_WEBUI_DEV_ONLY methods are never called from fleet code. Since
 *     the `/api/webui-dev/*` ops harness was deleted (2026-07-10), the set is
 *     down to the client's internal cookie-fallback `login`.
 *  4. Any remaining fleet call site targeting a dead endpoint is enumerated in
 *     KNOWN_DEAD_CALL_SITES. That list is a RATCHET: adding an entry requires
 *     a deliberate edit here, and a stale entry (one that has been fixed) also
 *     fails, so the list can only shrink.
 *
 * Regenerate the manifest with `node scripts/generate-agent-endpoints.cjs`.
 */
import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import manifest from "../agent-endpoints.json";

const WEBUI_DIR = path.join(__dirname, "..");
const SRC_DIR = path.join(WEBUI_DIR, "..", "..");
const CLIENT_PATH = path.join(WEBUI_DIR, "client.ts");

/** Helpers on WebUIClient that perform an HTTP request against the agent. */
const REQUEST_HELPERS = new Set(["fetchJson", "fetchWithAuthPath", "fetchFormJson", "urlsForPath"]);

/**
 * Methods that legitimately target the LEGACY hermes-webui contract. The
 * `/api/webui-dev/*` ops harness that exercised the rest of this set was
 * deleted 2026-07-10 together with its methods (getSession/newSession/
 * startChat/streamChat/pendingApproval/respondApproval). `login` remains:
 * it is the client's own internal cookie fallback inside the 401-recovery
 * path, never a fleet call site.
 */
const LEGACY_WEBUI_DEV_ONLY = new Set([
  "login", // POST /api/auth/login — cookie fallback; the fleet uses bearer auth
]);

/**
 * RATCHET. Fleet call sites that still target an endpoint the agent image does
 * not serve. Each would be a real defect. This list is now EMPTY — the whole
 * dead-endpoint class has been retired:
 *   - send-stream (#529), approval/clarify (#532), responses-proxy (#531)
 *   - the read routes runtime/models/projects/workspaces/capabilities + chat-sessions
 *   - the activity digest repaired (health() -> /api/status)
 *   - the Vault live-push (route.ts) + memory/skills write routes
 *   - the ProfileService cluster: agent-config + profiles/[name] routes deleted,
 *     runtime-settings.ts removed (prod), the profiles/route.ts POST + the
 *     per-profile settings() enrichment removed (GET kept)
 * The two ratchet tests below now enforce ZERO dead fleet call sites: a NEW one
 * fails "no NEW", and this empty baseline can never go stale. Keep it empty.
 */
const KNOWN_DEAD_CALL_SITES: ReadonlyArray<{ file: string; method: string; why: string }> = [];

// ── manifest ──────────────────────────────────────────────────────────────
type Route = { method: string; path: string };
const ROUTES: Route[] = manifest.routes as Route[];

/**
 * Collapse a path to a comparable shape:
 *   - `${expr}` occupying a whole segment  -> `:p`   (a path parameter)
 *   - `${expr}` inside a segment           -> dropped (it can only add a suffix
 *                                             or query, e.g. `check${"?force=1"}`)
 *   - `{name}` / `{name:path}` (FastAPI)   -> `:p`
 *   - query string                          -> dropped
 */
const INTERP = "\u0001";

function canonicalize(rawPath: string): string {
  const beforeQuery = rawPath.split("?")[0];
  return beforeQuery
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (seg === INTERP) return ":p";
      if (seg.includes(INTERP)) return seg.split(INTERP).join("");
      if (/^\{.+\}$/.test(seg)) return ":p";
      return seg;
    })
    .join("/");
}

const MANIFEST_INDEX = new Set(ROUTES.map((r) => `${r.method} ${canonicalize(r.path)}`));
const MANIFEST_PATHS = new Set(ROUTES.map((r) => canonicalize(r.path)));

// ── static extraction from client.ts ──────────────────────────────────────
type Request = { clientMethod: string; httpMethod: string; rawPath: string; line: number };

// Marker returned when a request helper is handed a parameter of the enclosing
// function — i.e. the private transport layer (fetchJson/fetchFormJson/
// fetchWithAuthPath) forwarding its own `path` argument. That is plumbing, not
// an endpoint reference, so it is neither resolved nor flagged.
const PLUMBING = Symbol("plumbing");

function literalOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) out += INTERP + span.literal.text;
    return out;
  }
  return null;
}

type Scope = { params: Set<string>; consts: Map<string, string> };

/** Parameters + `const name = <literal|template>` bindings of one function. */
function scopeOf(fn: ts.Node): Scope {
  const decl = fn as ts.FunctionLikeDeclaration;
  const params = new Set<string>();
  for (const p of decl.parameters ?? []) if (ts.isIdentifier(p.name)) params.add(p.name.text);

  const consts = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    // Do not descend into nested functions — their scope is separate.
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const lit = literalOf(node.initializer);
      if (lit !== null && !consts.has(node.name.text)) consts.set(node.name.text, lit);
    }
    ts.forEachChild(node, visit);
  };
  if (decl.body) visit(decl.body);
  return { params, consts };
}

function resolveArg(arg: ts.Node | undefined, scope: Scope): string | null | typeof PLUMBING {
  if (!arg) return null;
  const lit = literalOf(arg);
  if (lit !== null) return lit;
  if (ts.isIdentifier(arg)) {
    if (scope.consts.has(arg.text)) return scope.consts.get(arg.text)!;
    if (scope.params.has(arg.text)) return PLUMBING;
  }
  return null;
}

function readHttpMethod(arg: ts.Node | undefined, fallback: string): string {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return fallback;
  for (const prop of arg.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      prop.name &&
      prop.name.getText() === "method" &&
      ts.isStringLiteral(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return fallback;
}

function extractRequests(): { requests: Request[]; unresolved: Array<{ clientMethod: string; line: number }> } {
  const text = fs.readFileSync(CLIENT_PATH, "utf8");
  const sf = ts.createSourceFile(CLIENT_PATH, text, ts.ScriptTarget.Latest, true);
  const requests: Request[] = [];
  const unresolved: Array<{ clientMethod: string; line: number }> = [];

  const walk = (node: ts.Node, enclosing: string, scope: Scope): void => {
    let current = enclosing;
    let currentScope = scope;
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) {
      current = node.name.getText(sf);
      currentScope = scopeOf(node);
    } else if (ts.isFunctionLike(node)) {
      currentScope = scopeOf(node);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      REQUEST_HELPERS.has(node.expression.name.text)
    ) {
      const helper = node.expression.name.text;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const resolved = resolveArg(node.arguments[0], currentScope);

      if (resolved === PLUMBING) {
        // transport-layer forward of a `path` parameter — ignore
      } else if (resolved === null) {
        unresolved.push({ clientMethod: current, line });
      } else if (helper === "urlsForPath") {
        requests.push({ clientMethod: current, httpMethod: "ANY", rawPath: resolved, line });
      } else {
        const optsArg = helper === "fetchFormJson" ? node.arguments[2] : node.arguments[1];
        const fallback = helper === "fetchFormJson" ? "POST" : "GET";
        requests.push({ clientMethod: current, httpMethod: readHttpMethod(optsArg, fallback), rawPath: resolved, line });
      }
    }

    ts.forEachChild(node, (child) => walk(child, current, currentScope));
  };

  walk(sf, "<module>", { params: new Set(), consts: new Map() });
  return { requests, unresolved };
}

function isServed(req: Request): boolean {
  const canon = canonicalize(req.rawPath);
  if (req.httpMethod === "ANY") return MANIFEST_PATHS.has(canon);
  return MANIFEST_INDEX.has(`${req.httpMethod} ${canon}`);
}

// ── fleet call-site scan ──────────────────────────────────────────────────
const FLEET_ROOTS = ["app/api/instances", "lib/webui", "lib/command-center"];
const EXCLUDED = [path.join("lib", "webui", "client.ts")];

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      walkFiles(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Matches `x.client.foo(`, `x.webuiClient.foo(`, `webui.foo(` — WebUIClient receivers. */
const RECEIVER_CALL = /(?:\.client|\.webuiClient|\bwebui)\.\s*(\w+)\s*\(/g;

function scanFleetCallSites(deadMethods: Set<string>): Array<{ file: string; method: string }> {
  const found: Array<{ file: string; method: string }> = [];
  for (const root of FLEET_ROOTS) {
    for (const file of walkFiles(path.join(SRC_DIR, root))) {
      const rel = path.relative(SRC_DIR, file);
      if (EXCLUDED.includes(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      RECEIVER_CALL.lastIndex = 0;
      let m: RegExpExecArray | null;
      const seen = new Set<string>();
      while ((m = RECEIVER_CALL.exec(text))) {
        const method = m[1];
        if (deadMethods.has(method) && !seen.has(method)) {
          seen.add(method);
          found.push({ file: rel.split(path.sep).join("/"), method });
        }
      }
    }
  }
  return found;
}

// ── tests ─────────────────────────────────────────────────────────────────
describe("agent endpoint contract", () => {
  const { requests, unresolved } = extractRequests();

  it("captures the manifest of the image the fleet runs", () => {
    expect(ROUTES.length).toBeGreaterThan(150);
    expect(MANIFEST_INDEX.has("GET /api/status")).toBe(true);
    // The canonical proof the guard is calibrated: /health is NOT a route.
    // It falls through to serve_spa and returns the HTML SPA shell.
    expect(MANIFEST_PATHS.has("/health")).toBe(false);
  });

  it("every path client.ts requests is statically analyzable", () => {
    const detail = unresolved.map((u) => `  ${u.clientMethod}() at client.ts:${u.line}`).join("\n");
    expect(
      unresolved.length === 0
        ? ""
        : `WebUIClient must pass request paths as inline literals or templates so the\n` +
            `endpoint contract can be checked at build time. Assembled-at-runtime paths:\n${detail}`,
    ).toBe("");
  });

  it("recognizes the live client methods as served (positive control)", () => {
    // These five (+ status) are the only client methods verified to return real
    // data from the pinned upstream image's reproducible route manifest. If
    // the canonicalizer or manifest matching regressed, they would stop
    // resolving and this positive control would fail — proving the guard's
    // "not served" verdicts are real, not an artifact of a broken matcher.
    const shouldBeServed = ["listSessions", "profiles", "memory", "skills", "skillContent", "status"];
    const notServed = requests
      .filter((r) => shouldBeServed.includes(r.clientMethod))
      .filter((r) => !isServed(r));
    const detail = notServed.map((r) => `  ${r.clientMethod}() -> ${r.httpMethod} ${r.rawPath}`).join("\n");
    expect(
      notServed.length === 0
        ? ""
        : `A method known to hit a live endpoint no longer resolves as served —\n` +
            `the manifest or canonicalizer is broken, so every "dead" verdict is suspect:\n${detail}`,
    ).toBe("");
    // And each of those methods must actually appear in client.ts (guards
    // against a rename silently emptying the positive control).
    const seen = new Set(requests.map((r) => r.clientMethod));
    expect(shouldBeServed.filter((m) => !seen.has(m))).toEqual([]);
  });

  it("legacy-contract methods are never called from fleet code", () => {
    const violations = scanFleetCallSites(LEGACY_WEBUI_DEV_ONLY);
    const detail = violations.map((v) => `  ${v.file} calls ${v.method}()`).join("\n");
    expect(
      violations.length === 0
        ? ""
        : `Fleet code must not call legacy hermes-webui methods — the fleet boxes 404.\n` +
            `These are internal-only (client cookie fallback).\n${detail}`,
    ).toBe("");
  });

  describe("dead-endpoint ratchet", () => {
    const deadMethods = new Set(
      requests.filter((r) => !LEGACY_WEBUI_DEV_ONLY.has(r.clientMethod) && !isServed(r)).map((r) => r.clientMethod),
    );
    // Methods still present on the client but only reachable through the
    // quarantined helpers below.
    const quarantined = new Set(KNOWN_DEAD_CALL_SITES.map((e) => e.method));
    const actual = scanFleetCallSites(new Set([...deadMethods, ...quarantined]));

    const key = (e: { file: string; method: string }) => `${e.file} :: ${e.method}`;
    const baseline = new Set(KNOWN_DEAD_CALL_SITES.map(key));
    const observed = new Set(actual.map(key));

    it("has no NEW fleet call site targeting a dead endpoint", () => {
      const added = [...observed].filter((k) => !baseline.has(k)).sort();
      expect(
        added.length === 0
          ? ""
          : `New call site(s) targeting an endpoint the agent does not serve:\n` +
              added.map((a) => `  ${a}`).join("\n") +
              `\n\nRepoint at a real route in agent-endpoints.json. Do NOT add to` +
              ` KNOWN_DEAD_CALL_SITES unless you are deliberately deferring a` +
              ` verified-broken write path.`,
      ).toBe("");
    });

    it("has no stale baseline entries (the ratchet only turns one way)", () => {
      const stale = [...baseline].filter((k) => !observed.has(k)).sort();
      expect(
        stale.length === 0
          ? ""
          : `KNOWN_DEAD_CALL_SITES lists call sites that no longer exist. Delete them:\n` +
              stale.map((s) => `  ${s}`).join("\n"),
      ).toBe("");
    });
  });
});
