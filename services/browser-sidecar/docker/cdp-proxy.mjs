// CDP host-header-fixing proxy + Chrome supervisor for the browser-sidecar
// "CDP mode". This is what makes the sidecar a *regular Chrome the agent drives
// over the Chrome DevTools Protocol* instead of the bespoke Playwright HTTP
// tool surface.
//
// Why this exists: Chrome's DevTools HTTP endpoints reject any request whose
// `Host` header isn't an IP literal or `localhost` (DNS-rebinding protection),
// and the `webSocketDebuggerUrl` it returns in /json/version echoes that host.
// So the hermes-agent — which lives in a sibling container and connects via the
// docker service name `agent-<id>-browser-sidecar:9222` — can't talk to Chrome
// directly. This proxy:
//   1. listens on 0.0.0.0:9222 (reachable cross-container by service name),
//   2. forwards to Chrome on 127.0.0.1:9221 with `Host: localhost` (accepted),
//   3. rewrites the host inside /json* responses back to the caller's own Host,
//      so the agent receives a connectable `webSocketDebuggerUrl`,
//   4. transparently tunnels the /devtools/* WebSocket upgrade.
// It also spawns and supervises (respawns) the headful Chrome itself, so the
// container has a single owner for the browser lifecycle.

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

// Two-port contract (matches the dashboard's webui-instance-builder):
//   AGENT_CDP_PORT       — Chrome's own remote-debugging port (127.0.0.1 only).
//   AGENT_CDP_PROXY_PORT — the public host-header-fixing proxy the agent hits
//                          (BROWSER_CDP_URL points here). Bound 0.0.0.0.
const LISTEN_PORT = Number(process.env.AGENT_CDP_PROXY_PORT || 9224);
const CHROME_PORT = Number(process.env.AGENT_CDP_PORT || 9223);
const CHROME_HOST = "127.0.0.1";
const USER_DATA_DIR =
  process.env.CDP_USER_DATA_DIR || "/var/lib/hermes-browser/profiles/cdp";
const SCREEN = process.env.CDP_WINDOW_SIZE || "1280,800";

// Bound the on-disk footprint of the persistent profile. By default Chrome's
// HTTP disk cache under USER_DATA_DIR grows unbounded — on long-lived,
// heavy-browsing tenants it balloons the mounted `browser-state` volume to
// 10GB+, fills the 29GB VM disk, and turns the next image pull into a
// partial-extract crash-loop (exec entrypoint.sh -> exit 127). Two bounds:
//   1. --disk-cache-size caps the main HTTP cache WHILE Chrome runs.
//   2. pruneProfileCache() drops the remaining rebuildable caches on each
//      (re)launch (Chrome is dead then, so deletion is safe), bounding
//      cumulative growth across restarts/redeploys.
// Persistent profile data (cookies/logins/IndexedDB) is left intact; Chrome
// rebuilds the caches on demand. See finding_browser_sidecar_bloat_root_cause.
const DISK_CACHE_BYTES = Number(process.env.CDP_DISK_CACHE_MB || 256) * 1024 * 1024;
// Rebuildable cache directories Chrome writes under the user-data-dir (top
// level) and under Default/. --disk-cache-size only bounds the first ("Cache").
const CACHE_SUBDIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "component_crx_cache",
];

function log(...args) {
  // eslint-disable-next-line no-console
  console.log("[cdp-proxy]", ...args);
}

// ── Chrome supervisor ──────────────────────────────────────────────────────
let chromeProc = null;

// The user-data-dir lives on a persistent volume, so a previous container's
// Chrome leaves SingletonLock/Cookie/Socket behind. A fresh container has a new
// hostname, so Chrome sees the stale lock as "profile in use on another
// computer" and exits (code 21) in a relaunch loop. The prior Chrome is always
// dead by the time we (re)launch, so clearing these is safe.
function clearProfileLocks() {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      rmSync(join(USER_DATA_DIR, name), { force: true, recursive: true });
    } catch {
      /* best-effort */
    }
  }
}

// Drop rebuildable Chrome cache dirs that --disk-cache-size does not bound
// (GPU/shader/service-worker caches, the Default/ HTTP cache, etc.). Runs only
// while Chrome is dead (each (re)launch), so deletion is safe. Persistent
// profile state (cookies/logins/IndexedDB/Local Storage) is untouched.
function pruneProfileCache() {
  const roots = [USER_DATA_DIR, join(USER_DATA_DIR, "Default")];
  for (const root of roots) {
    for (const name of CACHE_SUBDIRS) {
      try {
        rmSync(join(root, name), { force: true, recursive: true });
      } catch {
        /* best-effort */
      }
    }
    // Service Worker caches live one level deeper than the names above.
    for (const name of ["CacheStorage", "ScriptCache"]) {
      try {
        rmSync(join(root, "Service Worker", name), { force: true, recursive: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

function launchChrome() {
  let exe;
  try {
    exe = chromium.executablePath();
  } catch (err) {
    log("could not resolve chromium executable; retrying in 2s:", String(err));
    setTimeout(launchChrome, 2000);
    return;
  }
  clearProfileLocks();
  pruneProfileCache();
  const args = [
    `--remote-debugging-port=${CHROME_PORT}`,
    `--remote-debugging-address=${CHROME_HOST}`,
    // Allow CDP clients from any origin (the agent + the proxy). Without this,
    // Chrome >=111 rejects the WebSocket upgrade with a 403 on the Origin check.
    "--remote-allow-origins=*",
    `--user-data-dir=${USER_DATA_DIR}`,
    // Cap the HTTP disk cache so a long-lived session can't grow the
    // browser-state volume unbounded. See note at DISK_CACHE_BYTES.
    `--disk-cache-size=${DISK_CACHE_BYTES}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    `--window-size=${SCREEN}`,
    "--window-position=0,0",
    "about:blank",
  ];
  log("launching chrome:", exe);
  chromeProc = spawn(exe, args, { stdio: "inherit", env: process.env });
  chromeProc.on("exit", (code, sig) => {
    log(`chrome exited (code=${code} sig=${sig}); relaunching in 1s`);
    chromeProc = null;
    setTimeout(launchChrome, 1000);
  });
  chromeProc.on("error", (err) => {
    log("chrome spawn error:", String(err));
  });
}

// ── HTTP proxy (with /json host rewrite) ───────────────────────────────────
const server = http.createServer((creq, cres) => {
  const incomingHost = creq.headers.host || `localhost:${LISTEN_PORT}`;
  const isJson = (creq.url || "").startsWith("/json");

  const upstream = http.request(
    {
      host: CHROME_HOST,
      port: CHROME_PORT,
      method: creq.method,
      path: creq.url,
      headers: { ...creq.headers, host: `${CHROME_HOST}:${CHROME_PORT}` },
    },
    (pres) => {
      if (!isJson) {
        cres.writeHead(pres.statusCode || 200, pres.headers);
        pres.pipe(cres);
        return;
      }
      // Buffer + rewrite the discovery JSON so webSocketDebuggerUrl points at
      // a host the agent can actually reach.
      let body = "";
      pres.setEncoding("utf8");
      pres.on("data", (chunk) => (body += chunk));
      pres.on("end", () => {
        const rewritten = body
          .split(`${CHROME_HOST}:${CHROME_PORT}`)
          .join(incomingHost)
          .split(`localhost:${CHROME_PORT}`)
          .join(incomingHost);
        const headers = { ...pres.headers };
        delete headers["content-length"];
        cres.writeHead(pres.statusCode || 200, headers);
        cres.end(rewritten);
      });
    },
  );
  upstream.on("error", (err) => {
    if (!cres.headersSent) cres.writeHead(502, { "content-type": "text/plain" });
    cres.end(`cdp-proxy upstream error: ${String(err)}`);
  });
  creq.pipe(upstream);
});

// ── WebSocket upgrade passthrough ──────────────────────────────────────────
server.on("upgrade", (creq, csock, head) => {
  const usock = net.connect(CHROME_PORT, CHROME_HOST, () => {
    const headers = { ...creq.headers, host: `${CHROME_HOST}:${CHROME_PORT}` };
    let raw = `${creq.method} ${creq.url} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const v of value) raw += `${key}: ${v}\r\n`;
      } else {
        raw += `${key}: ${value}\r\n`;
      }
    }
    raw += "\r\n";
    usock.write(raw);
    if (head && head.length) usock.write(head);
    csock.pipe(usock);
    usock.pipe(csock);
  });
  usock.on("error", () => csock.destroy());
  csock.on("error", () => usock.destroy());
});

server.listen(LISTEN_PORT, "0.0.0.0", () =>
  log(`listening on :${LISTEN_PORT} -> ${CHROME_HOST}:${CHROME_PORT}`),
);

launchChrome();
