import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const caddyfilePath = join(here, "..", "caddy", "Caddyfile");

// No Caddy binary runs in the test environment, so these helpers model the two
// matcher behaviours the gate relies on: a `path` pattern is exact unless it
// ends in "*", and a `header` pattern treats "*" as a wildcard.
function caddyPathMatches(pattern: string, path: string): boolean {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

function caddyHeaderMatches(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`, "i").test(value);
}

function gatedPathPatterns(caddyfile: string): string[] {
  const line = caddyfile.match(/^\t@gated path (.+)$/m)?.[1] ?? "";
  return line.trim().split(/\s+/).filter(Boolean);
}

function wsUpgradeMatcher(caddyfile: string) {
  const block = caddyfile.match(/\t@wsupgrade \{\n([\s\S]*?)\n\t\}/)?.[1] ?? "";
  return {
    path: block.match(/^\t\tpath (\S+)$/m)?.[1],
    connection: block.match(/^\t\theader Connection (\S+)$/m)?.[1],
    upgrade: block.match(/^\t\theader Upgrade (\S+)$/m)?.[1],
  };
}

function requiresSignedUrl(caddyfile: string, req: { path: string; websocket?: boolean }): boolean {
  if (gatedPathPatterns(caddyfile).some((pattern) => caddyPathMatches(pattern, req.path))) {
    return true;
  }
  const ws = wsUpgradeMatcher(caddyfile);
  return Boolean(
    req.websocket &&
      ws.path &&
      ws.connection &&
      ws.upgrade &&
      caddyPathMatches(ws.path, req.path) &&
      caddyHeaderMatches(ws.connection, "Upgrade") &&
      caddyHeaderMatches(ws.upgrade, "websocket"),
  );
}

describe("browser-sidecar Caddyfile", () => {
  it("allows dashboard-hosted noVNC viewers to import static noVNC modules", () => {
    const caddyfile = readFileSync(caddyfilePath, "utf8");
    const staticAssetsBlock = caddyfile.match(
      /handle_path \/browser-sidecar\/novnc\/\* \{[\s\S]*?\n\t\}/
    )?.[0] || "";

    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Origin "*"');
    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Methods "GET, OPTIONS"');
    expect(staticAssetsBlock).toContain('header Access-Control-Allow-Headers "Content-Type"');
  });

  describe("noVNC signed-URL gate", () => {
    const caddyfile = readFileSync(caddyfilePath, "utf8");

    it.each([
      "/browser-sidecar/novnc/vnc.html",
      "/browser-sidecar/novnc/vnc.html/",
      "/browser-sidecar/novnc/websockify",
      "/browser-sidecar/novnc/websockify/",
    ])("requires the signed URL for %s, with or without a trailing slash", (path) => {
      expect(requiresSignedUrl(caddyfile, { path })).toBe(true);
    });

    it.each([
      "/browser-sidecar/novnc/websockify",
      "/browser-sidecar/novnc/websockify/",
      "/browser-sidecar/novnc/core/rfb.js",
    ])("requires the signed URL for a websocket upgrade to %s", (path) => {
      expect(requiresSignedUrl(caddyfile, { path, websocket: true })).toBe(true);
    });

    it.each([
      "/browser-sidecar/novnc/core/rfb.js",
      "/browser-sidecar/novnc/app/ui.js",
      "/browser-sidecar/novnc/vendor/pako/pako_inflate.js",
    ])("leaves plain static noVNC asset %s public", (path) => {
      expect(requiresSignedUrl(caddyfile, { path })).toBe(false);
    });

    it("runs the same forward_auth check on every gated handle", () => {
      const gate = caddyfile.match(/^\(novnc_gate\) \{\n([\s\S]*?)\n\}/m)?.[1] ?? "";
      expect(gate).toContain("forward_auth localhost:8789");
      expect(gate).toContain("uri /internal/verify-novnc-url");
      expect(gate).toContain("reverse_proxy localhost:6080");

      for (const matcher of ["@gated", "@wsupgrade"]) {
        const handle = caddyfile.match(new RegExp(`handle ${matcher} \\{([\\s\\S]*?)\\n\\t\\}`))?.[1] ?? "";
        expect(handle).toContain("import novnc_gate");
      }
    });

    it("keeps forward_auth off the public static block", () => {
      const staticAssetsBlock = caddyfile.match(
        /handle_path \/browser-sidecar\/novnc\/\* \{[\s\S]*?\n\t\}/
      )?.[0] || "";
      expect(staticAssetsBlock).not.toContain("forward_auth");
    });
  });
});
