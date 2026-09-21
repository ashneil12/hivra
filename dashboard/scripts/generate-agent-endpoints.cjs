#!/usr/bin/env node
/**
 * Regenerate src/lib/webui/agent-endpoints.json — the route table of the agent
 * pinned upstream agent image. The dashboard's WebUIClient may only call
 * routes in this manifest; the agent-endpoint-contract jest guard enforces it.
 *
 * WHY A MANUAL CAPTURE STEP: the manifest must reflect the DEPLOYED image
 * (ghcr.io/ashneil12/vanilla-hermes-agent:stable), not a local checkout of the
 * agent repo, which can drift ahead of what the fleet runs. There is no way to
 * derive it offline, so this script parses a raw route dump you capture from a
 * live box. CI never runs this — it only consumes the committed JSON.
 *
 * ── HOW TO RE-CAPTURE (against any running instance) ─────────────────────────
 *   1. Pick a running instance id + its pve host (Supabase hermes_instances:
 *      proxmox_node, proxmox_vmid). Get the pve public IP from prod env
 *      PROXMOX_PVE<N>_PUBLIC_IP.
 *   2. Dump the registered routes straight out of the official-dashboard
 *      container (no auth, no HTTP — reads the source in the image):
 *
 *      ssh -i /path/to/proxmox-admin-key root@<pve-ip> \
 *        "qm guest exec <vmid> --timeout 40 -- /bin/bash -c \
 *         'docker exec agent-<id>-official-dashboard grep -oE \
 *          \"^@app\\\\.(get|post|put|delete|patch)\\\\(\\\"[^\\\"]+\\\"\" \
 *          /opt/hermes/hermes_cli/web_server.py'" \
 *        | node -e 'process.stdin.resume();let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s.slice(s.indexOf(\"{\")));process.stdout.write(j[\"out-data\"]||\"\")})' \
 *        > /tmp/agent-routes.raw
 *
 *   3. node dashboard/scripts/generate-agent-endpoints.cjs \
 *        --image ghcr.io/ashneil12/vanilla-hermes-agent:stable \
 *        --agent-version <from GET /api/status> \
 *        --instance <id> < /tmp/agent-routes.raw
 *
 * Input on stdin is either the raw `@app.<verb>("<path>")` decorator lines or
 * pre-parsed `METHOD /path` lines — both are accepted.
 *
 * The one reliable proof a path is UNREGISTERED is the live body
 * {"detail":"No such API endpoint: <path>"}; anything else (e.g. a 422 missing
 * FastAPI param) means the route exists. See the guard's header.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "src", "lib", "webui", "agent-endpoints.json");
const DECORATOR = /^@app\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/;
const PREPARSED = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)$/i;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parse(raw) {
  const routes = [];
  const seen = new Set();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let method;
    let routePath;
    const dec = DECORATOR.exec(t);
    if (dec) {
      method = dec[1].toUpperCase();
      routePath = dec[2];
    } else {
      const pre = PREPARSED.exec(t);
      if (!pre) continue;
      method = pre[1].toUpperCase();
      routePath = pre[2];
    }
    const key = `${method} ${routePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method, path: routePath });
  }
  routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return routes;
}

function main() {
  const raw = fs.readFileSync(0, "utf8");
  const routes = parse(raw);
  if (routes.length < 150) {
    console.error(
      `Refusing to write: parsed only ${routes.length} routes (expected 150+).\n` +
        `Did the capture pipe the raw @app decorator lines? First bytes:\n` +
        raw.slice(0, 200),
    );
    process.exit(1);
  }

  const doc = {
    $comment: [
      "Route table of the pinned upstream agent image. This is the ONLY HTTP surface a",
      "dashboard instance route may call. Anything absent here 404s with",
      '{"detail":"No such API endpoint: <path>"} because hermes_cli/web_server.py serves an',
      "/api/* -aware SPA catch-all (serve_spa).",
      "",
      "Regenerate with: node dashboard/scripts/generate-agent-endpoints.cjs (see script header).",
      "Enforced by dashboard/src/lib/webui/__tests__/agent-endpoint-contract.test.ts.",
    ],
    provenance: {
      capturedAt: arg("--captured-at", new Date().toISOString().slice(0, 10)),
      image: arg("--image", "ghcr.io/ashneil12/vanilla-hermes-agent:stable"),
      agentVersion: arg("--agent-version", "unknown"),
      source:
        "docker exec agent-<id>-official-dashboard grep -oE '^@app\\.(get|post|put|delete|patch)(\"[^\"]+\")' /opt/hermes/hermes_cli/web_server.py",
      probedInstance: arg("--instance", "unknown"),
      routeCount: routes.length,
    },
    routes,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(`Wrote ${path.relative(path.join(__dirname, ".."), OUT)} with ${routes.length} routes.`);
}

main();
