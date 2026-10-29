import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const caddyfilePath = join(here, "..", "caddy", "Caddyfile");
const caddyfile = readFileSync(caddyfilePath, "utf8");

// No Caddy binary runs in the test environment, so this model reads the
// Caddyfile's own matchers and handles and applies Caddy's matching rules:
//   - path: exact unless the pattern ends in "*"; several patterns are OR-ed.
//   - method: exact.
//   - header <field> <value>: case-sensitive, "*" is a wildcard.
//   - header_regexp <field> <regex>: Go RE2, case-sensitive unless the regex
//     starts with (?i).
//   - a named matcher is the AND of its lines; handles are checked in source
//     order and the first matching handle decides.

type Action = "gate" | "respond" | "public" | "none";
type Req = { method?: string; path: string; headers?: Record<string, string> };
type MatcherLine = { kind: "path" | "method" | "header" | "header_regexp"; args: string[] };
type Handle = { target: string; body: string };

function tokens(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

function namedMatchers(source: string): Map<string, MatcherLine[]> {
  const matchers = new Map<string, MatcherLine[]>();
  for (const match of source.matchAll(/^\t@(\w+) (path|method|header_regexp|header) (.+)$/gm)) {
    matchers.set(match[1], [{ kind: match[2] as MatcherLine["kind"], args: tokens(match[3]) }]);
  }
  for (const match of source.matchAll(/^\t@(\w+) \{\n([\s\S]*?)\n\t\}$/gm)) {
    const lines = match[2]
      .split("\n")
      .map((line) => tokens(line.trim()))
      .filter((parts) => parts.length > 0)
      .map(([kind, ...args]) => ({ kind: kind as MatcherLine["kind"], args }));
    matchers.set(match[1], lines);
  }
  return matchers;
}

function siteHandles(source: string): Handle[] {
  return [...source.matchAll(/^\thandle(?:_path)? (\S+) \{\n([\s\S]*?)\n\t\}$/gm)].map((match) => ({
    target: match[1],
    body: match[2],
  }));
}

function pathPatternMatches(pattern: string, path: string): boolean {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(value);
}

function goRegexpMatches(pattern: string, value: string): boolean {
  const caseInsensitive = pattern.startsWith("(?i)");
  return new RegExp(caseInsensitive ? pattern.slice(4) : pattern, caseInsensitive ? "i" : "").test(value);
}

function headerValue(req: Req, field: string): string | undefined {
  const wanted = field.toLowerCase();
  return Object.entries(req.headers ?? {}).find(([name]) => name.toLowerCase() === wanted)?.[1];
}

function lineMatches(line: MatcherLine, req: Req): boolean {
  if (line.kind === "path") return line.args.some((pattern) => pathPatternMatches(pattern, req.path));
  if (line.kind === "method") return line.args.includes(req.method ?? "GET");
  const value = headerValue(req, line.args[0]);
  if (value === undefined) return false;
  return line.kind === "header"
    ? wildcardMatches(line.args[1], value)
    : goRegexpMatches(line.args[1], value);
}

function routeAction(source: string, req: Req): Action {
  const matchers = namedMatchers(source);
  for (const handle of siteHandles(source)) {
    if (handle.target.startsWith("/")) {
      if (pathPatternMatches(handle.target, req.path)) return "public";
      continue;
    }
    const lines = matchers.get(handle.target.replace(/^@/, ""));
    if (!lines || !lines.every((line) => lineMatches(line, req))) continue;
    if (handle.body.includes("import novnc_gate")) return "gate";
    if (/\brespond\b/.test(handle.body)) return "respond";
    return "public";
  }
  return "none";
}

const upgradeHeaders = [
  { Connection: "Upgrade", Upgrade: "websocket" },
  { Connection: "Upgrade", Upgrade: "WebSocket" },
  { Connection: "upgrade", Upgrade: "websocket" },
  { Connection: "UPGRADE", Upgrade: "WEBSOCKET" },
  { Connection: "keep-alive, Upgrade", Upgrade: "websocket" },
];

describe("browser-sidecar Caddyfile", () => {
  it("allows dashboard-hosted noVNC viewers to import static noVNC modules", () => {
    const staticAssetsBlock = caddyfile.match(
      /handle_path \/browser-sidecar\/novnc\/\* \{[\s\S]*?\n\t\}/
    )?.[0] || "";

    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Origin "*"');
    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Methods "GET, OPTIONS"');
    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Headers "Content-Type"');
  });

  describe("noVNC signed-URL gate", () => {
    it.each([
      "/browser-sidecar/novnc/vnc.html",
      "/browser-sidecar/novnc/vnc.html/",
      "/browser-sidecar/novnc/websockify",
      "/browser-sidecar/novnc/websockify/",
    ])("requires the signed URL for %s, with or without a trailing slash", (path) => {
      expect(routeAction(caddyfile, { path })).toBe("gate");
    });

    it.each([
      "/browser-sidecar/novnc/websockify",
      "/browser-sidecar/novnc/websockify/",
      "/browser-sidecar/novnc/core/rfb.js",
    ])("requires the signed URL for a websocket upgrade to %s", (path) => {
      expect(
        routeAction(caddyfile, { path, headers: { Connection: "Upgrade", Upgrade: "websocket" } }),
      ).toBe("gate");
    });

    // core/rfb.js is not a gated path, so these cases can only pass through the
    // upgrade-header matchers.
    it.each(upgradeHeaders)(
      "requires the signed URL for an upgrade whatever the header case: %o",
      (headers) => {
        expect(routeAction(caddyfile, { path: "/browser-sidecar/novnc/core/rfb.js", headers })).toBe("gate");
      },
    );

    it("requires the signed URL when only an Upgrade header is present", () => {
      expect(
        routeAction(caddyfile, { path: "/browser-sidecar/novnc/core/rfb.js", headers: { Upgrade: "WebSocket" } }),
      ).toBe("gate");
    });

    it.each([
      "/browser-sidecar/novnc/core/rfb.js",
      "/browser-sidecar/novnc/app/ui.js",
      "/browser-sidecar/novnc/vendor/pako/pako_inflate.js",
    ])("leaves plain static noVNC asset %s public", (path) => {
      expect(routeAction(caddyfile, { path })).toBe("public");
      expect(routeAction(caddyfile, { path, headers: { Connection: "keep-alive" } })).toBe("public");
    });

    it("runs the same forward_auth check on every gated handle", () => {
      const gate = caddyfile.match(/^\(novnc_gate\) \{\n([\s\S]*?)\n\}/m)?.[1] ?? "";
      expect(gate).toContain("forward_auth localhost:8789");
      expect(gate).toContain("uri /internal/verify-novnc-url");
      expect(gate).toContain("reverse_proxy localhost:6080");

      const gateHandles = siteHandles(caddyfile).filter((handle) => handle.body.includes("import novnc_gate"));
      expect(gateHandles.map((handle) => handle.target)).toEqual(
        expect.arrayContaining(["@gated", "@wsupgrade", "@upgradehdr"]),
      );
    });

    it("keeps forward_auth off the public static block", () => {
      const staticAssetsBlock = caddyfile.match(
        /handle_path \/browser-sidecar\/novnc\/\* \{[\s\S]*?\n\t\}/
      )?.[0] || "";
      expect(staticAssetsBlock).not.toContain("forward_auth");
    });
  });
});
