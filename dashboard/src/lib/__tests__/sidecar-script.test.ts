import { Script } from "node:vm";

import {
  HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE,
  SIDECAR_SERVER_CODE,
  WEBUI_HANDOFF_APPENDAGE,
} from "@/lib/services/sidecar-script";

describe("sidecar script generation", () => {
  it("avoids raw shell parameter expansion inside a Node template literal", () => {
    expect(SIDECAR_SERVER_CODE).toMatch(
      /BASE_HOME=.*\+ '\$' \+ .*HERMES_HOME:-\/root\/\.hermes/,
    );
    expect(SIDECAR_SERVER_CODE).not.toContain('BASE_HOME="${HERMES_HOME:-/root/.hermes}"');
  });

  it("produces JavaScript that parses successfully", () => {
    expect(() => new Script(SIDECAR_SERVER_CODE)).not.toThrow();
  });

  it("produces trimmed Hetzner bootstrap JavaScript that parses successfully", () => {
    expect(() => new Script(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE)).not.toThrow();
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("webUITerminalProxyEnabled");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("proxyWebUITerminalStart");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("translateWebUITerminalSseEvent");
  });

  it("strips the Tailscale handlers + routes from the Hetzner bootstrap variant", () => {
    // Tailscale lives in the FULL sidecar (Proxmox / WebUI), but the Hetzner
    // bootstrap variant is shipped via cloud-init user_data with a hard
    // 32 KB ceiling. Including the handlers there would push real deploys
    // over the cap (see hetzner-instance-builders.test.ts).
    expect(SIDECAR_SERVER_CODE).toContain("/api/tailscale/up");
    expect(SIDECAR_SERVER_CODE).toContain("handleTailscaleUp");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("/api/tailscale");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("handleTailscaleUp");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("TAILSCALE_HANDLERS_START");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("TAILSCALE_ROUTES_START");
  });

  it("starts Tailscale without systemd when the sidecar runs in a container", () => {
    expect(SIDECAR_SERVER_CODE).toContain(
      "command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]"
    );
    expect(SIDECAR_SERVER_CODE).toContain("systemctl enable --now tailscaled");
    expect(SIDECAR_SERVER_CODE).toContain("nohup tailscaled");
    expect(SIDECAR_SERVER_CODE).toContain("--tun=userspace-networking");
    expect(SIDECAR_SERVER_CODE).toContain("/var/log/hermes-tailscaled.log");
    expect(SIDECAR_SERVER_CODE).toContain("tailscaled did not become ready");
    expect(SIDECAR_SERVER_CODE).toContain("pkill -x tailscaled");
  });

  it("strips generated image serving from the Hetzner bootstrap variant", () => {
    // Browser-renderable generated-image paths are a WebUI/Proxmox concern:
    // WebUI deploys concatenate the full sidecar with the WebUI appendage,
    // while Hetzner cloud-init must stay under the hard 32 KB user_data limit.
    expect(SIDECAR_SERVER_CODE).toContain("handleGeneratedImageRequest");
    expect(SIDECAR_SERVER_CODE).toContain("sidecar_generated_image_missing");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("handleGeneratedImageRequest");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("sidecar_generated_image_missing");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("DEFAULT_IMAGE_CACHE_ROOT");
  });

  it("strips the gated dashboard proxy from the Hetzner bootstrap variant", () => {
    // The basic-provider login + cookie/ws-ticket translation only serves
    // Proxmox/webfree deploys (which have an official-dashboard container behind
    // the sidecar). Legacy Hetzner agents are gateway-only and ship via the
    // 32 KB-capped cloud-init user_data, so the whole block is stripped there.
    expect(SIDECAR_SERVER_CODE).toContain("handleGatedDashboardRequest");
    expect(SIDECAR_SERVER_CODE).toContain("handleGatedDashboardWsUpgrade");
    expect(SIDECAR_SERVER_CODE).toContain("loginDashboardUpstream");
    expect(SIDECAR_SERVER_CODE).toContain("mintDashboardWsTicket");
    expect(SIDECAR_SERVER_CODE).toContain("/auth/password-login");
    expect(SIDECAR_SERVER_CODE).toContain("/api/auth/ws-ticket");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("handleGatedDashboardRequest");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("handleGatedDashboardWsUpgrade");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("loginDashboardUpstream");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("/auth/password-login");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("DASHBOARD_GATED_PROXY_START");
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).not.toContain("dashboardGatedProxyEnabled");
  });

  it("proxies the official dashboard console websocket through the gated sidecar", () => {
    const dashboardWsPaths = SIDECAR_SERVER_CODE.match(
      /const DASHBOARD_WS_PATHS = new Set\(\[[^\]]+\]\);/,
    )?.[0] ?? "";

    expect(dashboardWsPaths).toContain("'/api/console'");
  });

  it("allows slow Desktop bootstrap reads without weakening the normal dashboard wedge guard", () => {
    expect(SIDECAR_SERVER_CODE).toContain(
      "const DASHBOARD_UPSTREAM_PROBE_TIMEOUT_MS = 5 * 1000;",
    );
    expect(SIDECAR_SERVER_CODE).toContain(
      "probeReq.setTimeout(DASHBOARD_UPSTREAM_PROBE_TIMEOUT_MS",
    );
    expect(SIDECAR_SERVER_CODE).toContain(
      "const DASHBOARD_BOOTSTRAP_PROXY_TIMEOUT_MS = 12 * 1000;",
    );
    for (const pathname of ["/api/status", "/api/config", "/api/model/info", "/api/model/options"]) {
      expect(SIDECAR_SERVER_CODE).toContain(`'${pathname}'`);
    }
    expect(SIDECAR_SERVER_CODE).toContain(
      "const proxyTimeoutMs = dashboardProxyTimeoutMs(requestUrl);",
    );
    expect(SIDECAR_SERVER_CODE).toContain(
      "}, proxyTimeoutMs);",
    );
    expect(SIDECAR_SERVER_CODE).toContain(
      "proxyReq.setTimeout(proxyTimeoutMs",
    );
    expect(SIDECAR_SERVER_CODE).toContain(
      "const DASHBOARD_PROXY_TIMEOUT_MS = 2 * 1000;",
    );
  });

  it("keeps the surrounding code byte-stable after the Tailscale marker strip", () => {
    // The marker-block strip uses replacement "\n" instead of "" so the
    // bootstrap variant's byte layout matches what it would be without any
    // Tailscale markers at all. Even a 2-byte raw shift can perturb gzip's
    // dictionary enough to add 4-5 compressed bytes to the assembled
    // user_data and trip the Hetzner 32 KB cloud-init limit (this is the
    // exact regression that put main red after PR #114's initial merge —
    // hetzner-instance-builders.test.ts catches it downstream, this is
    // the upstream guard so the failure mode never resurfaces).
    //
    // Adjacent code blocks should be separated by a blank line, just like
    // they would be if the handlers were never inserted.
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).toMatch(
      /sendJson\(res, 200, \{ success: true \}\);\n\}\n\n\/\/ chat-stream-worker runtime removed;/,
    );
    expect(HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE).toMatch(
      /'\/api\/integrations'\) \{[\s\S]+?\n {6}return;\n {4}\}\n\n {4}if \(requestUrl\.pathname === '\/api\/terminal'\)/,
    );
  });

  it("escapes active gateway marker newlines inside generated JavaScript", () => {
    expect(SIDECAR_SERVER_CODE).toContain("fs.writeFileSync(markerPath, profileHome + '\\\\n', 'utf8')");
  });

  it("does not report canary shape-probe messaging tokens as configured integration keys", () => {
    expect(SIDECAR_SERVER_CODE).toContain("function isCanaryShapeProbeEnvLine(line)");
    expect(SIDECAR_SERVER_CODE).toContain("CANARY_SHAPE_PROBE");
    expect(SIDECAR_SERVER_CODE).toContain(".filter((line) => !isCanaryShapeProbeEnvLine(line))");
  });

  it("uses only built-in Node modules so the sidecar can boot without npm install", () => {
    expect(SIDECAR_SERVER_CODE).toContain("require('http')");
    expect(SIDECAR_SERVER_CODE).not.toContain("require('express')");
    expect(SIDECAR_SERVER_CODE).not.toContain("express.json");
  });

  it("restarts a sub-profile gateway via its supervisor (gateway stop, no relaunch)", () => {
    // The sidecar can't carry a supervisor — it's inlined into the size-capped
    // provisioning userdata. The profile-start / SSH-CONNECT paths install one; the
    // sidecar just stops the gateway (HERMES_HOME matching how it was launched) and
    // the supervisor respawns it with the freshly-written .env. No relaunch here.
    expect(SIDECAR_SERVER_CODE).toContain('HERMES_BIN=/opt/venv/bin/hermes');
    expect(SIDECAR_SERVER_CODE).toContain('HERMES_BIN=$(command -v hermes)');
    expect(SIDECAR_SERVER_CODE).toContain('HERMES_HOME=\\"$PROFILE_HOME\\" \\"$HERMES_BIN\\" gateway stop || true');
    expect(SIDECAR_SERVER_CODE).not.toContain('nohup /opt/hermes/.venv/bin/hermes gateway run');
    expect(SIDECAR_SERVER_CODE).not.toContain('gateway run --replace');
  });

  it("hardens request authentication and instance validation", () => {
    expect(SIDECAR_SERVER_CODE).toContain("Invalid INSTANCE_ID format");
    expect(SIDECAR_SERVER_CODE).toContain("API key not configured");
    expect(SIDECAR_SERVER_CODE).toContain("crypto.timingSafeEqual");
  });

  it("gates the official dashboard behind a login handoff and session cookie", () => {
    expect(SIDECAR_SERVER_CODE).toContain("DASHBOARD_UPSTREAM_URL");
    expect(SIDECAR_SERVER_CODE).toContain("hermes_dashboard_session");
    expect(SIDECAR_SERVER_CODE).toContain("requestUrl.pathname === '/dashboard-login'");
    expect(SIDECAR_SERVER_CODE).toContain("requestUrl.pathname === '/dashboard-session-check'");
    expect(SIDECAR_SERVER_CODE).toContain("dashboard --host 0.0.0.0 --port 9119 --no-open --insecure --tui");
    expect(SIDECAR_SERVER_CODE).toContain("proxyToDashboard");
    expect(SIDECAR_SERVER_CODE).toContain("nextPath.startsWith('//')");
    expect(SIDECAR_SERVER_CODE).toContain("nextPath.includes('\\\\')");
    expect(SIDECAR_SERVER_CODE).toContain("failureType: 'dashboard_login_expiry_too_far_in_future'");
    expect(SIDECAR_SERVER_CODE).toContain("expiresInMs");
  });

  it("webui session cookie ships SameSite=None; Secure for top-level handoff (no Partitioned)", () => {
    // Plain SameSite=None;Secure works for top-level navigation — the
    // "Open in new tab" button is the supported flow. Partitioned was
    // tried earlier for the inline iframe path but had unreliable handoff
    // behavior across the redirect and broke top-level navigation in some
    // contexts; reverted to match the working dashboard-login pattern.
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("SameSite=None; Secure; Max-Age=");
    expect(WEBUI_HANDOFF_APPENDAGE).not.toMatch(/SameSite=Lax;/);
    // buildWebuiCookie no longer takes a secure flag — production traffic
    // is HTTPS-only via the outer Caddy, so unconditional Secure is right.
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function buildWebuiCookie(sessionId)");
    expect(WEBUI_HANDOFF_APPENDAGE).not.toContain("dashboardCookieSameSiteAttribute(secure)");
  });

  it("accepts a valid appended WebUI session in the gated workspace proxy", () => {
    const requireDashboardAccess = SIDECAR_SERVER_CODE.match(
      /function requireDashboardAccess\(req, rawBody\) \{[\s\S]+?\n\}\n\n\/\/ GENERATED_IMAGE_SUPPORT_START/,
    )?.[0];
    expect(requireDashboardAccess).toContain(
      "if (typeof getWebuiSession === 'function' && getWebuiSession(req))",
    );
    expect(requireDashboardAccess).toContain("return { mode: 'webui_cookie' }");
  });

  it("ships WebUI iframe handoff as a separate appendage so the base sidecar stays byte-identical", () => {
    // Base sidecar must NOT contain webui handoff surfaces — Hetzner agents
    // ship the base only, and any size shift breaks the 32KB user_data
    // ceiling via gzip compression noise (verified empirically: even
    // 8 fewer bytes of post-strip content shifted compressed output by
    // 13+ bytes on Linux x64 CI).
    expect(SIDECAR_SERVER_CODE).not.toContain("hermes_webui_session");
    expect(SIDECAR_SERVER_CODE).not.toContain("/webui-login");
    expect(SIDECAR_SERVER_CODE).not.toContain("usedWebuiNonces");
    expect(SIDECAR_SERVER_CODE).not.toContain("handleWebuiLogin");

    // Appendage carries everything the iframe handoff needs.
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("hermes_webui_session");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("'/webui-login'");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("'/webui-session-check'");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("usedWebuiNonces");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("webuiSessions");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function pruneWebuiState");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function buildWebuiCookie");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function createWebuiSession");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function getWebuiSession");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function normalizeWebuiNextPath");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function handleWebuiLogin");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("function handleWebuiSessionCheck");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("'WebUI iframe redirects must stay on the instance gateway'");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("const WEBUI_LOGIN_TTL_MS = 180 * 1000;");
    // Clock-skew tolerance: the expiry check subtracts the TTL as a ±window so a box
    // clock ahead of the minting dashboard doesn't read a fresh 30s token as expired
    // -> 401 -> blank chat (2026-07-01 fixturenodea fix).
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("if (e < t - WEBUI_LOGIN_TTL_MS)");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("failureType: 'webui_login_expiry_too_far_in_future'");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("'WebUI login link already used'");

    // Payload format reuses the dashboard helper from the base sidecar.
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("buildDashboardLoginPayload(e, n, p)");
    expect(WEBUI_HANDOFF_APPENDAGE).not.toContain("function buildWebuiLoginPayload");

    // Hooks the request handler instead of inlining route checks in base.
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("server.removeAllListeners('request')");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("server.on('request'");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("for (const listener of baseListeners) listener.call(server, req, res)");
  });

  it("base + appendage parses as valid JavaScript when concatenated", () => {
    // The combined script is what gets written to sidecar_server.js for
    // WebUI deploys. Verify it parses end-to-end so a typo in the
    // appendage can't slip through to deploy.
    expect(() => new Script(SIDECAR_SERVER_CODE + WEBUI_HANDOFF_APPENDAGE)).not.toThrow();
  });

  it("base sidecar nonce/session stores are unchanged and webui state is appended in isolation", () => {
    // Dashboard helpers stay in base; webui helpers stay in appendage.
    expect(SIDECAR_SERVER_CODE).toContain("usedDashboardNonces");
    expect(SIDECAR_SERVER_CODE).toContain("dashboardSessions");
    expect(SIDECAR_SERVER_CODE).toContain("DASHBOARD_SESSION_COOKIE = 'hermes_dashboard_session'");
    expect(WEBUI_HANDOFF_APPENDAGE).toContain("WEBUI_SESSION_COOKIE = 'hermes_webui_session'");
  });

  it("redacts unexpected dashboard and websocket failures inside the sidecar", () => {
    expect(SIDECAR_SERVER_CODE).toContain("failureType: 'sidecar_dashboard_proxy_failed'");
    expect(SIDECAR_SERVER_CODE).toContain("'sidecar_integrations_failed'");
    expect(SIDECAR_SERVER_CODE).toContain("failureType: 'sidecar_terminal_websocket_failed'");
    expect(SIDECAR_SERVER_CODE).toContain("statusCode >= 500");
    expect(SIDECAR_SERVER_CODE).toContain("safeErrorMessage");
    expect(SIDECAR_SERVER_CODE).not.toContain("console.error('Dashboard proxy error:', err)");
    expect(SIDECAR_SERVER_CODE).not.toContain("console.error('Integrations error:', e)");
    expect(SIDECAR_SERVER_CODE).not.toContain("console.error('Terminal websocket error:', e)");
    expect(SIDECAR_SERVER_CODE).not.toContain("sendJson(res, e.statusCode || 500, { error: e.message || 'Internal error' })");
    expect(SIDECAR_SERVER_CODE).toContain("const safeTerminalProcessMessage = 'Terminal process failed'");
    expect(SIDECAR_SERVER_CODE).toContain("errorMessage: safeTerminalProcessMessage");
    expect(SIDECAR_SERVER_CODE).toContain("const wrapped = createHttpError(500, 'Failed to create terminal session')");
    expect(SIDECAR_SERVER_CODE).not.toContain("errorMessage: err && err.message ? err.message : 'Terminal process failed'");
    expect(SIDECAR_SERVER_CODE).not.toContain("throw createHttpError(500, err && err.message ? err.message : 'Failed to create terminal session')");
  });

  it("always marks dashboard session cookies SameSite=None; Secure (cross-origin iframe delivery)", () => {
    // Managed instances are HTTPS-only and the dashboard surface loads inside a
    // cross-origin iframe, so the cookie MUST be SameSite=None; Secure or the
    // browser drops it on the embed (workspace 404 incident 2026-06-14). The
    // in-VM hop reports X-Forwarded-Proto: http, which used to downgrade it to
    // SameSite=Lax — so shouldUseSecureDashboardCookie is now forced true.
    expect(SIDECAR_SERVER_CODE).toContain("function shouldUseSecureDashboardCookie()");
    expect(SIDECAR_SERVER_CODE).toMatch(/shouldUseSecureDashboardCookie\(\)\s*\{[\s\S]*?return true;/);
    expect(SIDECAR_SERVER_CODE).not.toContain("forwardedProto !== 'http'");
    // The Secure/SameSite machinery still wires through (secure is now always true).
    expect(SIDECAR_SERVER_CODE).toContain("secure ? '; Secure' : ''");
  });

  it("uses cross-site-safe dashboard cookies for embedded official dashboard handoffs", () => {
    expect(SIDECAR_SERVER_CODE).toContain("function dashboardCookieSameSiteAttribute(secure)");
    expect(SIDECAR_SERVER_CODE).toContain("return secure ? '; SameSite=None' : '; SameSite=Lax'");
    expect(SIDECAR_SERVER_CODE).toContain("dashboardCookieSameSiteAttribute(secure)");
  });

  it("logs official dashboard auth rejections without logging raw cookies", () => {
    expect(SIDECAR_SERVER_CODE).toContain("'sidecar_dashboard_auth_rejected'");
    expect(SIDECAR_SERVER_CODE).toContain("hasDashboardSessionCookie:");
    expect(SIDECAR_SERVER_CODE).toContain("hasHmacTimestamp:");
    expect(SIDECAR_SERVER_CODE).not.toContain("rawCookie");
    expect(SIDECAR_SERVER_CODE).not.toContain("cookieValue");
  });

  it("embeds authenticated terminal session support in the sidecar", () => {
    expect(SIDECAR_SERVER_CODE).toContain("requestUrl.pathname === '/api/terminal'");
    expect(SIDECAR_SERVER_CODE).toContain("requestUrl.pathname !== '/api/terminal/ws'");
    expect(SIDECAR_SERVER_CODE).toContain("const SAFE_TERMINAL_SESSION_KEY");
    expect(SIDECAR_SERVER_CODE).toContain("const SAFE_TERMINAL_SESSION_TOKEN");
    expect(SIDECAR_SERVER_CODE).toContain("session.sessionToken !== sessionToken");
    expect(SIDECAR_SERVER_CODE).toContain("WEBUI_TERMINAL_UPSTREAM_URL");
    expect(SIDECAR_SERVER_CODE).toContain("proxyWebUITerminalStart");
    expect(SIDECAR_SERVER_CODE).toContain("translateWebUITerminalSseEvent");
    expect(SIDECAR_SERVER_CODE).toContain("proxyWebUITerminalControl");
    expect(SIDECAR_SERVER_CODE).toContain("bash -i");
    expect(SIDECAR_SERVER_CODE).toContain("'Content-Type': 'text/event-stream'");
    expect(SIDECAR_SERVER_CODE).toContain("type: 'closed'");
    expect(SIDECAR_SERVER_CODE).toContain("Session exited with code");
  });

  it("authenticates proxied WebUI terminal HTTP and SSE requests with the internal session token", () => {
    expect(SIDECAR_SERVER_CODE).toContain("function webUITerminalHeaders(accept, includeJson)");
    expect(SIDECAR_SERVER_CODE).toContain("'x-hermes-session-token': API_KEY");
    expect(SIDECAR_SERVER_CODE).toContain("headers: webUITerminalHeaders('application/json', true)");
    expect(SIDECAR_SERVER_CODE).toContain("headers: webUITerminalHeaders('text/event-stream', false)");
  });

  it("falls back to the live runtime container when the installed WebUI has no terminal REST API", () => {
    expect(SIDECAR_SERVER_CODE).toContain("function shouldFallbackToContainerTerminal(err)");
    expect(SIDECAR_SERVER_CODE).toContain("err.statusCode === 404 || err.statusCode === 405");
    expect(SIDECAR_SERVER_CODE).toContain("createTerminalSession(sessionKey, sessionToken");
    expect(SIDECAR_SERVER_CODE).toContain("'-gateway'");
    expect(SIDECAR_SERVER_CODE).toContain("'-official-dashboard'");
    expect(SIDECAR_SERVER_CODE).toContain("no running terminal container for agent-");
    expect(SIDECAR_SERVER_CODE).toContain("terminalProcess.stdin.on('error', () => {});");
  });

  it("translates WebUI terminal SSE into the dashboard sidecar event shape", () => {
    expect(SIDECAR_SERVER_CODE).toContain("eventName === 'output'");
    expect(SIDECAR_SERVER_CODE).toContain("sendTerminalEvent(res, { type: 'output', data: text });");
    expect(SIDECAR_SERVER_CODE).toContain("eventName === 'terminal_closed'");
    expect(SIDECAR_SERVER_CODE).toContain("exitCode");
    expect(SIDECAR_SERVER_CODE).toContain("eventName === 'terminal_error'");
    expect(SIDECAR_SERVER_CODE).toContain("Session closed after a terminal error");
  });

  it("logs proxied WebUI terminal failures without leaking session credentials", () => {
    const logFunction = SIDECAR_SERVER_CODE.match(/function logWebUITerminalProxyFailure[\s\S]*?\n}\n/)?.[0] ?? "";

    expect(SIDECAR_SERVER_CODE).toContain("logWebUITerminalProxyFailure");
    expect(logFunction).toContain("failureType: 'sidecar_webui_terminal_proxy_failed'");
    expect(logFunction).toContain("stage,");
    expect(logFunction).toContain("upstreamConfigured: webUITerminalProxyEnabled()");
    expect(logFunction).not.toContain("sessionToken");
    expect(logFunction).not.toContain("webuiSessionId");
  });

  it("boots TUI mode through the proxied WebUI shell when WebUI terminal proxying is enabled", () => {
    expect(SIDECAR_SERVER_CODE).toContain("bootstrapWebUITerminalTui");
    expect(SIDECAR_SERVER_CODE).toContain("session.mode !== 'tui'");
    expect(SIDECAR_SERVER_CODE).toContain("buildTuiBootstrapCommand() + '\\n'");
    expect(SIDECAR_SERVER_CODE).toContain("destroyTerminalSession(sessionKey, 'error')");
  });

  it("adds a direct websocket terminal transport for dedicated TUI sessions", () => {
    expect(SIDECAR_SERVER_CODE).toContain("verifyTerminalWebSocketToken");
    expect(SIDECAR_SERVER_CODE).toContain("handleTerminalWebSocketUpgrade");
    expect(SIDECAR_SERVER_CODE).toContain("server.on('upgrade'");
    expect(SIDECAR_SERVER_CODE).toContain("Sec-WebSocket-Accept");
    expect(SIDECAR_SERVER_CODE).toContain("Client websocket frames must be masked");
    expect(SIDECAR_SERVER_CODE).toContain("type === 'resize'");
    expect(SIDECAR_SERVER_CODE).toContain("type === 'input'");
  });

  it("lets proxied WebUI terminal sessions use the websocket transport too", () => {
    expect(SIDECAR_SERVER_CODE).not.toContain("Terminal websocket unavailable for proxied terminal");
    expect(SIDECAR_SERVER_CODE).toContain("await ensureWebUITerminalStream(sessionKey, session);");
    expect(SIDECAR_SERVER_CODE).toContain("session.streamAbortController");
    expect(SIDECAR_SERVER_CODE).toContain("await proxyWebUITerminalControl(type, session, parsed);");
    expect(SIDECAR_SERVER_CODE).toContain("for (const listener of session.listeners) {");
  });

  it("no longer ships the legacy chat-stream-worker loader, handlers, or boot call", () => {
    // PR #91 ripped the dashboard chat surface (HermesChat) in favor of the
    // WebUI iframe. The chat-stream-worker pipeline existed solely to
    // dispatch jobs for that surface — every VM was loading (or trying to
    // load) a module that no caller would ever reach. This assertion is a
    // regression guard against the worker resurfacing in the bundle. We
    // check for unique code patterns (function/path strings that can only
    // appear in an actual loader/handler) rather than the bare phrase
    // "chat-stream-worker", which may legitimately survive in code comments
    // explaining the removal.
    expect(SIDECAR_SERVER_CODE).not.toContain("CHAT_STREAM_WORKER_MODULE_PATH = '/opt/data/w'");
    expect(SIDECAR_SERVER_CODE).not.toContain("createWorkerRuntime");
    expect(SIDECAR_SERVER_CODE).not.toContain("chatWorkerRuntime");
    expect(SIDECAR_SERVER_CODE).not.toMatch(/requestUrl\.pathname === '\/api\/chat-stream-worker\/(health|pump)'/);
    expect(SIDECAR_SERVER_CODE).not.toContain("startChatStreamWorker");
    expect(SIDECAR_SERVER_CODE).not.toContain("getChatStreamWorkerHealth");
    expect(SIDECAR_SERVER_CODE).not.toContain("requestChatStreamWorkerPump");
  });

  it("retires mirror-sync health without removing the rest of the sidecar", () => {
    expect(SIDECAR_SERVER_CODE).toContain("requestUrl.pathname === '/api/mirror-sync/health'");
    expect(SIDECAR_SERVER_CODE).toContain("sendJson(res, 410");
    expect(SIDECAR_SERVER_CODE).toContain("mirror_sync_retired");
    expect(SIDECAR_SERVER_CODE).not.toContain("chatWorkerRuntime?.getMirrorSyncHealth?.()");
  });

  it("mints a valid sidecar session identity when terminal start requests omit one", () => {
    expect(SIDECAR_SERVER_CODE).toContain("function buildTerminalSessionKey(mode)");
    expect(SIDECAR_SERVER_CODE).toContain("'term:sidecar:' + INSTANCE_ID + ':' + normalizeTerminalSessionMode(mode)");
    expect(SIDECAR_SERVER_CODE).toContain("function resolveTerminalStartSessionIdentity(parsedBody)");
    expect(SIDECAR_SERVER_CODE).toContain("crypto.randomUUID()");
    expect(SIDECAR_SERVER_CODE).toContain("const { mode, sessionKey, sessionToken } = resolveTerminalStartSessionIdentity(parsedBody);");
  });

  it("forces the sidecar terminal wrapper to flush prompts and echoed keystrokes immediately", () => {
    expect(SIDECAR_SERVER_CODE).toContain("HERMES_TERMINAL_PTY_HELPER");
    expect(SIDECAR_SERVER_CODE).toContain("command -v apk >/dev/null 2>&1");
    expect(SIDECAR_SERVER_CODE).toContain("apk add --no-cache python3 >/dev/null 2>&1 || true");
    expect(SIDECAR_SERVER_CODE).toContain("exec \"$PYTHON_BIN\" -u -c \"$HERMES_TERMINAL_PTY_HELPER\"");
    expect(SIDECAR_SERVER_CODE).toContain("base64.b64encode");
  });

  it("supports Hermes TUI sessions through the sidecar transport", () => {
    expect(SIDECAR_SERVER_CODE).toContain("return rawMode === 'tui' ? 'tui' : 'shell';");
    expect(SIDECAR_SERVER_CODE).toContain("hermes --tui");
    expect(SIDECAR_SERVER_CODE).toContain("if (existing && mode !== 'tui')");
    expect(SIDECAR_SERVER_CODE).toContain("destroyTerminalSession(sessionKey, 'stopped')");
    expect(SIDECAR_SERVER_CODE).toContain("const TERMINAL_SHELL_CWD");
    expect(SIDECAR_SERVER_CODE).toContain("const TERMINAL_TUI_CWD");
    expect(SIDECAR_SERVER_CODE).toContain("const workdir = mode === 'tui' ? TERMINAL_TUI_CWD : TERMINAL_SHELL_CWD");
    expect(SIDECAR_SERVER_CODE).toContain("TERM=xterm-256color");
    expect(SIDECAR_SERVER_CODE).toContain("stty cols \\\\${COLUMNS:-80} rows \\\\${LINES:-24}");
    expect(SIDECAR_SERVER_CODE).toContain("termios.TIOCSWINSZ");
    expect(SIDECAR_SERVER_CODE).toContain("os.killpg(process.pid, signal.SIGWINCH)");
    expect(SIDECAR_SERVER_CODE).not.toContain("export TERM=${TERM:-xterm-256color}");
    expect(SIDECAR_SERVER_CODE).toContain("/opt/hermes/.venv/bin/hermes --tui");
    expect(SIDECAR_SERVER_CODE).toContain("/opt/hermes/ui-tui/node_modules/@hermes/ink/dist/ink-bundle.js");
    expect(SIDECAR_SERVER_CODE).toContain("/opt/hermes/ui-tui/node_modules/@hermes/ink/package.json");
    expect(SIDECAR_SERVER_CODE).toContain("/opt/hermes/ui-tui/node_modules/.bin/esbuild");
    expect(SIDECAR_SERVER_CODE).toContain("cd /opt/hermes/ui-tui");
    expect(SIDECAR_SERVER_CODE).toContain("Repairing Hermes TUI runtime...");
    expect(SIDECAR_SERVER_CODE).toContain("Hermes TUI repair build:");
    expect(SIDECAR_SERVER_CODE).toContain("Hermes TUI repair strategy:");
    expect(SIDECAR_SERVER_CODE).toContain("toolchain missing, reinstalling dependencies");
    expect(SIDECAR_SERVER_CODE).toContain("rm -rf node_modules");
    expect(SIDECAR_SERVER_CODE).toContain("command -v hermes");
    expect(SIDECAR_SERVER_CODE).toContain("Hermes CLI not found in container PATH");
    expect(SIDECAR_SERVER_CODE).toContain("CI=1 npm install --include=dev --silent --no-fund --no-audit");
    expect(SIDECAR_SERVER_CODE).toContain("npm run build --prefix packages/hermes-ink");
    expect(SIDECAR_SERVER_CODE).toContain("hermes-ink build failed, trying ui-tui build");
    expect(SIDECAR_SERVER_CODE).toContain("npm run build || { echo '[!] Hermes TUI repair: ui-tui build failed' >&2; exit 1; }");
    expect(SIDECAR_SERVER_CODE).toContain("cp -r packages/hermes-ink/dist/. node_modules/@hermes/ink/dist/");
    expect(SIDECAR_SERVER_CODE).toContain("Hermes TUI repair: failed to reset node_modules");
    expect(SIDECAR_SERVER_CODE).toContain("Hermes TUI repair: npm install failed");
    expect(SIDECAR_SERVER_CODE).toContain("Hermes TUI repair: ui-tui build failed");
    expect(SIDECAR_SERVER_CODE).toContain("Hermes TUI repair: ink-bundle.js is still missing after repair");
  });

  // 2026-06-26 fleet wedge: confirmed on canary repro — docker stop the
  // dashboard while sidecar is up, hammer 30 reqs, docker start the dashboard
  // back; sidecar never self-recovers (probed 9× over 90s, all 000) until
  // docker restart of the sidecar process. Root cause: `dashboardRecoveryPromise`
  // is memoized at L199 and the inner chain (recoverDashboardUpstream ->
  // waitForHealthyDashboardUpstream -> probeDashboardUpstream -> http.request)
  // contains TCP-connect awaits with no deadline (Node's default connect
  // timeout is Infinity, and ClientRequest.setTimeout only counts AFTER socket
  // assignment). A connect-stall -> memoized promise never settles ->
  // .finally never fires -> every subsequent /desktop request awaits the
  // dead promise forever. The four assertions below regression-lock the fix:
  // (1) a withDeadline helper exists, (2) the memoized recovery promise is
  // wrapped in withDeadline with a hard ceiling + always-clears the memo,
  // (3) the probe + proxy http.requests have AbortController-driven outer
  // kill-timers that fire from request CREATION (not socket-idle), and
  // (4) proxyToDashboard has a per-request deadline so a single request can
  // never block the handler forever.
  // 2026-06-26 — TRUE root cause of the fleet wedge, found by live diagnosis on
  // the canary box (#482/#483's withDeadline guards were necessary but did NOT
  // fix it). The sidecar resolves upstreams with http's default dns.lookup
  // (getaddrinfo), which runs on libuv's 4-thread pool. buildDashboardUpstreamCandidates
  // probes container names that are DEAD for a given deployment topology
  // (e.g. `-web`/bare `agent-<id>` on a webfree box) on every recovery cycle; in
  // the Alpine/musl sidecar a lookup of a non-existent Docker name blocks a pool
  // thread for the full ~5s musl resolver timeout. Under any request burst those
  // 5s lookups saturate all 4 threads and STARVE resolution of the real upstream
  // even once it is healthy again -> every /desktop probe perceives a 5s failure
  // -> findHealthy returns nothing -> wedge until the sidecar process restarts.
  // Measured on the box: 20 parallel dead getaddrinfo = 50s; 20 parallel dead
  // dns.resolve4 (c-ares, event loop) = 1ms. Fix: resolve via c-ares so DNS
  // never touches the threadpool and dead names fast-fail. Proven: with the FULL
  // candidate list intact, the hammer-while-down repro now self-heals in ~3s.
  it("resolves upstreams via c-ares (dns.resolve4), never getaddrinfo, so dead-name lookups can't saturate the libuv threadpool", () => {
    expect(SIDECAR_SERVER_CODE).toContain("function dashboardDnsLookup(hostname, options, callback)");
    expect(SIDECAR_SERVER_CODE).toContain("require('dns').resolve4(hostname");
    expect(SIDECAR_SERVER_CODE).toContain("require('net').isIP(hostname)");
    // Every upstream http.request on the recovery/proxy path must opt into the
    // c-ares lookup. dns.lookup default would re-introduce the threadpool wedge.
    const lookupUses = SIDECAR_SERVER_CODE.match(/lookup: dashboardDnsLookup/g) || [];
    expect(lookupUses.length).toBeGreaterThanOrEqual(4);
    // The probe (the hot loop that hits dead names) MUST use it.
    const probeBlock =
      SIDECAR_SERVER_CODE.match(/function probeDashboardUpstream\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(probeBlock).toContain("lookup: dashboardDnsLookup");
  });

  it("ships a withDeadline helper so memoized upstream-recovery promises can never outlive a wall-clock ceiling", () => {
    expect(SIDECAR_SERVER_CODE).toContain("function withDeadline(promise, ms, label)");
    expect(SIDECAR_SERVER_CODE).toContain("'SIDECAR_DEADLINE'");
    expect(SIDECAR_SERVER_CODE).toContain("Promise.race([");
    expect(SIDECAR_SERVER_CODE).toContain("const DASHBOARD_RECOVERY_DEADLINE_MS");
  });

  // 2026-06-26 FOLLOW-UP to PR #482 — NOBLEAGENT (b4687efc) wedge proved that
  // `dashboardRecoveryPromise` is NOT the only memoized-promise wedge point.
  // The gated-bridge (/desktop request handler) has two more unbounded paths:
  // `dashboardUpstreamLoginPromise` (memoized login at L1146) and the raw
  // `http.request` inside `dashboardProxyOnceWithCookie` (L1205) whose only
  // `proxyReq.setTimeout` is socket-idle (fires post-socket-assign only) — so
  // a TCP-connect stall (dashboard mid-shutdown / half-open socket) hangs
  // forever and wedges the /desktop path despite PR #482's withDeadline on
  // resolveDashboardUpstreamBase. Both fixes live INSIDE the
  // DASHBOARD_GATED_PROXY block, so they cost zero bytes in the Hetzner
  // bootstrap variant (the block is stripped there entirely).
  it("bounds the memoized dashboardUpstreamLoginPromise with the same hard deadline as dashboardRecoveryPromise", () => {
    expect(SIDECAR_SERVER_CODE).toMatch(
      /dashboardUpstreamLoginPromise\s*=\s*withDeadline\(\s*\n?\s*loginDashboardUpstream\(/,
    );
    expect(SIDECAR_SERVER_CODE).toContain("'loginDashboardUpstream'");
    expect(SIDECAR_SERVER_CODE).toContain("sidecar_dashboard_login_deadline_exceeded");
    expect(SIDECAR_SERVER_CODE).toMatch(
      /\}\)\.finally\(\(\) => \{\s*\n?\s*dashboardUpstreamLoginPromise = null;/,
    );
  });

  it("bounds dashboardProxyOnceWithCookie's TCP-connect stall with an AbortController-driven outer kill-timer", () => {
    const block =
      SIDECAR_SERVER_CODE.match(/function dashboardProxyOnceWithCookie\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(block).toContain("new AbortController()");
    expect(block).toContain("signal: ac.signal");
    expect(block).toContain("ac.abort()");
    // After headers received, the kill-timer MUST be cleared so long-lived
    // SSE streams (chat tokens with multi-second gaps) are not severed.
    expect(block).toContain("clearTimeout(killTimer)");
  });

  it("bridges browser sessions to official dashboards running in legacy token-auth mode", () => {
    // Live regression (Pike, 2026-08-22): the sidecar's signed browser cookie
    // was valid, but the official dashboard was launched with --insecure and
    // reported auth_required=false. Its password-login cookies are ignored in
    // that mode, so /api/sessions and /api/profiles returned 401 even though a
    // direct API_SERVER_KEY bearer returned 200. The dedicated session header
    // is accepted by token-mode images and ignored by cookie-gated images,
    // making the bridge compatible with both without exposing the key to the
    // browser.
    const block =
      SIDECAR_SERVER_CODE.match(/function dashboardProxyOnceWithCookie\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(block).toContain("headers['x-hermes-session-token'] = API_KEY");
  });

  it("bounds the memoized dashboardRecoveryPromise with a hard deadline and ALWAYS clears the memo, even on rejection", () => {
    expect(SIDECAR_SERVER_CODE).toMatch(
      /dashboardRecoveryPromise\s*=\s*withDeadline\(\s*\n?\s*recoverDashboardUpstream\(\)/,
    );
    expect(SIDECAR_SERVER_CODE).toContain("'recoverDashboardUpstream'");
    expect(SIDECAR_SERVER_CODE).toContain("sidecar_dashboard_recovery_deadline_exceeded");
    // The .catch + .finally chain MUST be present so a rejected deadline still
    // clears the memo. Without .catch the rejected promise gets re-thrown out
    // of the await and the memo is gone but the request handler explodes;
    // with .catch -> return '' the caller treats it as 'no upstream' and
    // falls through cleanly. The .finally guarantees memo reset regardless.
    expect(SIDECAR_SERVER_CODE).toMatch(
      /'recoverDashboardUpstream',?\s*\n?\s*\)\.catch\(/,
    );
    expect(SIDECAR_SERVER_CODE).toMatch(
      /\}\)\.finally\(\(\) => \{\s*\n?\s*dashboardRecoveryPromise = null;/,
    );
  });

});
