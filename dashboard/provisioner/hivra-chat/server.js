// Hivra chat server — a thin frontend to an OFFICIAL agent CLI.
// Depending on AGENT_KIND it spawns the official `claude` CLI
// (`claude -p --output-format stream-json`) or the official `codex` CLI
// (`codex exec --json`) — the official product, on the user's own login — and
// streams its JSONL events straight to the browser. It does NOT use any Agent
// SDK. Native CLI login remains separate from the explicit model-provider
// settings handled below.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const net = require("net");
const crypto = require("crypto");
const { PROTOCOL: LLM_APPLICATION_PROTOCOL, createLlmApplicationStore, LlmApplicationError } = require("./llm-application.js");
const { createGuardedFiles } = require("./guarded-files.cjs");
const { SOURCES: A0_EDITOR_SOURCES, rewriteNativeEditorAsset } = require("./agent-zero-editor.cjs");

const PORT = process.env.HIVRA_CHAT_PORT || 8080;
const HOME = process.env.HOME || "/home/bux";
const DIR = __dirname;
const CLAUDE = process.env.CLAUDE_BIN || "/usr/bin/claude";
const CODEX = process.env.CODEX_BIN || "/home/bux/.npm-global/bin/codex";
const GH = process.env.GH_BIN || "/usr/bin/gh";
// Loopback port the Aeon dashboard (Next.js) is hosted on; we token-proxy it
// under /aeon. The Aeon dashboard has no auth of its own and drives gh + repo
// secrets, so it MUST sit behind this gate (AEON_DASHBOARD_ALLOW_ANY_HOST=1 is
// only safe because this proxy authenticates every request).
const AEON_PORT = Number(process.env.AEON_DASHBOARD_PORT) || 5555;
// The Aeon clone the box serves + the upstream template it was provisioned from.
// On GitHub connect we repoint origin (and the gh default repo) at the connected
// user's OWN fork — otherwise every gh secret/dispatch call targets the upstream
// template, which the user doesn't own → HTTP 403 on every credential save.
const AEON_DIR = process.env.AEON_DIR || (HOME + "/aeon");
const AEON_UPSTREAM = process.env.AEON_UPSTREAM || "aaronjmars/aeon";
// Loopback port the OpenClaw gateway serves its Control UI (+ WS control/RPC) on.
// Like Aeon it's a hosted web surface with no public auth of its own once on
// loopback, so it MUST sit behind this proxy's token gate. Mounted under
// /openclaw with a path strip (OpenClaw serves at root, no basePath option).
const OPENCLAW_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT) || 18789;
// Loopback port the Agent Zero container publishes its web UI on (container :80 ->
// 127.0.0.1:AGENT_ZERO_PORT). Like OpenClaw it serves at ROOT (no basePath), gates
// its own web UI with a seeded basic-auth login, and MUST sit behind this token
// proxy — mounted under /agent-zero with a path strip + Referer re-home.
const AGENT_ZERO_PORT = Number(process.env.AGENT_ZERO_PORT) || 50080;
// Which agent this box runs. Set by the provisioner via ~/.hivra/agent-kind or
// the HIVRA_AGENT_KIND env. Same server drives whichever runtime is selected.
function readAgentKind() {
  // Root-owned native/computer services bind this gateway to their profile. A
  // writable HOME selector must not switch their authentication/routes back to
  // an agent runtime with chat or account-login surfaces.
  if (["deepseek-harness", "linux-desktop"].includes(process.env.HIVRA_AGENT_KIND)) {
    return process.env.HIVRA_AGENT_KIND;
  }
  try {
    const k = fs.readFileSync(path.join(HOME, ".hivra", "agent-kind"), "utf8").trim().toLowerCase();
    if (k) return k;
  } catch {}
  return (process.env.HIVRA_AGENT_KIND || "claude").toLowerCase();
}
const _agentKindRaw = readAgentKind();
const AGENT_KIND = _agentKindRaw === "codex" ? "codex"
  : _agentKindRaw === "generic" ? "generic"
  : _agentKindRaw === "aeon" ? "aeon"
  : _agentKindRaw === "openclaw" ? "openclaw"
  : _agentKindRaw === "agent-zero" ? "agent-zero"
  : _agentKindRaw === "deepseek-harness" ? "deepseek-harness"
  : _agentKindRaw === "linux-desktop" ? "linux-desktop"
  : "claude";
const COMPUTER_PROFILE = AGENT_KIND === "linux-desktop";
const configuredWorkspace = process.env.HIVRA_WORKSPACE_ROOT
  || (COMPUTER_PROFILE ? path.join(HOME, "Hivra") : HOME);
const WORKSPACE_ROOT = path.resolve(configuredWorkspace);
if (WORKSPACE_ROOT !== HOME && !WORKSPACE_ROOT.startsWith(HOME + path.sep)) {
  throw new Error("Hivra workspace must stay inside the computer owner's home");
}
const AGENT_ENV = Object.assign({}, process.env, {
  PATH: "/usr/local/bin:/home/bux/.bun/bin:/home/bux/.npm-global/bin:/home/bux/.local/bin:/usr/bin:/bin",
  HOME: HOME,
});
const CLAUDE_ENV = AGENT_ENV; // back-compat alias used by the claude login handlers

// Per-box Bankr wallet credentials. The dashboard provisions the wallet LAZILY
// (user clicks "Create wallet") and SSH-writes ~/.hivra/bankr.env (0600, KEY=VALUE);
// each chat spawn re-reads it so a wallet created mid-life applies on the NEXT
// turn with no service restart — same contract as ~/.hivra/agent-model. Only the
// agent CLI turn gets these (helper/git/mcp spawns don't need wallet creds).
function readBankrEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(HOME, ".hivra", "bankr.env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}
function chatSpawnEnv() {
  const bankr = readBankrEnv();
  return Object.keys(bankr).length ? Object.assign({}, AGENT_ENV, bankr) : AGENT_ENV;
}

// Box API token gating every stateful endpoint and proxied access surface.
// The long-lived bearer is accepted only in an Authorization header or in the
// body of the dedicated bootstrap POST. It must never appear in a URL, cookie,
// redirect, access log, or browser history.
function readApiToken() {
  try { return fs.readFileSync(path.join(HOME, ".hivra", "api-token"), "utf8").trim(); } catch { return ""; }
}
const API_TOKEN = readApiToken();
if (!/^[a-f0-9]{64}$/.test(API_TOKEN)) {
  throw new Error("Hivra box API token is missing or invalid; refusing to start an unauthenticated access gateway");
}
// __Host- prevents a sibling/subdomain from planting a broader-scope cookie.
// Secure + Path=/ + no Domain below are required by the prefix contract.
const AUTH_COOKIE = "__Host-hivra_auth";
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SESSIONS = new Map();
function cookieVal(req, name) {
  const raw = String(req.headers["cookie"] || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function safeEq(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function pruneAuthSessions(now) {
  for (const [session, expiresAt] of AUTH_SESSIONS) {
    if (expiresAt <= now) AUTH_SESSIONS.delete(session);
  }
}
function createAuthSession() {
  const now = Date.now();
  pruneAuthSessions(now);
  const session = crypto.randomBytes(32).toString("hex");
  AUTH_SESSIONS.set(session, now + AUTH_SESSION_TTL_MS);
  return session;
}
function validAuthSession(session) {
  if (!session) return false;
  const expiresAt = AUTH_SESSIONS.get(session);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) { AUTH_SESSIONS.delete(session); return false; }
  return true;
}
function sameBoxOrigin(req) {
  const origin = String(req.headers["origin"] || "");
  const host = String(req.headers["host"] || "").trim().toLowerCase();
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}
function cookieAuthMayMutate(req) {
  const method = String(req.method || "GET").toUpperCase();
  const websocket = String(req.headers["upgrade"] || "").toLowerCase() === "websocket";
  if (!websocket && (method === "GET" || method === "HEAD" || method === "OPTIONS")) return true;
  return sameBoxOrigin(req);
}
// API fetches use the long-lived bearer header. Embedded surfaces use a
// short-lived opaque session cookie minted by POST /auth/bootstrap. Bearer
// calls are not ambient browser authority. Cookie-authenticated mutations and
// WebSocket upgrades require the box's own HTTPS Origin to prevent CSRF/CWSH;
// bootstrap is dispatched before this gate and is deliberately exempt.
function bearerAuthed(req) {
  const h = String(req.headers["authorization"] || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return Boolean(m && safeEq(m[1], API_TOKEN));
}
function authed(req) {
  return bearerAuthed(req) || (validAuthSession(cookieVal(req, AUTH_COOKIE)) && cookieAuthMayMutate(req));
}
// Only loaded on an explicitly installed DeepSeek guest; other runtimes retain
// their existing surface contract and do not start any additional process.
const DEEPSEEK_POLICY = AGENT_KIND === "deepseek-harness" ? require("./deepseek-harness/gateway-policy.cjs") : null;
const DEEPSEEK_CONFIG = DEEPSEEK_POLICY ? DEEPSEEK_POLICY.loadConfiguration() : null;
const DEEPSEEK_BROKER = DEEPSEEK_CONFIG ? require("./deepseek-harness/native-broker.cjs").createNativeBroker({
  publicOrigin: DEEPSEEK_CONFIG.publicOrigin,
  // A native browser session receives neither the long-lived management key
  // nor DeepSeek's private cookie. Live streams re-check this session closure.
  authorize: req => validAuthSession(cookieVal(req, AUTH_COOKIE)),
}) : null;
// Optional full-computer desktop broker. It has its own short-lived,
// owner-bound session authority; the long-lived Hivra management token is
// deliberately not an alternate login path for /desktop.
const REMOTE_DESKTOP_BROKER_PORT = Number(process.env.HIVRA_REMOTE_DESKTOP_BROKER_PORT || 8090);
function denyHtml(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<body style=\"font-family:monospace;background:#0c0c0c;color:#8a8a8a;padding:28px\">401 — this box is private. Open it from your Hivra dashboard.</body>");
}

function safeBootstrapDestination(raw) {
  const destination = String(raw || "");
  if (!destination.startsWith("/") || destination.startsWith("//") || destination.includes("\\")) return null;
  if (destination.length > 4096 || /[\u0000-\u001f\u007f]/.test(destination)) return null;
  return destination;
}
function handleAuthBootstrap(req, res) {
  let body = ""; let tooBig = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 16 * 1024) { tooBig = true; req.destroy(); }
  });
  req.on("end", () => {
    if (tooBig) return;
    const form = new URLSearchParams(body);
    const destination = safeBootstrapDestination(form.get("destination"));
    if (!destination || !safeEq(form.get("token") || "", API_TOKEN)) return denyHtml(res);
    const session = createAuthSession();
    res.setHeader("Set-Cookie", AUTH_COOKIE + "=" + session + "; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=43200");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.writeHead(303, { Location: destination });
    res.end();
  });
}

// ---- Box introspection: chat-history sessions, file browser, skills ----
// Credential paths, aliases and special files are rejected before I/O.
const SESS_DIR = AGENT_KIND === "codex"
  ? path.join(HOME, ".codex", "sessions")
  : path.join(HOME, ".claude", "projects");
const GUARDED_FILES = createGuardedFiles(WORKSPACE_ROOT);

function clampHome(rel) {
  const resolved = path.resolve(WORKSPACE_ROOT, rel || ".");
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) return null;
  return resolved;
}
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text" && b.text).map((b) => b.text).join("\n");
  return "";
}
function parseClaudeJsonl(file, titleOnly) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const messages = [];
  let title = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = textFromContent(m.content);
    const tools = Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "tool_use").map((b) => b.name) : [];
    if (!text && tools.length === 0) continue;
    if (!title && m.role === "user" && text) { title = text.slice(0, 70); if (titleOnly) return { title }; }
    if (!titleOnly) messages.push({ role: m.role, text, tools });
  }
  return titleOnly ? { title } : { messages, title: title || "Session" };
}

// Codex stores rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
function walkJsonl(dir, out, depth) {
  if (depth > 6) return;
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (e.name.endsWith(".jsonl")) out.push(full);
  }
}
function codexIdFromFile(f) {
  const m = path.basename(f).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : "";
}
// Codex rollout: response_item lines, payload.type==="message", role user/assistant,
// content[] of {type:input_text|output_text|text, text}. Skip developer/system + events.
// Codex injects context as "user" messages (AGENTS.md, env/permissions blocks) before
// the real prompt — filter those so the title/history is the actual conversation.
const CODEX_INJECT_RE = /^#*\s*(AGENTS\.md|CLAUDE\.md)\s+instructions|<INSTRUCTIONS>|<environment_context>|<user_instructions>|<permissions/i;
function parseCodexRollout(file, titleOnly) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const messages = [];
  let title = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "response_item") continue;
    const p = o.payload;
    if (!p || p.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
    const text = Array.isArray(p.content)
      ? p.content.filter((b) => b && (b.type === "input_text" || b.type === "output_text" || b.type === "text") && b.text).map((b) => b.text).join("\n")
      : "";
    if (!text) continue;
    if (p.role === "user" && CODEX_INJECT_RE.test(text.trim())) continue; // injected context, not a real turn
    if (!title && p.role === "user") { title = text.slice(0, 70); if (titleOnly) return { title }; }
    if (!titleOnly) messages.push({ role: p.role, text, tools: [] });
  }
  return titleOnly ? { title } : { messages, title: title || "Session" };
}

function handleSessionsList(res) {
  try {
    const out = [];
    if (AGENT_KIND === "codex") {
      const files = []; walkJsonl(SESS_DIR, files, 0);
      for (const full of files) {
        const id = codexIdFromFile(full);
        if (!id) continue;
        let st; try { st = fs.statSync(full); } catch { continue; }
        let title = "Session";
        try { title = parseCodexRollout(full, true).title || "Session"; } catch {}
        if (title === "Session") continue; // skip empty/instruction-only rollouts
        out.push({ id, title, updatedAt: Math.floor(st.mtimeMs) });
      }
    } else {
      let dirs = []; try { dirs = fs.readdirSync(SESS_DIR); } catch {}
      for (const d of dirs) {
        const sub = path.join(SESS_DIR, d);
        let files = []; try { files = fs.readdirSync(sub).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
        for (const f of files) {
          const full = path.join(sub, f);
          let st; try { st = fs.statSync(full); } catch { continue; }
          let title = "Session";
          try { title = parseClaudeJsonl(full, true).title || "Session"; } catch {}
          out.push({ id: f.replace(/\.jsonl$/, ""), title, updatedAt: Math.floor(st.mtimeMs) });
        }
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    jsonRes(res, 200, { sessions: out.slice(0, 100) });
  } catch (e) { jsonRes(res, 500, { error: String((e && e.message) || e) }); }
}
function handleSessionRead(res, id) {
  if (!/^[0-9a-f-]{8,}$/i.test(id)) return jsonRes(res, 400, { error: "bad id" });
  try {
    if (AGENT_KIND === "codex") {
      const files = []; walkJsonl(SESS_DIR, files, 0);
      const target = files.find((f) => codexIdFromFile(f) === id);
      if (!target) return jsonRes(res, 404, { error: "not found" });
      return jsonRes(res, 200, { id, messages: parseCodexRollout(target, false).messages });
    }
    let target = null;
    let dirs = []; try { dirs = fs.readdirSync(SESS_DIR); } catch {}
    for (const d of dirs) { const p = path.join(SESS_DIR, d, id + ".jsonl"); if (fs.existsSync(p)) { target = p; break; } }
    if (!target) return jsonRes(res, 404, { error: "not found" });
    jsonRes(res, 200, { id, messages: parseClaudeJsonl(target, false).messages });
  } catch (e) { jsonRes(res, 500, { error: String((e && e.message) || e) }); }
}
function handleFilesList(res, q) {
  try { jsonRes(res, 200, GUARDED_FILES.list(q.get("path") || ".")); }
  catch (e) { fileError(res, e); }
}
function fileError(res, error) {
  if (error.code === "ENOENT") return jsonRes(res, 404, { error: "file not found" });
  if (error.code === "HIVRA_FILE_SIZE") return jsonRes(res, 413, { error: "file too large (>512KB)" });
  return jsonRes(res, 403, { error: "file access denied (private path, link, or unsupported file)" });
}
function handleFileRead(res, q) {
  try { jsonRes(res, 200, GUARDED_FILES.read(q.get("path") || "", 512 * 1024)); }
  catch (e) { fileError(res, e); }
}
// Write a text file under HOME (the Files tab's edit mode). Stricter than reads:
// requires a NON-EMPTY box token (legacy boxes with no token stay read-only —
// the back-compat openness must not extend to writes), same path clamp + secret
// blocklist as reads, rejects directories, and caps content at the read limit so
// anything we save stays re-openable.
const FILE_WRITE_MAX = 512 * 1024;
function handleFileWrite(req, res) {
  if (!API_TOKEN) return jsonRes(res, 403, { error: "writes are disabled on this box (no API token)" });
  // Own body reader: the shared readBody caps at 100KB which would make larger
  // files readable but silently unsavable. JSON envelope overhead ~ +30%.
  let body = "";
  let over = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > FILE_WRITE_MAX * 1.4) { over = true; req.destroy(); }
  });
  req.on("end", () => {
    if (over) return jsonRes(res, 413, { error: "file too large (>512KB)" });
    let rel = "", content = "";
    try { const j = JSON.parse(body || "{}"); rel = String(j.path || ""); content = typeof j.content === "string" ? j.content : null; } catch {}
    if (!rel || content === null) return jsonRes(res, 400, { error: "need path + content (string)" });
    if (Buffer.byteLength(content, "utf8") > FILE_WRITE_MAX) return jsonRes(res, 413, { error: "file too large (>512KB)" });
    try { jsonRes(res, 200, GUARDED_FILES.write(rel, content)); }
    catch (e) { fileError(res, e); }
  });
}

function handleSkillsList(res) {
  // Codex discovers skills from ~/.agents/skills (OpenAI skills spec), claude from ~/.claude/skills.
  const base = AGENT_KIND === "codex" ? path.join(HOME, ".agents", "skills") : path.join(HOME, ".claude", "skills");
  try {
    const out = [];
    let dirs = []; try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch {}
    for (const d of dirs) {
      // Follow symlinks: on codex boxes the cdp skill is a symlink into
      // ~/.claude/skills (one clone shared by both agents), and a symlink
      // dirent reports isDirectory()=false even when the target is a dir.
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink()) { try { isDir = fs.statSync(path.join(base, d.name)).isDirectory(); } catch {} }
      if (!isDir) continue;
      let name = d.name, description = "";
      try {
        const head = fs.readFileSync(path.join(base, d.name, "SKILL.md"), "utf8").slice(0, 1500);
        const fm = head.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const nm = fm[1].match(/^name:\s*(.+)$/m); if (nm) name = nm[1].trim().replace(/^["']|["']$/g, "");
          const dm = fm[1].match(/^description:\s*(.+)$/m); if (dm) description = dm[1].trim().replace(/^["']|["']$/g, "");
        }
      } catch { continue; }
      out.push({ id: d.name, name, description });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    jsonRes(res, 200, { skills: out });
  } catch (e) { jsonRes(res, 500, { error: String((e && e.message) || e) }); }
}
function handleSkillDelete(res, id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === "." || id === "..") return jsonRes(res, 400, { error: "bad id" });
  // Codex discovers skills from ~/.agents/skills (OpenAI skills spec), claude from ~/.claude/skills.
  const base = AGENT_KIND === "codex" ? path.join(HOME, ".agents", "skills") : path.join(HOME, ".claude", "skills");
  const dir = path.join(base, id);
  if (path.dirname(dir) !== base) return jsonRes(res, 400, { error: "bad path" }); // no traversal
  try {
    if (!fs.existsSync(dir)) return jsonRes(res, 404, { error: "not found" });
    fs.rmSync(dir, { recursive: true, force: true });
    jsonRes(res, 200, { ok: true });
  } catch (e) { jsonRes(res, 500, { error: String((e && e.message) || e) }); }
}

// ---- Telegram: connect the box's bux-tg bot to the user's bot token ----
// bux ships bux-tg.service (EnvironmentFile=/etc/bux/tg.env, ConditionPathExists
// it). Connect supports two auth shapes — the modern setup-token deeplink and a
// legacy owner-id fallback — both via the same narrow root helper.
//
//   Modern (no ownerId in the request body): we generate a random TG_SETUP_TOKEN
//     and write /etc/bux/tg.env with TG_BOT_TOKEN + TG_SETUP_TOKEN. The dashboard
//     renders `t.me/<bot>?start=<token>`; the first chat to redeem the deeplink
//     binds as owner and bux's `burn_setup_token` wipes the token from tg.env
//     (single-use, constant-time compare). Strangers who DM the bot without the
//     token are silently dropped.
//   Fallback (ownerId present): we pre-bind via TG_OWNER_ID. bux's "owner
//     private-DM auto-bind" then accepts the owner's first DM directly, with no
//     deeplink. Used by the dashboard's "advanced manual id" disclosure.
//
// Bound state lives in /etc/bux/tg-state.json (`box_owner`) + /etc/bux/
// tg-allowed.txt; we surface it via status so the UI can flip to "Connected"
// once the user actually completes the bind.
function handleTelegramStatus(res) {
  let hasToken = false, ownerEnvId = null;
  try {
    const c = fs.readFileSync("/etc/bux/tg.env", "utf8");
    hasToken = /TG_BOT_TOKEN=\S+/.test(c);
    ownerEnvId = (c.match(/TG_OWNER_ID=(\d+)/) || [])[1] || null;
  } catch {}
  // Bound owner = box_owner in tg-state.json (preferred — set on bind by bux),
  // else the env-supplied TG_OWNER_ID (the legacy/manual fallback). Reading the
  // state file is best-effort: a fresh box (no bind yet) just won't have one.
  let boundOwnerId = null;
  let bound = false;
  try {
    const s = JSON.parse(fs.readFileSync("/etc/bux/tg-state.json", "utf8"));
    if (s && typeof s === "object") {
      const bo = s.box_owner;
      if (bo && typeof bo === "object" && bo.user_id) boundOwnerId = String(bo.user_id);
      const owners = s.owners;
      if (owners && typeof owners === "object" && Object.keys(owners).length > 0) bound = true;
    }
  } catch {}
  if (!bound) {
    try {
      const allow = fs.readFileSync("/etc/bux/tg-allowed.txt", "utf8");
      bound = allow.split(/\s+/).some((x) => /^-?\d+$/.test(x));
    } catch {}
  }
  execFile("systemctl", ["is-active", "bux-tg"], { timeout: 5000 }, (e, so) => {
    const active = String(so || "").trim() === "active";
    jsonRes(res, 200, {
      // `connected` = the bot is provisioned AND a chat is bound. While the bot
      // is waiting on the deeplink, hasToken is true but bound is false — the
      // UI keeps showing the pairing step until bound flips.
      connected: hasToken && (bound || Boolean(ownerEnvId)),
      active,
      ownerId: boundOwnerId || ownerEnvId,
    });
  });
}
async function handleTelegramConnect(res, body) {
  let botToken = "", ownerId = "";
  try {
    const j = JSON.parse(body || "{}");
    botToken = String(j.botToken || "").trim();
    ownerId = String(j.ownerId || "").trim();
  } catch {}
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    return jsonRes(res, 400, { error: "Bot token doesn't look right (expected 12345:ABC… from @BotFather)." });
  }
  // ownerId is now OPTIONAL. When present (advanced fallback), we still
  // validate its shape; when absent, we provision in setup-token mode.
  if (ownerId && !/^\d{3,}$/.test(ownerId)) {
    return jsonRes(res, 400, { error: "If you supply an owner id it must be numeric (message @userinfobot to get it)." });
  }
  let username = null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const j = await r.json();
    if (!j || !j.ok) return jsonRes(res, 400, { error: "Telegram rejected the token." });
    username = j.result && j.result.username;
  } catch {
    return jsonRes(res, 502, { error: "Could not reach Telegram to verify the token." });
  }
  // Setup-token mode: 24 random bytes → base64url. The Bot API's `?start=`
  // payload alphabet is [A-Za-z0-9_-] (no padding, no whitespace), which is
  // exactly base64url — safe to drop into the deeplink without further
  // escaping. 192 bits is far above the bux brute-force bar.
  const setupToken = ownerId ? null : crypto.randomBytes(24).toString("base64url");
  const lines = [`TG_BOT_TOKEN=${botToken}`];
  if (ownerId) lines.push(`TG_OWNER_ID=${ownerId}`);
  if (setupToken) lines.push(`TG_SETUP_TOKEN=${setupToken}`);
  const content = lines.join("\n") + "\n";
  // Privileged write via the narrow root helper (scoped NOPASSWD sudoers); bux
  // itself has no general sudo. tg.env content comes over stdin (never argv).
  const child = spawn("sudo", ["-n", "/usr/local/bin/hivra-tg-apply", "apply"], { env: AGENT_ENV });
  let cerr = "";
  child.stderr.on("data", (d) => { cerr += d.toString(); });
  child.stdin.write(content); child.stdin.end();
  child.on("close", (code) => {
    if (code !== 0) {
      return jsonRes(res, 500, { error: "Couldn't start the bot: " + (cerr.slice(0, 200) || "helper exit " + code) });
    }
    jsonRes(res, 200, { ok: true, botUsername: username, setupToken });
  });
  child.on("error", (e) => jsonRes(res, 500, { error: "spawn failed: " + e.message }));
}
function handleTelegramDisconnect(res) {
  const child = spawn("sudo", ["-n", "/usr/local/bin/hivra-tg-apply", "disable"], { env: AGENT_ENV });
  child.on("close", () => jsonRes(res, 200, { ok: true }));
  child.on("error", () => jsonRes(res, 500, { error: "failed" }));
}

// ---- browser automation toggle (headful Chrome + VNC view stack on/off) ----
// Disabling stops the browser stack (Chrome + Xvfb + x11vnc + noVNC) so the box
// runs ~1 CPU / 2 GB leaner and the agent loses its browser tool; enabling brings
// it back. Privileged start/stop via the narrow root helper (scoped NOPASSWD
// sudoers); bux has no general sudo. is-active reflects the real runtime state.
function handleBrowserStatus(res) {
  execFile("systemctl", ["is-active", "bux-local-browser"], { timeout: 5000 }, (e, so) => {
    jsonRes(res, 200, { enabled: String(so || "").trim() === "active" });
  });
}
function handleBrowserToggle(res, body) {
  let enabled = true;
  try { enabled = Boolean(JSON.parse(body || "{}").enabled); } catch {}
  const child = spawn("sudo", ["-n", "/usr/local/bin/hivra-browser-apply", enabled ? "enable" : "disable"], { env: AGENT_ENV });
  let cerr = "";
  child.stderr.on("data", (d) => { cerr += d.toString(); });
  child.on("close", (code) => code === 0 ? jsonRes(res, 200, { ok: true, enabled }) : jsonRes(res, 500, { error: "Couldn't toggle the browser: " + (cerr.slice(0, 200) || "helper exit " + code) }));
  child.on("error", (e) => jsonRes(res, 500, { error: "spawn failed: " + e.message }));
}

function jsonRes(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on("end", () => cb(b));
}

// Larger body reader for cookie uploads (the shared readBody caps at 100KB; a
// full browser cookie export is bigger).
function readBodyLarge(req, cb) {
  let b = ""; let tooBig = false;
  req.on("data", (c) => { b += c; if (b.length > 8 * 1024 * 1024) { tooBig = true; req.destroy(); } });
  req.on("end", () => { if (!tooBig) cb(b); });
}

// ---- cookie import: log the agent's browser into the user's accounts --------
// Parse a user-exported cookie file (Netscape cookies.txt / Cookie-Editor JSON /
// Playwright storageState) and inject it into THIS box's live Chrome over CDP, so
// the agent (and the noVNC view) is signed into the user's sites — no passwords
// shared, and far fewer datacenter-IP bot-checks. Parsed here on the box; the
// values are pushed straight into Chrome and never touch the LLM. Same idea as
// the Hermes browser-sidecar, adapted to bux-local-browser (CDP on 127.0.0.1).
const CK_CDP_PORT = Number(process.env.BUX_LOCAL_CDP_PORT || 9222);
const CK_MAX = 5000;
function ck_sameSite(v) {
  if (typeof v !== "string") return undefined;
  switch (v.trim().toLowerCase()) {
    case "strict": return "Strict";
    case "lax": return "Lax";
    case "no_restriction": case "none": return "None";
    default: return undefined;
  }
}
function ck_clean(d) { return String(d).trim().replace(/^#HttpOnly_/i, ""); }
function ck_host(c) {
  if (c.domain) return c.domain.replace(/^\./, "");
  if (c.url) { try { return new URL(c.url).hostname; } catch { return ""; } }
  return "";
}
function ck_finalize(raw) {
  const out = [];
  for (const c of raw) {
    if (!c.name || c.value == null || !c.domain) continue;
    const host = c.domain.replace(/^\./, "");
    if (!host) continue;
    const base = { name: c.name, value: c.value };
    if (c.expires) base.expires = c.expires;
    if (c.httpOnly) base.httpOnly = true;
    if (c.sameSite) base.sameSite = c.sameSite;
    if (/^__Host-/.test(c.name)) {
      // __Host- must be host-only (no Domain) + Secure; address by url.
      out.push(Object.assign({}, base, { url: "https://" + host + "/", secure: true }));
    } else {
      const secure = /^__Secure-/.test(c.name) || c.sameSite === "None" ? true : Boolean(c.secure);
      out.push(Object.assign({}, base, { domain: c.domain, path: c.path || "/", secure }));
    }
    if (out.length >= CK_MAX) break;
  }
  return out;
}
function ck_netscape(text) {
  const cookies = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const httpOnly = /^#HttpOnly_/i.test(line);
    if (line.startsWith("#") && !httpOnly) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const c = { name: String(f[5]).trim(), value: f.slice(6).join("\t"), domain: ck_clean(f[0]), path: String(f[2] || "").trim() || "/", httpOnly, secure: String(f[3]).trim().toUpperCase() === "TRUE" };
    const exp = parseInt(f[4], 10);
    if (Number.isFinite(exp) && exp > 0) c.expires = exp;
    cookies.push(c);
  }
  return cookies;
}
function ck_fromJson(o) {
  const name = o.name != null ? o.name : o.Name;
  const value = o.value != null ? o.value : o.Value;
  const domain = o.domain != null ? o.domain : (o.Domain != null ? o.Domain : o.host);
  if (typeof name !== "string" || value == null || typeof domain !== "string") return null;
  let expires;
  const e = o.expirationDate != null ? o.expirationDate : (o.expires != null ? o.expires : o.expiry);
  if (typeof e === "number" && e > 0) expires = e > 1e12 ? Math.floor(e / 1000) : Math.floor(e);
  const c = { name, value: String(value), domain: ck_clean(domain), path: (typeof o.path === "string" && o.path) ? o.path : "/", httpOnly: Boolean(o.httpOnly != null ? o.httpOnly : o.HttpOnly), secure: Boolean(o.secure != null ? o.secure : o.Secure) };
  if (expires) c.expires = expires;
  const ss = ck_sameSite(o.sameSite != null ? o.sameSite : o.SameSite);
  if (ss) c.sameSite = ss;
  return c;
}
function parseCookies(input) {
  const t = String(input || "").trim();
  if (!t) throw new Error("empty cookie file");
  let cookies, format;
  if (t[0] === "{" || t[0] === "[") {
    let j;
    try { j = JSON.parse(t); } catch { throw new Error("file looks like JSON but did not parse"); }
    if (Array.isArray(j)) { cookies = j.filter((x) => x && typeof x === "object").map(ck_fromJson).filter(Boolean); format = "cookie-editor-json"; }
    else if (j && typeof j === "object" && Array.isArray(j.cookies)) { cookies = j.cookies.filter((x) => x && typeof x === "object").map(ck_fromJson).filter(Boolean); format = "storage-state"; }
    else throw new Error("unrecognised JSON cookie shape");
  } else { cookies = ck_netscape(t); format = "netscape"; }
  const finalized = ck_finalize(cookies);
  if (!finalized.length) throw new Error("no valid cookies found in file");
  const domains = Array.from(new Set(finalized.map(ck_host).filter(Boolean))).sort();
  return { cookies: finalized, format, domains };
}
function ck_rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const h = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id === id) { ws.removeEventListener("message", h); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
// Inject into the box's live Chrome (the persistent profile the agent drives) via
// CDP Storage.setCookies. Bulk first, then per-cookie so one bad cookie from a
// big "export all" can't sink the whole import.
async function injectCookiesViaCdp(cookies) {
  let ver;
  try { ver = await (await fetch("http://127.0.0.1:" + CK_CDP_PORT + "/json/version")).json(); }
  catch { throw new Error("BROWSER_OFF"); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp connect failed")); });
  let imported = 0;
  try {
    try { await ck_rpc(ws, "Storage.setCookies", { cookies }); imported = cookies.length; }
    catch { for (const c of cookies) { try { await ck_rpc(ws, "Storage.setCookies", { cookies: [c] }); imported += 1; } catch {} } }
  } finally { try { ws.close(); } catch {} }
  return { imported, skipped: cookies.length - imported };
}
function handleCookieImport(res, body) {
  if (!API_TOKEN) return jsonRes(res, 403, { ok: false, error: "writes are disabled on this box (no API token)" });
  let q; try { q = JSON.parse(body || "{}"); } catch { return jsonRes(res, 400, { ok: false, error: "bad json" }); }
  const file = typeof q.file === "string" ? q.file : "";
  if (!file) return jsonRes(res, 400, { ok: false, error: "No cookie file provided." });
  let parsed;
  try { parsed = parseCookies(file); }
  catch { return jsonRes(res, 400, { ok: false, error: "We couldn't read that cookie file — try re-exporting it." }); }
  if (q.dryRun) return jsonRes(res, 200, { ok: true, dryRun: true, count: parsed.cookies.length, format: parsed.format, domains: parsed.domains });
  injectCookiesViaCdp(parsed.cookies)
    .then((r) => jsonRes(res, 200, { ok: true, imported: r.imported, skipped: r.skipped, format: parsed.format, domains: parsed.domains }))
    .catch((e) => e && e.message === "BROWSER_OFF"
      ? jsonRes(res, 409, { ok: false, error: "Turn on browser automation for this agent first (Manage tab), then try again." })
      : jsonRes(res, 500, { ok: false, error: "Couldn't load the cookies into the browser. Try again." }));
}

function serveFile(res, file, type) {
  fs.readFile(path.join(DIR, file), (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// ---- git explorer (status / diff / commit / checkout) -----------------------
// Token-gated views + operations on any git repo under the visible workspace. All invocations go
// through execFile (no shell), -C <abs repo>, with timeouts and output caps.
const GIT = process.env.GIT_BIN || "/usr/bin/git";
const GIT_OPTS = { timeout: 15000, maxBuffer: 1024 * 1024, env: AGENT_ENV, cwd: WORKSPACE_ROOT };
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,100}$/;

function gitRoot(dirRel, cb) {
  const dir = clampHome(dirRel || ".");
  if (!dir) return cb(null);
  execFile(GIT, ["-C", dir, "rev-parse", "--show-toplevel"], GIT_OPTS, (err, so) => {
    if (err) return cb(null);
    const root = String(so || "").trim();
    // The repo root itself must stay under the visible workspace.
    cb(root === WORKSPACE_ROOT || root.startsWith(WORKSPACE_ROOT + path.sep) ? root : null);
  });
}

function handleGitStatus(res, q) {
  gitRoot(q.get("dir"), (root) => {
    if (!root) return jsonRes(res, 200, { repo: false });
    execFile(GIT, ["-C", root, "status", "--porcelain=v1", "-z"], GIT_OPTS, (e1, so1) => {
      if (e1) return jsonRes(res, 500, { error: "git status failed" });
      const entries = [];
      for (const rec of String(so1 || "").split("\0")) {
        if (!rec || rec.length < 4) continue;
        if (entries.length >= 500) break;
        entries.push({ x: rec[0], y: rec[1], path: rec.slice(3) });
      }
      execFile(GIT, ["-C", root, "branch", "--format=%(refname:short)"], GIT_OPTS, (e2, so2) => {
        const branches = String(so2 || "").split("\n").map((b) => b.trim()).filter(Boolean).slice(0, 50);
        execFile(GIT, ["-C", root, "branch", "--show-current"], GIT_OPTS, (e3, so3) => {
          const branch = String(so3 || "").trim() || null;
          execFile(GIT, ["-C", root, "log", "-1", "--format=%h %s"], GIT_OPTS, (e4, so4) => {
            jsonRes(res, 200, { repo: true, root: path.relative(WORKSPACE_ROOT, root) || ".", branch, branches, entries, lastCommit: e4 ? null : String(so4 || "").trim() || null });
          });
        });
      });
    });
  });
}

function handleGitDiff(res, q) {
  gitRoot(q.get("dir"), (root) => {
    if (!root) return jsonRes(res, 400, { error: "not a git repo" });
    const rel = String(q.get("path") || "");
    if (!rel || rel.includes("..") || rel.startsWith("/") || rel.startsWith("-")) return jsonRes(res, 400, { error: "bad path" });
    const workspaceRelative = path.relative(WORKSPACE_ROOT, path.join(root, rel));
    try { GUARDED_FILES.inspectFile(workspaceRelative, true); }
    catch (error) { return fileError(res, error); }
    // Untracked files have no diff — return the file content as an "all new" view.
    execFile(GIT, ["--literal-pathspecs", "-C", root, "status", "--porcelain=v1", "--", rel], GIT_OPTS, (e0, so0) => {
      if (e0) return jsonRes(res, 500, { error: "git status failed" });
      const st = String(so0 || "").slice(0, 2);
      if (st === "??") {
        try {
          return jsonRes(res, 200, { diff: GUARDED_FILES.read(workspaceRelative, 256 * 1024).content, untracked: true });
        } catch (error) {
          if (error.code === "HIVRA_FILE_SIZE") return jsonRes(res, 200, { diff: "(new file, too large to preview)", untracked: true });
          return fileError(res, error);
        }
      }
      execFile(GIT, ["--literal-pathspecs", "-C", root, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", rel], GIT_OPTS, (e1, so1) => {
        if (e1) return jsonRes(res, 500, { error: "git diff failed" });
        jsonRes(res, 200, { diff: String(so1 || "").slice(0, 256 * 1024), untracked: false });
      });
    });
  });
}

function handleGitCommit(res, body) {
  let dir = "", message = "", paths = [];
  try { const j = JSON.parse(body || "{}"); dir = String(j.dir || "."); message = String(j.message || "").trim(); paths = Array.isArray(j.paths) ? j.paths.map(String) : []; } catch {}
  if (!message || message.length > 500) return jsonRes(res, 400, { error: "commit message required (max 500 chars)" });
  if (!paths.length || paths.length > 200) return jsonRes(res, 400, { error: "select 1-200 files to commit" });
  if (paths.some((p) => !p || p.includes("..") || p.startsWith("/") || p.startsWith("-"))) return jsonRes(res, 400, { error: "bad path in selection" });
  gitRoot(dir, (root) => {
    if (!root) return jsonRes(res, 400, { error: "not a git repo" });
    execFile(GIT, ["-C", root, "add", "--", ...paths], GIT_OPTS, (e1, _o, se1) => {
      if (e1) return jsonRes(res, 500, { error: "git add failed: " + String(se1 || "").slice(0, 200) });
      // Fall back to a box identity only when the user never configured one
      // (-c would otherwise override their real identity).
      execFile(GIT, ["-C", root, "config", "user.email"], GIT_OPTS, (eId, soId) => {
        const idArgs = String(soId || "").trim() ? [] : ["-c", "user.name=Hivra Box", "-c", "user.email=box@hivra.cloud"];
        execFile(GIT, ["-C", root, ...idArgs, "commit", "-m", message], GIT_OPTS, (e2, so2, se2) => {
          if (e2) return jsonRes(res, 500, { error: "git commit failed: " + String(se2 || so2 || "").slice(0, 200) });
          execFile(GIT, ["-C", root, "log", "-1", "--format=%h %s"], GIT_OPTS, (e3, so3) => {
            jsonRes(res, 200, { ok: true, commit: String(so3 || "").trim() });
          });
        });
      });
    });
  });
}

function handleGitCheckout(res, body) {
  let dir = "", branch = "", create = false;
  try { const j = JSON.parse(body || "{}"); dir = String(j.dir || "."); branch = String(j.branch || "").trim(); create = Boolean(j.create); } catch {}
  if (!BRANCH_RE.test(branch)) return jsonRes(res, 400, { error: "branch name doesn't look right" });
  gitRoot(dir, (root) => {
    if (!root) return jsonRes(res, 400, { error: "not a git repo" });
    const args = create ? ["-C", root, "checkout", "-b", branch] : ["-C", root, "checkout", branch];
    execFile(GIT, args, GIT_OPTS, (e1, so1, se1) => {
      if (e1) return jsonRes(res, 500, { error: String(se1 || so1 || "checkout failed").slice(0, 200) });
      jsonRes(res, 200, { ok: true, branch });
    });
  });
}

// ---- uploads (chat attachments) ---------------------------------------------
// Token-REQUIRED (like file writes). Images land in ~/uploads and the chat
// references them by path (codex: -i flag; claude: reads the path itself).
const UPLOAD_MAX = 8 * 1024 * 1024; // decoded bytes
function handleUpload(req, res) {
  if (!API_TOKEN) return jsonRes(res, 403, { error: "uploads are disabled on this box (no API token)" });
  let body = "";
  let over = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > UPLOAD_MAX * 1.5) { over = true; req.destroy(); }
  });
  req.on("end", () => {
    if (over) return jsonRes(res, 413, { error: "file too large (>8MB)" });
    let name = "", data = "";
    try { const j = JSON.parse(body || "{}"); name = String(j.name || ""); data = String(j.dataBase64 || ""); } catch {}
    name = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    if (!name || !data) return jsonRes(res, 400, { error: "need name + dataBase64" });
    let buf;
    try { buf = Buffer.from(data, "base64"); } catch { return jsonRes(res, 400, { error: "bad base64" }); }
    if (!buf.length || buf.length > UPLOAD_MAX) return jsonRes(res, 413, { error: "file too large (>8MB)" });
    try {
      const dir = path.join(HOME, "uploads");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, Date.now() + "-" + name);
      fs.writeFileSync(file, buf);
      jsonRes(res, 200, { ok: true, path: file, rel: path.relative(HOME, file) });
    } catch (e) { jsonRes(res, 500, { error: String((e && e.message) || e) }); }
  });
}

// ---- MCP server management ----------------------------------------------------
// claude: drive the official `claude mcp` CLI (user scope) and read the result
// back from ~/.claude.json. codex: prefer `codex mcp`; fall back to editing
// ~/.codex/config.toml [mcp_servers.<name>] sections directly.
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

function listMcpClaude() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, ".claude.json"), "utf8"));
    const servers = j && j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {};
    return Object.keys(servers).slice(0, 50).map((name) => ({
      name,
      command: String(servers[name].command || servers[name].url || ""),
      args: Array.isArray(servers[name].args) ? servers[name].args.map(String) : [],
    }));
  } catch { return []; }
}
function listMcpCodex() {
  try {
    const toml = fs.readFileSync(path.join(HOME, ".codex", "config.toml"), "utf8");
    const out = [];
    const re = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm;
    let m;
    while ((m = re.exec(toml)) && out.length < 50) {
      const tail = toml.slice(m.index + m[0].length);
      const section = tail.slice(0, (tail.match(/^\[/m) || { index: tail.length }).index);
      const cmd = (section.match(/^command\s*=\s*"([^"]*)"/m) || [])[1] || "";
      let args = [];
      const am = section.match(/^args\s*=\s*\[([^\]]*)\]/m);
      if (am) args = (am[1].match(/"((?:[^"\\]|\\.)*)"/g) || []).map((s) => s.slice(1, -1));
      out.push({ name: m[1], command: cmd, args });
    }
    return out;
  } catch { return []; }
}
function handleMcpList(res) {
  if (AGENT_KIND === "codex") return jsonRes(res, 200, { servers: listMcpCodex() });
  return jsonRes(res, 200, { servers: listMcpClaude() });
}
function handleMcpAdd(res, body) {
  let name = "", command = "", args = [];
  try { const j = JSON.parse(body || "{}"); name = String(j.name || "").trim(); command = String(j.command || "").trim(); args = Array.isArray(j.args) ? j.args.map(String).slice(0, 20) : []; } catch {}
  if (!MCP_NAME_RE.test(name)) return jsonRes(res, 400, { error: "server name: letters, digits, _ or - (max 40)" });
  if (!command || command.length > 300 || command.startsWith("-")) return jsonRes(res, 400, { error: "command required" });
  if (args.some((a) => a.length > 200)) return jsonRes(res, 400, { error: "argument too long" });
  if (AGENT_KIND === "codex") {
    execFile(CODEX, ["mcp", "add", name, "--", command, ...args], { env: AGENT_ENV, cwd: HOME, timeout: 15000 }, (err, so, se) => {
      if (!err) return jsonRes(res, 200, { ok: true });
      // Older codex without `mcp` subcommands: append the TOML section ourselves.
      try {
        const file = path.join(HOME, ".codex", "config.toml");
        let toml = ""; try { toml = fs.readFileSync(file, "utf8"); } catch {}
        if (new RegExp("^\\[mcp_servers\\." + name + "\\]\\s*$", "m").test(toml)) return jsonRes(res, 409, { error: "a server with that name already exists" });
        const block = "\n[mcp_servers." + name + "]\ncommand = " + JSON.stringify(command) + "\nargs = [" + args.map((a) => JSON.stringify(a)).join(", ") + "]\n";
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, block);
        jsonRes(res, 200, { ok: true });
      } catch (e) { jsonRes(res, 500, { error: String((e && e.message) || e) }); }
    });
    return;
  }
  execFile(CLAUDE, ["mcp", "add", "-s", "user", name, "--", command, ...args], { env: AGENT_ENV, cwd: HOME, timeout: 15000 }, (err, so, se) => {
    if (err) return jsonRes(res, 500, { error: "claude mcp add failed: " + String(se || so || "").slice(0, 200) });
    jsonRes(res, 200, { ok: true });
  });
}
function handleMcpRemove(res, name) {
  if (!MCP_NAME_RE.test(name)) return jsonRes(res, 400, { error: "bad name" });
  if (AGENT_KIND === "codex") {
    execFile(CODEX, ["mcp", "remove", name], { env: AGENT_ENV, cwd: HOME, timeout: 15000 }, (err) => {
      if (!err) return jsonRes(res, 200, { ok: true });
      try {
        const file = path.join(HOME, ".codex", "config.toml");
        const toml = fs.readFileSync(file, "utf8");
        // Strip the section: its header through (not including) the next header.
        const re = new RegExp("^\\[mcp_servers\\." + name + "\\][^]*?(?=^\\[|$(?![^]))", "m");
        if (!re.test(toml)) return jsonRes(res, 404, { error: "not found" });
        fs.writeFileSync(file, toml.replace(re, ""));
        jsonRes(res, 200, { ok: true });
      } catch (e) { jsonRes(res, 500, { error: String((e && e.message) || e) }); }
    });
    return;
  }
  execFile(CLAUDE, ["mcp", "remove", "-s", "user", name], { env: AGENT_ENV, cwd: HOME, timeout: 15000 }, (err, so, se) => {
    if (err) return jsonRes(res, 500, { error: "claude mcp remove failed: " + String(se || so || "").slice(0, 200) });
    jsonRes(res, 200, { ok: true });
  });
}

// ---- permission presets -------------------------------------------------------
// ~/.hivra/agent-restrict: "" (full, today's behavior) | "limited" | "readonly".
// claude: limited = keep YOLO but --disallowedTools Bash; readonly = drop
// --dangerously-skip-permissions (headless print mode then auto-denies mutating
// tools). codex: limited = --sandbox workspace-write; readonly = --sandbox
// read-only (both replace the bypass flag). Absent file = exactly current args.
const RESTRICTS = ["", "limited", "readonly"];
function readRestrict() {
  try {
    const v = fs.readFileSync(path.join(HOME, ".hivra", "agent-restrict"), "utf8").trim();
    if (RESTRICTS.includes(v)) return v;
  } catch {}
  return "";
}
function handleRestrictGet(res) {
  jsonRes(res, 200, { restrict: readRestrict() || null, agentKind: AGENT_KIND });
}
function handleRestrictSet(res, body) {
  let v = "";
  try { v = String((JSON.parse(body || "{}")).restrict || "").trim(); } catch {}
  if (!RESTRICTS.includes(v)) return jsonRes(res, 400, { ok: false, error: "restrict must be one of: (empty), limited, readonly" });
  const file = path.join(HOME, ".hivra", "agent-restrict");
  try {
    if (!v) { try { fs.unlinkSync(file); } catch {} return jsonRes(res, 200, { ok: true, restrict: null }); }
    fs.writeFileSync(file, v + "\n");
    jsonRes(res, 200, { ok: true, restrict: v });
  } catch (e) { jsonRes(res, 500, { ok: false, error: String((e && e.message) || e) }); }
}

// ---- per-box model override ------------------------------------------------
// The dashboard's Manage tab writes ~/.hivra/agent-model; each chat spawn reads
// it fresh, so a change applies on the NEXT turn with no service restart. Empty/
// absent = the CLI's own default. Charset-clamped on write AND read (defense).
// Brackets are real: claude accepts "sonnet[1m]" / "claude-opus-4-8[1m]" aliases.
const MODEL_RE = /^[A-Za-z0-9._:\/\[\]-]{1,64}$/;
function readAgentModel() {
  try {
    const m = fs.readFileSync(path.join(HOME, ".hivra", "agent-model"), "utf8").trim();
    if (m && MODEL_RE.test(m)) return m;
  } catch {}
  return "";
}
function handleModelGet(res) {
  jsonRes(res, 200, { agentKind: AGENT_KIND, model: readAgentModel() || null });
}
function handleModelSet(res, body) {
  let model = "";
  try { model = String((JSON.parse(body || "{}")).model || "").trim(); } catch {}
  const file = path.join(HOME, ".hivra", "agent-model");
  try {
    if (!model) {
      try { fs.unlinkSync(file); } catch {}
      return jsonRes(res, 200, { ok: true, model: null });
    }
    if (!MODEL_RE.test(model)) return jsonRes(res, 400, { ok: false, error: "model id doesn't look right (letters, digits, . _ : / - only, max 64)" });
    fs.writeFileSync(file, model + "\n");
    jsonRes(res, 200, { ok: true, model });
  } catch (e) { jsonRes(res, 500, { ok: false, error: String((e && e.message) || e) }); }
}

// ---- alternative LLM provider (Venice byok / managed gateway) ----------------
// ~/.hivra/llm-provider.json: { provider:"venice", baseUrl, apiKey, model }.
// Legacy provision/bootstrap and explicit POST /api/llm remain compatible until
// the control plane adopts /api/llm/application. V1 receipts then fence legacy
// writes. Each chat spawn reads it fresh — set/clear applies on the
// NEXT turn, no restart. codex-only today: codex accepts per-spawn custom
// model_providers overrides (-c flags + env_key); claude speaks Anthropic
// Messages and needs the gateway shim before it can point anywhere else.
const LLM_FILE = () => path.join(HOME, ".hivra", "llm-provider.json");
const LLM_BASEURL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._\/-]*)?$/;
const LLM_KEY_RE = /^[\x21-\x7e]{8,256}$/; // printable ASCII, no spaces
const llmApplication = createLlmApplicationStore({ directory: path.join(HOME, ".hivra"), apiToken: API_TOKEN, runtime: AGENT_KIND });
function readLlmProvider() {
  if (AGENT_KIND === "codex") return llmApplication.readProvider();
  try {
    const j = JSON.parse(fs.readFileSync(LLM_FILE(), "utf8"));
    if (
      j && j.provider === "venice" &&
      typeof j.baseUrl === "string" && LLM_BASEURL_RE.test(j.baseUrl) &&
      typeof j.apiKey === "string" && LLM_KEY_RE.test(j.apiKey)
    ) {
      return {
        provider: "venice",
        baseUrl: j.baseUrl.replace(/\/+$/, ""),
        apiKey: j.apiKey,
        model: typeof j.model === "string" && MODEL_RE.test(j.model) ? j.model : "",
      };
    }
  } catch {}
  return null;
}
// ---- OpenClaw model provider (managed Venice / BYO any) ---------------------
// OpenClaw is a daemon that reads its provider from ~/.openclaw/openclaw.json, not
// the per-spawn ~/.hivra/llm-provider.json the chat CLIs use. So for openclaw the
// /api/llm endpoint writes the provider into openclaw.json via the gateway's OWN
// schema-validated config writer (`openclaw config patch` — a bad patch is rejected
// rather than crash-looping the daemon) and restarts the gateway. Supports managed
// Venice + BYO any: OpenAI-compatible (api openai-completions, baseUrl+key) and
// Anthropic (api anthropic-messages, key only). Key rides browser→box direct.
const OC_CFG = () => path.join(HOME, ".openclaw", "openclaw.json");
const OC_PROVIDER_RE = /^[a-z][a-z0-9-]{0,30}$/;
const OC_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
function readOpenclawProvider() {
  try {
    const j = JSON.parse(fs.readFileSync(OC_CFG(), "utf8"));
    const primary = j && j.agents && j.agents.defaults && j.agents.defaults.model && j.agents.defaults.model.primary;
    const providers = (j && j.models && j.models.providers) || {};
    if (typeof primary === "string" && primary.includes("/")) {
      const id = primary.slice(0, primary.indexOf("/"));
      const p = providers[id] || {};
      return { provider: id, api: p.api || null, baseUrl: p.baseUrl || null, model: primary.slice(primary.indexOf("/") + 1) || null, hasKey: Boolean(p.apiKey) };
    }
  } catch {}
  return null;
}
function applyOpenclawLlm(res, j) {
  const provider = String((j && j.provider) || "").toLowerCase();
  // `api` is optional: the existing dashboard venice payload omits it, so default
  // by provider — anthropic → anthropic-messages, everything else (venice/openai/
  // any OpenAI-compatible) → openai-completions. Callers may pass it explicitly for BYO.
  const api = String((j && j.api) || (provider === "anthropic" ? "anthropic-messages" : "openai-completions")).toLowerCase();
  const apiKey = String((j && j.apiKey) || "");
  const model = String((j && j.model) || "");
  const baseUrl = typeof (j && j.baseUrl) === "string" ? j.baseUrl.replace(/\/+$/, "") : "";
  if (!OC_PROVIDER_RE.test(provider)) return jsonRes(res, 400, { ok: false, error: "provider id looks wrong (lowercase letters/digits/-, max 31)" });
  if (!OC_APIS.has(api)) return jsonRes(res, 400, { ok: false, error: "unsupported api (openai-completions | anthropic-messages | openai-responses)" });
  if (!LLM_KEY_RE.test(apiKey)) return jsonRes(res, 400, { ok: false, error: "apiKey doesn't look right" });
  if (!MODEL_RE.test(model)) return jsonRes(res, 400, { ok: false, error: "model id doesn't look right" });
  const needsBase = api !== "anthropic-messages";
  if (needsBase && !LLM_BASEURL_RE.test(baseUrl)) return jsonRes(res, 400, { ok: false, error: "baseUrl doesn't look right (https URL)" });
  const block = { api, apiKey, models: [{ id: model, name: model, contextWindow: 200000, maxTokens: 8192, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false }] };
  if (needsBase) block.baseUrl = baseUrl;
  const primary = provider + "/" + model;
  // agents.defaults.model = { primary } and agents.defaults.models = { "<primary>": {} }
  // are SIBLINGS under defaults (the runtime loader is lax, but `config patch` is
  // schema-strict and rejects models nested under model).
  const patch = {
    models: { mode: "merge", providers: { [provider]: block } },
    agents: { defaults: { model: { primary }, models: { [primary]: {} } } },
  };
  // 1) schema-validated write of the provider block.
  const cp = spawn("openclaw", ["config", "patch", "--stdin"], { env: AGENT_ENV });
  let cperr = "";
  cp.stderr.on("data", (d) => { cperr += d; });
  cp.on("error", (e) => jsonRes(res, 500, { ok: false, error: "config patch spawn failed: " + e.message }));
  cp.on("close", (code) => {
    if (code !== 0) return jsonRes(res, 400, { ok: false, error: "config rejected: " + (cperr.slice(0, 300) || ("exit " + code)) });
    // 2) restart the gateway so the new provider loads (scoped sudo helper).
    const rs = spawn("sudo", ["-n", "/usr/local/bin/hivra-openclaw-apply", "restart"], { env: AGENT_ENV });
    let rserr = "";
    rs.stderr.on("data", (d) => { rserr += d; });
    rs.on("error", (e) => jsonRes(res, 500, { ok: false, error: "restart spawn failed: " + e.message }));
    rs.on("close", (rc) => {
      if (rc !== 0) return jsonRes(res, 500, { ok: false, error: "gateway restart failed: " + (rserr.slice(0, 200) || ("exit " + rc)) });
      jsonRes(res, 200, { ok: true, provider, api, model });
    });
  });
  try { cp.stdin.write(JSON.stringify(patch)); cp.stdin.end(); } catch (e) { /* close handler reports */ }
}

function handleLlmGet(res) {
  res.setHeader("Cache-Control", "no-store");
  if (AGENT_KIND === "codex") {
    try {
      const state = llmApplication.inspect();
      return jsonRes(res, 200, { agentKind: AGENT_KIND, provider: state.provider, model: state.model, providerChatProtocol: "responses-v1" });
    } catch (error) { return llmApplicationFailure(res, error); }
  }
  if (AGENT_KIND === "openclaw") {
    const oc = readOpenclawProvider();
    // Never echo the key.
    return jsonRes(res, 200, { agentKind: AGENT_KIND, provider: oc ? oc.provider : null, api: oc ? oc.api : null, baseUrl: oc ? oc.baseUrl : null, model: oc ? oc.model : null, configured: Boolean(oc && oc.hasKey) });
  }
  const llm = readLlmProvider();
  // Never echo the key — the dashboard server is the only key custodian.
  jsonRes(res, 200, { agentKind: AGENT_KIND, provider: llm ? llm.provider : null, model: llm ? llm.model || null : null });
}
function handleLlmSet(res, body) {
  res.setHeader("Cache-Control", "no-store");
  let j;
  try { j = JSON.parse(body); } catch { return llmApplicationFailure(res, new LlmApplicationError("invalid_request")); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return llmApplicationFailure(res, new LlmApplicationError("invalid_request"));
  try {
    // OpenClaw stores its provider in openclaw.json (daemon), not the per-spawn
    // ~/.hivra/llm-provider.json — and it must always have one (no keyless box).
    if (AGENT_KIND === "openclaw") {
      if (!j || !j.provider) return jsonRes(res, 400, { ok: false, error: "OpenClaw needs a provider — pick managed Venice or paste a key" });
      return applyOpenclawLlm(res, j);
    }
    if (AGENT_KIND !== "codex") return jsonRes(res, 400, { ok: false, error: "alternative LLM providers aren't supported for this agent yet" });
    const clear = Object.keys(j).length === 0 || (Object.keys(j).length === 1 && j.provider === null);
    const state = llmApplication.applyLegacy(clear ? null : j);
    jsonRes(res, 200, { ok: true, provider: state.provider, model: state.model });
  } catch (error) { llmApplicationFailure(res, error); }
}

function llmApplicationFailure(res, error) {
  const code = error instanceof LlmApplicationError ? error.code : "storage_unavailable";
  const status = code === "invalid_request" ? 400
    : ["state_conflict", "operation_conflict", "application_protocol_required", "unsupported_runtime"].includes(code) ? 409 : 503;
  res.setHeader("Cache-Control", "no-store");
  jsonRes(res, status, { ok: false, code, error: "Model settings could not be confirmed. Check the recorded operation before retrying." });
}

function handleLlmApplication(req, res) {
  res.setHeader("Cache-Control", "no-store");
  // Durable application is a control-plane protocol, not ambient cookie auth.
  if (!bearerAuthed(req)) return jsonRes(res, 401, { ok: false, error: "unauthorized" });
  if (req.method === "GET") {
    try { return jsonRes(res, 200, { ok: true, ...llmApplication.inspect() }); }
    catch (error) { return llmApplicationFailure(res, error); }
  }
  if (req.method !== "POST") return jsonRes(res, 405, { ok: false, error: "method_not_allowed" });
  let body = "", size = 0, done = false;
  const timeout = setTimeout(() => {
    if (done) return;
    done = true;
    res.setHeader("Connection", "close");
    res.once("finish", () => req.destroy());
    jsonRes(res, 408, { ok: false, code: "request_timeout" });
  }, 5000);
  req.on("data", chunk => {
    if (done) return;
    size += chunk.length;
    if (size > 16 * 1024) {
      done = true; clearTimeout(timeout);
      res.setHeader("Connection", "close");
      res.once("finish", () => req.destroy());
      jsonRes(res, 413, { ok: false, code: "request_too_large" });
    } else body += chunk;
  });
  req.on("aborted", () => { done = true; clearTimeout(timeout); });
  req.on("error", () => { done = true; clearTimeout(timeout); });
  req.on("end", () => {
    clearTimeout(timeout);
    if (done) return;
    done = true;
    let input;
    try { input = JSON.parse(body); }
    catch { return llmApplicationFailure(res, new LlmApplicationError("invalid_request")); }
    try { jsonRes(res, 200, { ok: true, ...llmApplication.apply(input) }); }
    catch (error) { llmApplicationFailure(res, error); }
  });
}

// Generic-agent command (for any CLI with NO structured output). Configured by
// the provisioner as JSON at ~/.hivra/agent-cmd.json:
//   { "bin": "/path/to/cli", "args": ["--flag"], "promptVia": "stdin" | "arg" }
// or the HIVRA_AGENT_CMD env (bin only, prompt via stdin). The prompt is passed
// via stdin or as a spawn arg (execve, no shell) so arbitrary user text is safe.
function readGenericCmd() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, ".hivra", "agent-cmd.json"), "utf8"));
    if (j && typeof j.bin === "string" && j.bin) {
      return { bin: j.bin, args: Array.isArray(j.args) ? j.args.map(String) : [], promptVia: j.promptVia === "arg" ? "arg" : "stdin" };
    }
  } catch {}
  if (process.env.HIVRA_AGENT_CMD) return { bin: process.env.HIVRA_AGENT_CMD, args: [], promptVia: "stdin" };
  return null;
}

// Resolve how to spawn the agent for one chat turn. `textMode` distinguishes the
// two stream shapes: structured agents (claude/codex) emit their own NDJSON which
// we pass through; a generic agent emits plain text which we wrap as `_text`.
function resolveChatSpawn(message, sessionId, images) {
  if (COMPUTER_PROFILE) return { error: "this computer has no agent chat surface" };
  if (AGENT_KIND === "aeon" || AGENT_KIND === "openclaw" || AGENT_KIND === "agent-zero") {
    // Aeon + OpenClaw + Agent Zero are hosted dashboards, not chat-CLI agents — no
    // /api/chat surface; the user works in the agent's own web UI behind the gate.
    return { error: "this agent has no chat surface" };
  }
  const restrict = readRestrict();
  if (AGENT_KIND === "codex") {
    // codex exec [resume <id>] --json … <prompt>. --dangerously-bypass… is the
    // YOLO mode for a single-tenant box the user owns. NOTE: `exec resume` does
    // NOT accept -C/--cd (it reuses the session cwd; we also spawn with cwd=HOME),
    // so -C only goes on fresh runs — passing it to resume kills every 2nd turn.
    // -m and -i ARE accepted by both fresh and resume (verified via --help).
    const flags = ["--json", "--skip-git-repo-check"];
    if (restrict === "readonly") flags.push("--sandbox", "read-only");
    else if (restrict === "limited") flags.push("--sandbox", "workspace-write");
    else flags.push("--dangerously-bypass-approvals-and-sandbox");
    // Alternative LLM provider: define a custom model_provider per spawn via -c
    // overrides (never touching ~/.codex/config.toml — marketplaces own writes
    // there) and pass the key via env_key indirection so it never hits argv.
    // While active, the provider's model wins over the agent-model override —
    // ChatGPT model ids (gpt-5.5 etc.) don't exist on Venice.
    const llm = readLlmProvider();
    let llmEnv = null;
    if (llm) {
      flags.push(
        "-c", 'model_providers.venice.name="Venice"',
        "-c", `model_providers.venice.base_url="${llm.baseUrl}"`,
        "-c", 'model_providers.venice.env_key="HIVRA_LLM_API_KEY"',
        "-c", 'model_providers.venice.wire_api="responses"',
        "-c", 'model_providers.venice.requires_openai_auth=false',
        "-c", 'model_providers.venice.supports_websockets=false',
        "-c", 'web_search="disabled"',
        "-c", 'model_provider="venice"',
      );
      if (llm.model) flags.push("-m", llm.model);
      // Layer the Venice key onto the full chat env (chatSpawnEnv includes the
      // bankr wallet vars), not bare AGENT_ENV — so venice + bankr coexist.
      llmEnv = Object.assign({}, chatSpawnEnv(), { HIVRA_LLM_API_KEY: llm.apiKey });
    } else {
      const model = readAgentModel();
      if (model) flags.push("-m", model);
    }
    for (const img of images || []) flags.push("-i", img);
    const args = (sessionId && /^[0-9a-f-]{8,}$/i.test(sessionId))
      ? ["exec", "resume", ...flags, sessionId, message]
      : ["exec", ...flags, "-C", HOME, message];
    return { bin: CODEX, args, useStdin: false, textMode: false, env: llmEnv };
  }
  if (AGENT_KIND === "generic") {
    const cmd = readGenericCmd();
    if (!cmd) return { error: "no generic agent command configured (~/.hivra/agent-cmd.json)" };
    const args = cmd.promptVia === "arg" ? [...cmd.args, message] : [...cmd.args];
    return { bin: cmd.bin, args, useStdin: cmd.promptVia !== "arg", textMode: true };
  }
  // claude: restrict=readonly drops the permission skip (headless print mode then
  // auto-denies mutating tools); limited keeps it but disallows the shell.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (restrict !== "readonly") args.push("--dangerously-skip-permissions");
  if (restrict === "limited") args.push("--disallowedTools", "Bash");
  const model = readAgentModel();
  if (model) args.push("--model", model); // alias (sonnet/opus/haiku) or full id
  if (sessionId && /^[0-9a-f-]{8,}$/i.test(sessionId)) args.push("--resume", sessionId);
  return { bin: CLAUDE, args, useStdin: true, textMode: false }; // claude reads the prompt from stdin
}

// Chat turns run detached from the HTTP request that starts them (see
// ./chat-runs.cjs): the request starts a run and tails its log, so closing the
// browser no longer ends the agent's work. Only chat runtimes load the store.
const CHAT_RUNS_MODULE = !COMPUTER_PROFILE && ["claude", "codex", "generic"].includes(AGENT_KIND) ? require("./chat-runs.cjs") : null;
const CHAT_RUNS = CHAT_RUNS_MODULE ? CHAT_RUNS_MODULE.createChatRunStore({ root: path.join(HOME, ".hivra", "chat-runs") }) : null;
function logChatStreamError(error) {
  console.error("hivra-chat: chat run stream failed: " + ((error && error.stack) || error));
}
const CHAT_STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  "Connection": "keep-alive",
  "Access-Control-Expose-Headers": "X-Hivra-Run-Id, X-Hivra-Run-State",
};

function admittedAttachmentPaths(raw) {
  // Validate actual filesystem objects, not just names. This prevents accidental
  // alias disclosure; it is not a sandbox against the same user's running CLI,
  // which already has filesystem authority and can change/read its own files.
  const admitted = [];
  for (const relative of (Array.isArray(raw) ? raw.map(String).slice(0, 5) : [])) {
    try { admitted.push(GUARDED_FILES.inspectFile(relative).filename); } catch {}
  }
  return admitted;
}
function handleChat(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on("end", () => {
    let message, sessionId, imagesRaw, runId, clientRef, detach;
    try {
      const j = JSON.parse(body);
      message = j.message; sessionId = j.sessionId; imagesRaw = j.images;
      runId = j.runId; clientRef = j.clientRef; detach = j.detach === true;
    }
    catch (e) { res.writeHead(400); return res.end("bad json"); }
    if (!message || typeof message !== "string") { res.writeHead(400); return res.end("no message"); }

    // Attachments: previously-uploaded paths under HOME. codex takes them as -i
    // flags; claude/generic get a path preamble and read the files themselves.
    const images = admittedAttachmentPaths(imagesRaw);
    let sendMsg = message;
    if (images.length && AGENT_KIND !== "codex") {
      sendMsg = "Attached file(s) from the user — read them as needed:\n" + images.join("\n") + "\n\n" + message;
    }

    let spawnCfg;
    try { spawnCfg = resolveChatSpawn(sendMsg, sessionId, AGENT_KIND === "codex" ? images : []); }
    catch (error) { return llmApplicationFailure(res, error); }
    if (spawnCfg.error) { res.writeHead(400); return res.end(spawnCfg.error); }
    if (!CHAT_RUNS) return jsonRes(res, 409, { error: "agent chat is unavailable for this computer" });
    const { bin, args, useStdin, textMode } = spawnCfg;
    // venice-active spawns carry their own env (chatSpawnEnv + HIVRA_LLM_API_KEY);
    // everything else uses the shared chat env (AGENT_ENV + bankr wallet vars).
    const spawnEnv = spawnCfg.env || chatSpawnEnv();

    let started;
    try {
      started = CHAT_RUNS.start({
        runId, clientRef, detached: detach, agentKind: AGENT_KIND, title: message.slice(0, 120),
        resumeSessionId: typeof sessionId === "string" ? sessionId : null,
        bin, args, cwd: HOME, env: spawnEnv, textMode, stdinText: useStdin ? sendMsg : null,
      });
    } catch (error) {
      if (error instanceof CHAT_RUNS_MODULE.ChatRunError) return jsonRes(res, error.status, { error: error.message, code: error.code });
      console.error("hivra-chat: chat run could not start: " + ((error && error.stack) || error));
      return jsonRes(res, 500, { error: "The agent run could not be started." });
    }
    const run = started.record.meta;
    res.writeHead(200, { ...CHAT_STREAM_HEADERS, "X-Hivra-Run-Id": run.runId });
    try {
      CHAT_RUNS.stream(run.runId, res, {
        preface: { type: "_run", runId: run.runId, detached: run.detached },
        // Callers that did not opt into detached runs keep the historical
        // contract: their disconnect stops the turn. Older dashboards abort the
        // fetch as their Stop button, and the box's own page expects it too.
        onClientClose: run.detached ? undefined : () => CHAT_RUNS.stop(run.runId, "disconnect"),
        onError: logChatStreamError,
      });
    } catch (error) {
      // The run keeps going; the client can re-attach through /api/chat/runs.
      logChatStreamError(error);
      res.end();
    }
  });
}

// GET  /api/chat/runs                  recent runs, newest first
// GET  /api/chat/runs/<id>             one run
// GET  /api/chat/runs/<id>/events      the run's stream from ?offset= (bytes), live until it finishes
// POST /api/chat/runs/<id>/stop        explicit stop (the only way a detached run ends early)
function handleChatRuns(req, res, u, q) {
  res.setHeader("Cache-Control", "no-store");
  const parts = u.slice("/api/chat/runs".length).split("/").filter(Boolean);
  if (parts.length === 0) {
    if (req.method !== "GET") return jsonRes(res, 405, { error: "method not allowed" });
    return jsonRes(res, 200, { runs: CHAT_RUNS.list() });
  }
  const runId = parts[0];
  if (!CHAT_RUNS_MODULE.RUN_ID_RE.test(runId) || parts.length > 2) return jsonRes(res, 404, { error: "run not found" });
  if (parts.length === 1) {
    if (req.method !== "GET") return jsonRes(res, 405, { error: "method not allowed" });
    const run = CHAT_RUNS.get(runId);
    return run ? jsonRes(res, 200, { run }) : jsonRes(res, 404, { error: "run not found" });
  }
  if (parts[1] === "stop") {
    if (req.method !== "POST") return jsonRes(res, 405, { error: "method not allowed" });
    const run = CHAT_RUNS.stop(runId, "user");
    return run ? jsonRes(res, 200, { ok: true, run }) : jsonRes(res, 404, { error: "run not found" });
  }
  if (parts[1] === "events") {
    if (req.method !== "GET") return jsonRes(res, 405, { error: "method not allowed" });
    const run = CHAT_RUNS.get(runId);
    if (!run) return jsonRes(res, 404, { error: "run not found" });
    res.writeHead(200, { ...CHAT_STREAM_HEADERS, "X-Hivra-Run-Id": runId, "X-Hivra-Run-State": run.state });
    // Watching never stops a run: a closed viewer just stops reading.
    CHAT_RUNS.stream(runId, res, { offset: Number(q.get("offset")) || 0, onError: logChatStreamError });
    return;
  }
  return jsonRes(res, 404, { error: "run not found" });
}

// ---- reverse-proxy (one tunnel serves chat + both terminals + the noVNC view) ----
// `strip` lets us mount a backend that serves at root (noVNC/websockify) under a
// sub-path: we drop the prefix before forwarding (ttyd keeps its prefix via -b).
function proxyHttp(req, res, port, strip, preserveAuthority = false) {
  let path = req.url;
  if (strip) { path = req.url.slice(strip.length); if (!path.startsWith("/")) path = "/" + path; }
  const headers = Object.assign({}, req.headers);
  if (!preserveAuthority) headers.host = "127.0.0.1:" + port;
  // The outer gateway authenticates Hivra authority. Never forward that
  // replayable authority into a bux-owned terminal/browser/native backend.
  // Preserve unrelated backend cookies and non-Hivra Authorization schemes.
  const bearer = String(headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (bearer && safeEq(bearer[1], API_TOKEN)) delete headers.authorization;
  if (typeof headers.cookie === "string") {
    headers.cookie = headers.cookie.split(";").map(part => part.trim()).filter(part => part && part.split("=", 1)[0] !== AUTH_COOKIE).join("; ");
    if (!headers.cookie) delete headers.cookie;
  }
  const opts = { host: "127.0.0.1", port, method: req.method, path, headers };
  const p = http.request(opts, (pr) => {
    const h = Object.assign({}, pr.headers);
    // The dashboard embeds these surfaces in a same-origin iframe behind our token
    // gate. Drop the backend's anti-framing controls so the embed isn't blocked:
    // X-Frame-Options outright, and ONLY the frame-ancestors directive from the CSP
    // (OpenClaw's gateway sends `...; frame-ancestors 'none'; ...`) — the rest of the
    // CSP stays intact. gateProxy is the access boundary, so framing is gated by the
    // box token, not by these headers.
    // Desktop uses its own PKCE/session broker, not gateProxy. Its framing
    // policy binds the handoff to the control plane and the stream to that
    // handoff; preserve those security headers across the public gateway.
    if (!preserveAuthority) {
      delete h["x-frame-options"];
      if (typeof h["content-security-policy"] === "string") {
        const csp = h["content-security-policy"].replace(/\s*frame-ancestors[^;]*;?/gi, "").replace(/;\s*$/, "").trim();
        if (csp) h["content-security-policy"] = csp; else delete h["content-security-policy"];
      }
    }
    res.writeHead(pr.statusCode || 502, h);
    pr.pipe(res);
  });
  p.on("error", () => { try { res.writeHead(502); res.end("backend unavailable"); } catch (e) {} });
  req.pipe(p);
}

// ---- Agent Zero seamless login ----------------------------------------------
// Agent Zero always gates its OWN web UI with a form login (username/password ->
// session cookie; no basic-auth, no open-loopback mode). Since our token gate
// already authenticates the box owner, that second login is pure friction — so we
// log in transparently with the credential seeded at provision and inject the
// session cookie, and the user only ever passes our gate.
let _a0Cookie = null;
let _a0SessionName = null, _a0SessionRevision = 0, _a0CsrfAttempt = 0, _a0Csrf = null;
function a0UpstreamCookie() {
  if (!_a0Cookie) return null;
  return _a0Cookie + (_a0Csrf && _a0Csrf.sessionRevision === _a0SessionRevision ? "; " + _a0Csrf.cookie : "");
}
function retainA0Cookies(setCookies) {
  const cookies = new Map();
  for (const pair of String(_a0Cookie || "").split(/;\s*/)) {
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  for (const header of setCookies || []) {
    const parts = String(header).split(";");
    const pair = parts.shift().trim();
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    // This pinned native runtime creates its CSRF cookie in browser JS. Only
    // the validated CSRF JSON below may supply that private derived cookie.
    if (name.startsWith("csrf_token_")) continue;
    const expired = parts.some((part) => /^\s*max-age\s*=\s*0\s*$/i.test(part));
    if (/^session(?:_[0-9a-f]{16})?$/.test(name)
      && (expired ? _a0SessionName === name : _a0SessionName !== name || cookies.get(name) !== pair.slice(separator + 1))) {
      _a0SessionName = expired ? null : name;
      _a0SessionRevision++; _a0Csrf = null;
    }
    if (expired) cookies.delete(name); else cookies.set(name, pair.slice(separator + 1));
  }
  _a0Cookie = [...cookies].map(([name, value]) => name + "=" + value).join("; ") || null;
}
function readA0Creds() {
  try {
    const raw = fs.readFileSync(path.join(HOME, ".hivra", "agent-zero-login"), "utf8");
    const login = (raw.match(/^AUTH_LOGIN=(.*)$/m) || [])[1];
    const password = (raw.match(/^AUTH_PASSWORD=(.*)$/m) || [])[1];
    if (login && password) return { login: login.trim(), password: password.trim() };
  } catch {}
  return null;
}
function a0Login(cb, isCurrent) {
  const creds = readA0Creds();
  if (!creds) return cb(null);
  let settled = false;
  const finish = value => { if (!settled) { settled = true; cb(value); } };
  const body = "username=" + encodeURIComponent(creds.login) + "&password=" + encodeURIComponent(creds.password) + "&next=" + encodeURIComponent("/");
  const r = http.request({ host: "127.0.0.1", port: AGENT_ZERO_PORT, method: "POST", path: "/login",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } }, (pr) => {
    if (isCurrent) pr.once("error", () => {});
    if (isCurrent && !isCurrent()) { pr.destroy(); return finish(null); }
    retainA0Cookies(pr.headers["set-cookie"]);
    if (isCurrent) pr.destroy(); else pr.resume();
    finish(_a0Cookie);
  });
  r.on("error", () => finish(null));
  r.write(body); r.end();
  return r;
}
// Proxy to Agent Zero with the login session injected. On a cache miss — or when
// the container rotates the session and 302s back to /login — (re)log in and retry
// the (GET) request once, so the owner never sees Agent Zero's own login screen.
function a0CanonicalEntryHtml(html) {
  const seen = { "index.js": 0, "js/initFw.js": 0 };
  // Match whole script elements/comments so a quoted example in another script
  // or an HTML comment is never rewritten. These are the two pinned native
  // entry tags, not a general base-path or script-source rewrite.
  const rewritten = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (element) => {
    const entry = element.match(/^<script type="module" src="(index\.js|js\/initFw\.js)">\s*<\/script\s*>$/);
    if (!entry) return element;
    seen[entry[1]]++;
    return element.replace('src="', 'src="/');
  });
  return seen["index.js"] === 1 && seen["js/initFw.js"] === 1 ? rewritten : null;
}
function a0Proxy(req, res, retried, csrfContext, editorContext) {
  if (!authed(req)) return denyHtml(res);
  let apath = req.url.slice("/agent-zero".length); if (!apath.startsWith("/")) apath = "/" + apath;
  const editorPath = apath.split("?")[0];
  const editorAsset = (req.method === "GET" || req.method === "HEAD") && Object.hasOwn(A0_EDITOR_SOURCES, editorPath);
  const editor = editorContext || (editorAsset ? { done: false, cancel: null, timer: null } : null);
  if (editor && !editorContext) {
    editor.settle = reason => {
      if (editor.done) return;
      editor.done = true; clearTimeout(editor.timer);
      const cancel = editor.cancel; editor.cancel = null;
      if (reason && !res.destroyed && !res.writableEnded) {
        console.warn("Agent Zero native editor asset rejected:", reason);
        res.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("native editor asset unavailable");
      }
      if (cancel) cancel();
    };
    // One absolute deadline includes login, the single login retry, headers,
    // and body. Slow traffic cannot keep an editor asset pending forever.
    editor.timer = setTimeout(() => editor.settle("timeout"), 10000);
    res.once("close", () => editor.settle());
  }
  const csrfResponse = req.method === "GET" && apath.split("?")[0] === "/api/csrf_token";
  const csrf = csrfContext || (csrfResponse ? { attempt: ++_a0CsrfAttempt, done: false, cancel: null, timer: null } : null);
  if (csrf && !csrfContext) {
    _a0Csrf = null;
    csrf.settle = reason => {
      if (csrf.done) return;
      csrf.done = true; clearTimeout(csrf.timer);
      const cancel = csrf.cancel; csrf.cancel = null;
      if (reason) {
        if (csrf.attempt === _a0CsrfAttempt) _a0Csrf = null;
        console.warn("Agent Zero native CSRF response rejected:", reason);
        res.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("native CSRF response unavailable");
      }
      if (cancel) cancel();
    };
    // One absolute deadline includes any login handoff, headers and body. It
    // cannot be extended by upstream traffic or the existing one-login retry.
    csrf.timer = setTimeout(() => csrf.settle("timeout"), 5000);
    res.once("close", () => csrf.settle());
  }
  const csrfAttempt = csrf ? csrf.attempt : 0;
  const rejectCsrf = reason => csrf.settle(reason);
  const loginThen = next => {
    let handedOff = false;
    const pending = a0Login(() => {
      handedOff = true;
      if (editor && editor.done) return;
      if (csrf && csrf.done) return;
      if (csrf && csrf.attempt !== _a0CsrfAttempt) return rejectCsrf("session-changed");
      next();
    }, csrf ? () => !csrf.done && csrf.attempt === _a0CsrfAttempt : editor ? () => !editor.done : undefined);
    if (csrf && !handedOff && !csrf.done) csrf.cancel = () => { if (pending) pending.destroy(); };
    if (editor && !handedOff && !editor.done) editor.cancel = () => { if (pending) pending.destroy(); };
  };
  const doProxy = () => {
    if (editor && editor.done) return;
    if (csrf && csrf.done) return;
    if (csrf && csrf.attempt !== _a0CsrfAttempt) return rejectCsrf("session-changed");
    const headers = Object.assign({}, req.headers, { host: "127.0.0.1:" + AGENT_ZERO_PORT });
    const requestSessionRevision = _a0SessionRevision;
    const entryDocument = (req.method === "GET" || req.method === "HEAD") && ["/", "/index.html"].includes(apath.split("?")[0]);
    if (entryDocument || editorAsset || csrfResponse) {
      headers["accept-encoding"] = "identity";
      // The transformed representation has different validators/length. Always
      // request its full source rather than forwarding a conditional/range hit.
      for (const name of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "range", "if-range"]) delete headers[name];
    }
    const bearer = String(headers.authorization || "").match(/^Bearer\s+(.+)$/i);
    if (bearer && safeEq(bearer[1], API_TOKEN)) delete headers.authorization;
    // Backend login/CSRF sessions remain server-side. Never pass the Hivra
    // surface cookie or browser-supplied backend authority into Agent Zero.
    const nativeCookie = a0UpstreamCookie();
    if (nativeCookie) headers.cookie = nativeCookie; else delete headers.cookie;
    // HEAD still validates the exact upstream body before describing the
    // transformed representation. Neither path may bypass source pinning.
    const p = http.request({ host: "127.0.0.1", port: AGENT_ZERO_PORT, method: editorAsset ? "GET" : req.method, path: apath, headers }, (pr) => {
      if (editor && editor.done) { pr.destroy(); return; }
      if (csrf && csrf.done) { pr.destroy(); return; }
      if (csrfResponse) pr.once("error", () => rejectCsrf("upstream-error"));
      if (csrfResponse && (csrfAttempt !== _a0CsrfAttempt || requestSessionRevision !== _a0SessionRevision)) {
        pr.destroy(); return rejectCsrf("session-changed");
      }
      const loc = String(pr.headers["location"] || "");
      if (pr.statusCode === 302 && /\/login(\?|$)/.test(loc) && !retried && (req.method === "GET" || editorAsset)) {
        if (csrf || editor) pr.destroy(); else pr.resume();
        _a0Cookie = null; _a0SessionName = null; _a0SessionRevision++; _a0Csrf = null;
        return loginThen(() => a0Proxy(req, res, true, csrf, editor));
      }
      const h = Object.assign({}, pr.headers);
      // A CSRF-token response can rotate Flask's signed session. Preserve it
      // for the next upstream request, not in the browser where it would be
      // discarded by the managed-session injection above.
      retainA0Cookies(pr.headers["set-cookie"]);
      delete h["set-cookie"];
      delete h["x-frame-options"];
      if (typeof h["content-security-policy"] === "string") {
        const csp = h["content-security-policy"].replace(/\s*frame-ancestors[^;]*;?/gi, "").replace(/;\s*$/, "").trim();
        if (csp) h["content-security-policy"] = csp; else delete h["content-security-policy"];
      }
      if (csrfResponse) {
        const sessionRevision = _a0SessionRevision;
        const encoding = String(h["content-encoding"] || "identity").toLowerCase();
        const maxBytes = 16 * 1024;
        let size = 0, done = false;
        const chunks = [];
        const fail = (reason) => {
          if (done) return;
          done = true; rejectCsrf(reason); pr.destroy();
        };
        pr.once("error", () => fail("upstream-error")); pr.once("aborted", () => fail("upstream-aborted"));
        res.once("close", () => { if (!done) { done = true; pr.destroy(); } });
        if (pr.statusCode !== 200) return fail("status");
        if (!/^application\/json(?:\s*;|$)/i.test(String(h["content-type"] || "")) || encoding !== "identity") return fail("representation");
        if (Number(h["content-length"] || 0) > maxBytes) return fail("size-limit");
        pr.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return fail("size-limit");
          if (!done) chunks.push(chunk);
        });
        pr.once("end", () => {
          if (done) return;
          const body = Buffer.concat(chunks);
          let value;
          try { value = JSON.parse(body.toString("utf8")); } catch { return fail("json"); }
          if (!value || value.ok !== true || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)
            || typeof value.runtime_id !== "string" || !/^[0-9a-f]{16}$/.test(value.runtime_id)) return fail("contract");
          const sessionName = "session_" + value.runtime_id;
          if (csrfAttempt !== _a0CsrfAttempt || sessionRevision !== _a0SessionRevision || _a0SessionName !== sessionName
            || !String(_a0Cookie || "").split(/;\s*/).some(pair => pair.startsWith(sessionName + "=") && pair.length > sessionName.length + 1)) return fail("session-changed");
          _a0Csrf = { sessionRevision, cookie: "csrf_token_" + value.runtime_id + "=" + value.token };
          done = true; csrf.settle();
          for (const name of ["content-length", "content-encoding", "transfer-encoding", "etag", "last-modified", "content-md5", "digest", "content-range", "accept-ranges"]) delete h[name];
          h["cache-control"] = "no-store"; h["content-length"] = body.length;
          res.writeHead(200, h); res.end(body);
        });
        return;
      }
      if (editorAsset) {
        const maxBytes = 64 * 1024;
        let size = 0, done = false;
        const chunks = [];
        const fail = reason => {
          if (done) return;
          done = true; editor.settle(reason); pr.destroy();
        };
        pr.once("error", () => fail("upstream-error"));
        pr.once("aborted", () => fail("upstream-aborted"));
        res.once("close", () => { if (!done) { done = true; pr.destroy(); } });
        const mime = String(h["content-type"] || "");
        const expectedMime = editorPath.endsWith(".html") ? /^text\/html(?:\s*;|$)/i : /^(?:text|application)\/javascript(?:\s*;|$)/i;
        if (pr.statusCode !== 200 || !expectedMime.test(mime)
          || String(h["content-encoding"] || "identity").toLowerCase() !== "identity") return fail("representation");
        if (Number(h["content-length"] || 0) > maxBytes) return fail("size-limit");
        pr.on("data", chunk => {
          size += chunk.length;
          if (size > maxBytes) return fail("size-limit");
          if (!done) chunks.push(chunk);
        });
        pr.once("end", () => {
          if (done) return;
          let body;
          try { body = rewriteNativeEditorAsset(editorPath, Buffer.concat(chunks)); }
          catch { return fail("source-contract"); }
          if (!body) return fail("source-contract");
          done = true; editor.settle();
          for (const name of ["content-length", "content-encoding", "transfer-encoding", "etag", "last-modified", "content-md5", "digest", "content-digest", "repr-digest", "content-range", "accept-ranges", "expires", "age"]) delete h[name];
          h["cache-control"] = "no-store"; h["content-length"] = body.length;
          res.writeHead(200, h); res.end(req.method === "HEAD" ? undefined : body);
        });
        return;
      }
      if (entryDocument && pr.statusCode === 200 && /^text\/html(?:\s*;|$)/i.test(String(h["content-type"] || ""))) {
        const encoding = String(h["content-encoding"] || "identity").toLowerCase();
        const sourceLength = Number(h["content-length"] || 0);
        for (const name of ["content-length", "content-encoding", "transfer-encoding", "etag", "last-modified", "content-md5", "digest", "content-range", "accept-ranges"]) delete h[name];
        h["cache-control"] = "no-store";
        const maxBytes = 1024 * 1024;
        let size = 0, done = false;
        const chunks = [];
        let timer;
        const fail = (reason) => {
          if (done) return;
          done = true; clearTimeout(timer); pr.destroy();
          console.warn("Agent Zero native entry document rejected:", reason);
          res.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
          res.end("native entry document unavailable");
        };
        pr.once("error", () => fail("upstream-error")); pr.once("aborted", () => fail("upstream-aborted"));
        res.once("close", () => { if (!done) { done = true; clearTimeout(timer); pr.destroy(); } });
        if (encoding !== "identity") return fail("unexpected-encoding");
        if (sourceLength > maxBytes) return fail("size-limit");
        // HEAD describes the same uncached representation, but carries no body
        // and no guessed transformed Content-Length. Keep it an upstream HEAD.
        if (req.method === "HEAD") { done = true; pr.resume(); res.writeHead(200, h); return res.end(); }
        timer = setTimeout(() => fail("timeout"), 10000);
        pr.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return fail("size-limit");
          if (!done) chunks.push(chunk);
        });
        pr.once("end", () => {
          if (done) return;
          const html = a0CanonicalEntryHtml(Buffer.concat(chunks).toString("utf8"));
          if (html === null) return fail("entry-contract");
          done = true; clearTimeout(timer);
          h["content-length"] = Buffer.byteLength(html);
          res.writeHead(200, h); res.end(html);
        });
        return;
      }
      res.writeHead(pr.statusCode || 502, h);
      pr.pipe(res);
    });
    p.on("error", () => { try {
      if (editor) return editor.settle("upstream-error");
      if (csrfResponse) return rejectCsrf("upstream-error");
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(502, { "Cache-Control": "no-store" }); res.end("backend unavailable");
      }
    } catch (e) {} });
    if (csrf) csrf.cancel = () => p.destroy();
    if (editor) editor.cancel = () => p.destroy();
    if (req.method === "GET" || req.method === "HEAD") p.end(); else req.pipe(p);
  };
  if (_a0Cookie) doProxy(); else loginThen(doProxy);
}

// Token-gate a proxied surface (Claude TUI / box shell / live browser). The
// iframe first POSTs its bearer to /auth/bootstrap, which replaces it with a
// short-lived HttpOnly cookie before navigating here with a clean URL.
function gateProxy(req, res, port, strip) {
  if (!authed(req)) return denyHtml(res);
  return proxyHttp(req, res, port, strip);
}

// ---- Claude account login (the user's OWN native login, driven on the box) ----
// `claude auth login` prints an OAuth URL then waits for the code on stdin. We
// hold the process between /start and /complete. This is the in-product version
// of the manual flow; the box's own claude does the login, Hivra never sees the
// token.
let loginState = null;

function handleLoginStatus(res) {
  if (COMPUTER_PROFILE) return jsonRes(res, 200, { loggedIn: false, available: false, reason: "not-applicable" });
  // A generic CLI agent manages its own auth (outside the box's managed login),
  // so report logged-in to avoid gating the chat behind a login it doesn't have.
  // OpenClaw manages its own model credentials inside its Control UI, so there is
  // no box-managed login to gate on — report connected like a generic agent.
  if (AGENT_KIND === "generic" || AGENT_KIND === "openclaw" || AGENT_KIND === "agent-zero") return jsonRes(res, 200, { loggedIn: true, email: null, sub: null });
  if (AGENT_KIND === "aeon") {
    // "Connected" = gh is authenticated (the dashboard can drive the user's repo
    // + Actions). Runs as the box user, so no sudo. gh prints to stderr.
    // `connect` is the last fork sync outcome (see syncAeonFork): whether the
    // dashboard's saves reach the fork and which Aeon workflows are running.
    execFile(GH, ["auth", "status"], { env: AGENT_ENV, cwd: HOME, timeout: 8000 }, (err, stdout, stderr) => {
      const out = String(stdout || "") + String(stderr || "");
      const loggedIn = /Logged in to github\.com/i.test(out);
      const m = out.match(/account\s+(\S+)/i);
      jsonRes(res, 200, { loggedIn, email: m ? m[1] : null, sub: null, connect: readAeonConnectStatus() });
    });
    return;
  }
  if (AGENT_KIND === "codex") {
    execFile(CODEX, ["login", "status"], { env: AGENT_ENV, cwd: HOME, timeout: 8000 }, (err, stdout, stderr) => {
      const out = String(stdout || "") + String(stderr || "");
      const loggedIn = /logged in/i.test(out) && !/not logged in/i.test(out);
      const m = out.match(/([\w.+-]+@[\w.-]+\.\w+)/);
      jsonRes(res, 200, { loggedIn, email: m ? m[1] : null, sub: null });
    });
    return;
  }
  execFile(CLAUDE, ["auth", "status"], { env: CLAUDE_ENV, cwd: HOME, timeout: 8000 }, (err, stdout) => {
    try {
      const j = JSON.parse(stdout || "{}");
      jsonRes(res, 200, { loggedIn: Boolean(j.loggedIn), email: j.email || null, sub: j.subscriptionType || null });
    } catch {
      jsonRes(res, 200, { loggedIn: false });
    }
  });
}

function handleLoginStart(res) {
  const fresh = !(loginState && loginState.proc && loginState.proc.exitCode === null && !loginState.done);
  if (fresh) {
    const child = spawn(CLAUDE, ["auth", "login"], { env: CLAUDE_ENV, cwd: HOME, stdio: ["pipe", "pipe", "pipe"] });
    loginState = { proc: child, url: null, out: "", done: false, ok: false, code: null };
    const onData = (d) => {
      loginState.out += d.toString();
      if (!loginState.url) {
        const m = loginState.out.match(/https:\/\/claude\.com\/[^\s'"]+/) || loginState.out.match(/https:\/\/[^\s'"]*oauth[^\s'"]+/);
        if (m) loginState.url = m[0];
      }
      if (/Login successful/i.test(loginState.out)) loginState.ok = true;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (c) => { loginState.done = true; loginState.code = c; });
    child.on("error", () => { loginState.done = true; loginState.code = -1; });
  }
  const start = Date.now();
  const poll = () => {
    if (loginState.url) return jsonRes(res, 200, { url: loginState.url });
    if (loginState.done) return jsonRes(res, 500, { error: "login exited before printing a URL" });
    if (Date.now() - start > 15000) return jsonRes(res, 504, { error: "timed out waiting for login URL" });
    setTimeout(poll, 300);
  };
  poll();
}

function handleLoginComplete(res, body) {
  let code = "";
  try { code = String((JSON.parse(body || "{}")).code || "").trim(); } catch {}
  if (!code) return jsonRes(res, 400, { ok: false, error: "no code" });
  if (!loginState || !loginState.proc) return jsonRes(res, 400, { ok: false, error: "no login in progress" });
  try { loginState.proc.stdin.write(code + "\n"); } catch (e) { return jsonRes(res, 500, { ok: false, error: "write failed" }); }
  const start = Date.now();
  const poll = () => {
    if (loginState.ok || (loginState.done && loginState.code === 0)) return jsonRes(res, 200, { ok: true });
    if (loginState.done) return jsonRes(res, 400, { ok: false, error: "login failed" });
    if (Date.now() - start > 20000) return jsonRes(res, 504, { ok: false, error: "timed out completing login" });
    setTimeout(poll, 400);
  };
  poll();
}

// ---- Codex account login (the user's OWN ChatGPT login via device-auth) ----
// `codex login --device-auth` prints a URL + a one-time code, then the box polls
// OpenAI itself until the user enters the code at auth.openai.com/codex/device.
// There is no code to paste back — /start returns {url, code}; the dashboard
// polls /status until loggedIn. The box's own codex does the login; Hivra never
// sees the token.
function handleLoginStartCodex(res) {
  const fresh = !(loginState && loginState.proc && loginState.proc.exitCode === null && !loginState.done);
  if (fresh) {
    const child = spawn(CODEX, ["login", "--device-auth"], { env: AGENT_ENV, cwd: HOME, stdio: ["pipe", "pipe", "pipe"] });
    loginState = { proc: child, url: null, code: null, out: "", done: false, ok: false, exit: null };
    const onData = (d) => {
      loginState.out += d.toString();
      // codex colorizes its output (\x1b[..m); strip ANSI so the \b-anchored code
      // regex matches the wrapped token (the escape's trailing 'm' is a word char,
      // which otherwise kills the word boundary before the code).
      const clean = loginState.out.replace(/\x1b\[[0-9;]*m/g, "");
      if (!loginState.url) { const m = clean.match(/https:\/\/auth\.openai\.com\/codex\/device/); if (m) loginState.url = m[0]; }
      if (!loginState.code) { const m = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/); if (m) loginState.code = m[1]; }
      if (/successfully logged in|logged in to|login successful/i.test(clean)) loginState.ok = true;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (c) => { loginState.done = true; loginState.exit = c; });
    child.on("error", () => { loginState.done = true; loginState.exit = -1; });
  }
  const start = Date.now();
  const poll = () => {
    if (loginState.url && loginState.code) return jsonRes(res, 200, { url: loginState.url, code: loginState.code, deviceAuth: true });
    if (loginState.done) return jsonRes(res, 500, { error: "login exited before printing a device code" });
    if (Date.now() - start > 15000) return jsonRes(res, 504, { error: "timed out waiting for device code" });
    setTimeout(poll, 300);
  };
  poll();
}

// Device-auth has no code to paste; the box polls OpenAI itself. /complete just
// reports whether login has finished (the dashboard primarily polls /status).
function handleLoginCompleteCodex(res) {
  if (loginState && (loginState.ok || (loginState.done && loginState.exit === 0))) return jsonRes(res, 200, { ok: true });
  execFile(CODEX, ["login", "status"], { env: AGENT_ENV, cwd: HOME, timeout: 8000 }, (e, so, se) => {
    const out = String(so || "") + String(se || "");
    const ok = /logged in/i.test(out) && !/not logged in/i.test(out);
    jsonRes(res, ok ? 200 : 202, { ok });
  });
}

// ---- Aeon GitHub connect (the user's OWN GitHub via a personal access token) --
// Aeon runs the user's tasks on THEIR GitHub Actions and stores state in THEIR
// repo, so it authenticates with a PAT rather than an OAuth/device flow. The
// dashboard sends the token as `code`; we hand it to `gh auth login --with-token`
// (running as the box user — no sudo) and then (re)start the Aeon dashboard,
// which prechecks gh auth and won't serve until it's connected.
function handleLoginCompleteAeon(res, body) {
  let pat = "";
  let venice = null;
  try {
    const parsed = JSON.parse(body || "{}");
    pat = String(parsed.code || "").trim();
    // Optional managed-Venice wiring from the Hivra dashboard: a Hivra-minted
    // proxy key + the Hivra OpenAI-compatible endpoint, to be installed on the
    // user's fork so Aeon's venice gateway bills their Hivra credit wallet.
    // Strictly validated; anything off-shape degrades to a plain connect.
    if (parsed.venice && typeof parsed.venice === "object") {
      const vkey = String(parsed.venice.key || "").trim();
      const vurl = String(parsed.venice.baseUrl || "").trim();
      const vmodel = String(parsed.venice.model || "").trim();
      if (/^hven_[A-Za-z0-9_-]{8,180}$/.test(vkey) && /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9./_-]{1,200}$/.test(vurl)) {
        venice = { key: vkey, baseUrl: vurl, model: /^[A-Za-z0-9._:-]{1,64}$/.test(vmodel) ? vmodel : "" };
      }
    }
  } catch {}
  if (!pat) return jsonRes(res, 400, { ok: false, error: "no token" });
  const child = spawn(GH, ["auth", "login", "--with-token"], { env: AGENT_ENV, cwd: HOME });
  let cerr = "";
  child.stderr.on("data", (d) => { cerr += d.toString(); });
  child.on("error", (e) => jsonRes(res, 500, { ok: false, error: "gh spawn failed: " + e.message }));
  try { child.stdin.write(pat + "\n"); child.stdin.end(); } catch (e) { return jsonRes(res, 500, { ok: false, error: "token write failed" }); }
  child.on("close", (code) => {
    if (code !== 0) return jsonRes(res, 400, { ok: false, error: "GitHub sign-in failed: " + (cerr.slice(0, 200) || "gh exit " + code) });
    // The box was provisioned from the upstream Aeon template, so the clone's
    // origin (and thus every `gh secret set` / repository_dispatch) points at a
    // repo the user doesn't own → HTTP 403 on every credential save. Now that gh
    // is authed, repoint origin + the gh default repo at the connected user's own
    // fork, then confirm the token can actually write secrets there, then make
    // the box clone push to that fork (syncAeonFork). THEN restart the
    // dashboard so it serves against the right repo.
    finalizeAeonConnect(venice, (result) => {
      // Hard-fail (with a clear, actionable message) on the states that would
      // otherwise re-surface later as a silent "save does nothing" and that a
      // reconnect can fix: the user has no fork, the token lacks
      // Secrets:write, or (after the sync below) GitHub refused this
      // computer's push or git could not be given the sign-in. Auth itself
      // succeeded, so any other state passes and is reported as `sync` (a
      // GitHub outage is retried by the computer on its own).
      const hardFail = result.status === "no_secrets" || result.status === "no_fork";
      // A first fetch of a long-lived fork can outlast the request; it keeps
      // running and its outcome lands in the status /api/login/status returns.
      let waited = null;
      const synced = hardFail ? Promise.resolve(null) : Promise.race([
        syncAeonFork("connect"),
        new Promise((resolve) => { waited = setTimeout(() => resolve({ status: "syncing" }), AEON_CONNECT_SYNC_WAIT_MS); }),
      ]);
      synced.then((sync) => {
        clearTimeout(waited);
        const restart = spawn("sudo", ["-n", "/usr/local/bin/hivra-aeon-apply", "restart"], { env: AGENT_ENV });
        let replied = false;
        const reply = () => {
          if (replied) return;
          replied = true;
          if (hardFail) return jsonRes(res, 400, { ok: false, error: result.message });
          // Connect succeeds only when dashboard saves now reach the fork
          // (ok), the sync is still running (syncing), or the computer
          // retries the sync on its own (unreachable, fetch_failed). Any other
          // outcome leaves every save on the computer and does not clear by
          // itself, so it fails the connect with what went wrong.
          if (sync && sync.status !== "ok" && sync.status !== "syncing" && !AEON_RETRYABLE_STATUSES.has(sync.status)) {
            // GitHub refused this computer's push (403, or a token without the
            // workflow permission): same class as no_secrets, so the same
            // token fix. Only a refusal from GitHub gets this message.
            if (sync.status === "push_denied") {
              return jsonRes(res, 400, { ok: false, sync, error: sync.detail + ". Edit the token at github.com/settings/tokens?type=beta → Repository permissions → set Contents and Workflows to Read and write, then reconnect." });
            }
            // gh could not become git's credential helper (or git still has
            // no sign-in): nothing about the token to change, so say to reconnect.
            if (sync.status === "credentials_failed") {
              return jsonRes(res, 400, { ok: false, sync, error: sync.detail + ". Connect GitHub again to retry." });
            }
            // A push GitHub rejected for another reason (repository rules,
            // push protection, a protected branch), a git operation left
            // unfinished in the terminal, another branch checked out, or files
            // in the way: the detail says what happened and what to do.
            return jsonRes(res, 400, { ok: false, sync, error: sync.detail || "This computer could not sync with " + (sync.repo || "your GitHub fork") + "." });
          }
          // venice: "ok" | "failed" | "unsupported" (fork's gateway predates the
          // VENICE_BASE_URL override) | undefined when wiring wasn't requested.
          return jsonRes(res, 200, {
            ok: true,
            repo: result.repo || undefined,
            venice: result.venice || (venice ? "unknown" : undefined),
            sync: sync || undefined,
          });
        };
        restart.on("close", reply);
        restart.on("error", reply);
      });
    });
  });
}

// After `gh auth login` succeeds, repoint the box's Aeon clone at the connected
// user's own fork and verify the token can write Actions secrets there. Returns
// a parsed { status, message, repo, venice } — never rejects (auth already
// worked; this is finalization, and a transient failure here shouldn't block
// the connect).
//
// When `venice` ({key, baseUrl, model}) is present, also install the managed-
// Venice billing wiring on the fork: VENICE_API_KEY secret + VENICE_BASE_URL /
// VENICE_MODEL variables. Gated on the fork's gateway script actually
// supporting the VENICE_BASE_URL override (upstream aaronjmars/aeon#460) —
// installing it on an older fork would point the venice gateway's key at
// api.venice.ai, 401 every run, and poison the provider cascade. Values travel
// via the child's environment, never interpolated into the script (no ps/argv
// exposure for the key).
function finalizeAeonConnect(venice, cb) {
  const script = [
    "set +e",
    "AEON_DIR=" + JSON.stringify(AEON_DIR),
    "UPSTREAM=" + JSON.stringify(AEON_UPSTREAM),
    // The same gh binary as every other gh call here (GH_BIN / /usr/bin/gh).
    "gh() { " + JSON.stringify(GH) + ' "$@"; }',
    'LOGIN="$(gh api user -q .login 2>/dev/null)"',
    'if [ -z "$LOGIN" ]; then echo "RESULT:auth_user_failed:could not read your GitHub account from the token"; exit 0; fi',
    'REPO="$LOGIN/aeon"',
    'if ! gh repo view "$REPO" >/dev/null 2>&1; then',
    '  if ! gh repo fork "$UPSTREAM" --clone=false >/dev/null 2>&1; then',
    '    echo "RESULT:no_fork:Your GitHub account ($LOGIN) has no Aeon fork and one could not be created automatically. Fork github.com/$UPSTREAM, then reconnect."; exit 0',
    "  fi",
    '  for i in 1 2 3 4 5 6; do gh repo view "$REPO" >/dev/null 2>&1 && break; sleep 2; done',
    "fi",
    '# A pre-existing fork may be months stale (or carry foreign automation). Bring it',
    '# current with upstream best-effort; non-force, so a deliberately diverged fork is',
    '# left alone rather than having its history rewritten.',
    'gh repo sync "$REPO" --source "$UPSTREAM" --branch main >/dev/null 2>&1 || true',
    '# Forks start with Actions disabled — enable so scheduled skills can run (best-effort).',
    'gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true -f allowed_actions=all >/dev/null 2>&1',
    '# Point the box clone + gh default repo at the user\'s fork.',
    'git -C "$AEON_DIR" remote set-url origin "https://github.com/$REPO" >/dev/null 2>&1',
    '( cd "$AEON_DIR" && gh repo set-default "$REPO" >/dev/null 2>&1 )',
    '# Confirm the token can actually write Actions secrets on the target repo.',
    'if gh api "repos/$REPO/actions/secrets/public-key" >/dev/null 2>&1; then',
    '  echo "RESULT:ok:$REPO"',
    '  # Managed-Venice billing wiring (only when the dashboard sent it, and only',
    '  # if the fork\'s gateway already understands VENICE_BASE_URL — see #460).',
    '  if [ -n "${HIVRA_VENICE_KEY:-}" ]; then',
    '    if gh api "repos/$REPO/contents/scripts/llm-gateway.sh" --jq .content 2>/dev/null | base64 -d 2>/dev/null | grep -q "VENICE_BASE_URL"; then',
    "      VOK=1",
    '      printf %s "$HIVRA_VENICE_KEY" | gh secret set VENICE_API_KEY -R "$REPO" >/dev/null 2>&1 || VOK=0',
    '      gh variable set VENICE_BASE_URL -R "$REPO" --body "$HIVRA_VENICE_BASE_URL" >/dev/null 2>&1 || VOK=0',
    '      if [ -n "${HIVRA_VENICE_MODEL:-}" ]; then gh variable set VENICE_MODEL -R "$REPO" --body "$HIVRA_VENICE_MODEL" >/dev/null 2>&1 || VOK=0; fi',
    '      if [ "$VOK" = 1 ]; then echo "VENICE:ok"; else echo "VENICE:failed"; fi',
    "    else",
    '      echo "VENICE:unsupported"',
    "    fi",
    "  fi",
    "else",
    '  echo "RESULT:no_secrets:Connected as $LOGIN, but this token cannot write repository secrets to $REPO. Edit the token at github.com/settings/tokens?type=beta → Repository permissions → set Secrets, Actions, Contents and Workflows to Read and write, then reconnect."',
    "fi",
    "exit 0",
  ].join("\n");
  const env = venice
    ? Object.assign({}, AGENT_ENV, {
        HIVRA_VENICE_KEY: venice.key,
        HIVRA_VENICE_BASE_URL: venice.baseUrl,
        HIVRA_VENICE_MODEL: venice.model || "",
      })
    : AGENT_ENV;
  const child = spawn("bash", ["-lc", script], { env, cwd: HOME });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", () => {});
  const done = () => {
    const m = out.match(/RESULT:([a-z_]+):([\s\S]*?)\s*$/m);
    const vm = out.match(/^VENICE:(ok|failed|unsupported)\s*$/m);
    const veniceStatus = vm ? vm[1] : "";
    if (!m) return cb({ status: "unknown", message: "", repo: "", venice: veniceStatus });
    const status = m[1];
    const payload = (m[2] || "").trim();
    cb({ status, message: payload, repo: status === "ok" ? payload : "", venice: veniceStatus });
  };
  child.on("close", done);
  child.on("error", () => cb({ status: "unknown", message: "", repo: "", venice: "" }));
}

// ---- Aeon fork sync: the box clone must push to the user's fork -------------
// Every Aeon dashboard save writes into ~/aeon and then runs a plain `git
// commit` + `git push` (upstream apps/dashboard/lib/github.ts commitAndPush),
// retrying once after `git pull --rebase --autostash`. The provisioner leaves
// that clone as a detached depth-1 checkout of the pinned template commit with
// no git identity and no GitHub credentials, so saves never left the computer
// and the user's GitHub Actions kept running the old configuration.
// syncAeonFork makes the clone push-capable against the connected fork: gh as
// the HTTPS credential helper, the GitHub account as commit identity, and a
// real local branch tracking the fork's default branch with this computer's
// unpushed dashboard saves carried onto it and pushed. It also enables the
// fork's Aeon workflows GitHub leaves disabled on new forks, and records the
// outcome in ~/.hivra/aeon-connect.json for /api/login/status, so the Hivra
// dashboard can show the truth after a refresh. It runs after GitHub connect
// and on every gateway start (retried with backoff while GitHub cannot be
// reached), so a runtime update (which restarts the gateway) repairs computers
// connected before this existed. Idempotent; never rejects.
//
// Nothing on the computer is ever discarded: every move of the clone is a
// `git rebase --autostash` (git sets the working tree's other edits aside and
// puts them back, or keeps them in the stash list when they collide with the
// fork), commits the fork cannot take are kept on a local branch first, and a
// sync interrupted by a gateway stop is rolled back by the next one. Only a
// rebase the sync itself started (recorded in AEON_SYNC_REBASE_MARKER) is ever
// rolled back; a rebase, merge or other git operation started anywhere else
// (the owner's terminal, a dashboard save stopped part-way) is left exactly as
// it is and reported, and nothing is written into it.
const AEON_CONNECT_FILE = path.join(HOME, ".hivra", "aeon-connect.json");
const AEON_CONNECT_SYNC_WAIT_MS = 45000;
// Waits before each retry of a sync GitHub could not be reached for (about 7.5
// minutes in all); a sync that GitHub answered is never retried on its own.
const AEON_SYNC_RETRY_DELAYS_MS = [30000, 60000, 120000, 240000];
const AEON_RETRYABLE_STATUSES = new Set(["unreachable", "fetch_failed"]);
// Scheduled skills, inbound messages, skill chains and the Telegram command menu.
const AEON_WORKFLOWS = ["aeon.yml", "scheduler.yml", "messages.yml", "chain-runner.yml", "setup-commands.yml"];
// States GitHub sets by itself (new fork, 60 days without activity). A workflow
// the user disabled by hand stays disabled: this runs on every gateway start.
const AEON_AUTO_DISABLED_WORKFLOWS = new Set(["disabled_fork", "disabled_inactivity"]);
// What the pinned Aeon dashboard saves (every commitAndPush and saveFile call
// in its apps/dashboard): aeon.yml, skills/<name>/, soul/*.md, STRATEGY.md and
// .mcp.json. Edits to these tracked paths are carried to the fork, and so is
// whatever is already staged: the dashboard stages each save before it
// commits, so a save whose commit failed (including the .github/workflows
// secret allowlist an MCP save writes) is staged. Anything else changed on the
// computer (terminal edits, other workflow edits, untracked files) is never
// committed: a fork of a public repository is public.
const AEON_SAVED_PATHS = ["aeon.yml", "skills", "soul", "STRATEGY.md", ".mcp.json"];
// The provisioner rewrites this tracked file so the dashboard serves under
// /aeon. It is this computer's setting, never an edit to push to the fork.
const AEON_NEXT_CONFIG = "apps/dashboard/next.config.ts";
const AEON_NEXT_CONFIG_MARKER = "AEON_BASE_PATH";
// A durable copy of that file, written before any sync moves the clone, so a
// sync stopped part-way (a runtime update restarts this gateway) can never
// lose it: every sync puts it back whenever the working-tree file lacks it.
const AEON_NEXT_CONFIG_BACKUP = path.join(HOME, ".hivra", "aeon-next.config.ts");
// Written (fsynced) right before each rebase the sync starts, and removed once
// no rebase is in progress: { origHead, headName, onto } as git records them in
// .git/rebase-merge. A rebase in progress that does not match it is not the
// sync's, so the sync never rolls it back.
const AEON_SYNC_REBASE_MARKER = path.join(HOME, ".hivra", "aeon-sync-rebase.json");
// Byte-identical to the file provision-claude-code-box.sh writes (a contract
// test keeps them together); used only when no durable copy exists yet.
const AEON_HIVRA_NEXT_CONFIG = [
  "import type { NextConfig } from 'next'",
  "// Hivra hosts this dashboard behind a token-proxy mounted at /aeon.",
  "const basePath = process.env.AEON_BASE_PATH || undefined",
  "const nextConfig: NextConfig = basePath ? { basePath, assetPrefix: basePath } : {}",
  "export default nextConfig",
  "",
].join("\n");
// A missing credential helper must fail fast, never wait on a prompt.
const AEON_GIT_ENV = Object.assign({}, AGENT_ENV, { GIT_TERMINAL_PROMPT: "0" });

function aeonExec(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: AEON_GIT_ENV, cwd: AEON_DIR, timeout: timeout || 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let detail = String(stderr || (err && err.message) || "").trim();
      // Killed by the timeout: a stalled connection, not an answer from GitHub.
      if (err && err.killed) detail = (detail ? detail + "\n" : "") + "timed out";
      resolve({ ok: !err, out: String(stdout || "").trim(), err: detail });
    });
  });
}
const aeonGit = (...args) => aeonExec("git", args);
const aeonGh = (...args) => aeonExec(GH, args, 60000);
async function aeonRev(ref) {
  const rev = await aeonGit("rev-parse", "--verify", "--quiet", ref + "^{commit}");
  return rev.ok && /^[0-9a-f]{40}$/.test(rev.out) ? rev.out : null;
}
// Last meaningful line of a git/gh error, bounded, for the status file and the journal.
function aeonDetail(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim())
    .filter((line) => line && !/^(hint:|Created autostash|Applied autostash|Successfully rebased)/.test(line));
  return (lines[lines.length - 1] || "no detail").slice(0, 300);
}

// Why the remote rejected a push, from what it said rather than git's closing
// "failed to push some refs" line: GitHub's `remote: error:` lines (GH013
// repository rules and push protection, GH006 protected branch), the rule
// items it lists, and each `! [remote rejected] <ref> (<reason>)`. Empty when
// the remote did not reject anything (the push never reached it).
function aeonPushRejection(text) {
  const reasons = [];
  const add = (reason) => {
    const clean = String(reason || "").trim();
    if (clean && !reasons.includes(clean)) reasons.push(clean);
  };
  let rejected = false;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    const refRejected = line.match(/^!\s+\[(?:remote )?rejected\]\s+\S+(?:\s+->\s+\S+)?\s+\((.+)\)$/);
    if (refRejected) {
      rejected = true;
      add(refRejected[1]);
      continue;
    }
    const remote = line.match(/^remote:\s*(.*)$/);
    if (!remote) continue;
    const said = remote[1].trim();
    const error = said.match(/^(?:error|fatal):\s*(.+)$/i);
    if (error) add(error[1]);
    else if (/^-\s+\S/.test(said)) add(said.replace(/^-\s+/, ""));
  }
  if (!rejected && !reasons.length) return "";
  return reasons.slice(0, 6).join("; ").slice(0, 500);
}

// What a failed call to GitHub means. "credentials": git has no usable GitHub
// credentials on this computer; "denied": GitHub answered and refused
// (401/403, a token without the permission, the workflow-scope refusal);
// "transient": GitHub could not be reached or was briefly unavailable;
// "other": anything else.
function aeonRemoteFailure(text) {
  const t = String(text || "");
  if (/could not read (Username|Password)|terminal prompts disabled/i.test(t)) return "credentials";
  // GitHub answers a rate limit with 403: checked before the refusals.
  if (/rate limit/i.test(t)) return "transient";
  if (/HTTP 40[13]\b|returned error: 40[13]\b|Permission to \S+ denied|permission denied|denied to |Bad credentials|Write access to repository not granted|refusing to allow an? (Personal Access Token|OAuth App|GitHub App)|Authentication failed|requires authentication|gh auth login/i.test(t)) return "denied";
  // GitHub answered and rejected the ref (a rule, push protection, a moved
  // branch). Whatever else its message mentions, it was reached.
  if (/^\s*!\s+\[(remote )?rejected\]/m.test(t)) return "other";
  if (/timed? ?out|deadline exceeded|could not resolve|no such host|lookup |dial tcp|connection (refused|reset|closed|timed out)|failed to connect|couldn't connect|network is unreachable|temporary failure|\bTLS\b|\bSSL\b|\bEOF\b|remote end hung up|RPC failed|HTTP 5\d\d|returned error: 5\d\d|HTTP 429|returned error: 429|error connecting to|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(t)) return "transient";
  return "other";
}

// Why a rebase that stopped short of a conflict failed, in words the owner can
// act on (git lists the files in the way on tab-indented lines).
function aeonMoveFailureDetail(text) {
  const t = String(text || "");
  const files = t.split("\n").filter((line) => /^\t\S/.test(line)).map((line) => line.trim()).slice(0, 10);
  if (/untracked working tree files would be overwritten/i.test(t)) {
    return "Files on this computer that git does not track are in the way of the fork's version: " + files.join(", ") + ". Move or delete them in the terminal; nothing was changed.";
  }
  if (/local changes to the following files would be overwritten/i.test(t)) {
    return "Edits on this computer are in the way of the fork's version: " + files.join(", ") + ". Nothing was changed.";
  }
  return aeonDetail(t);
}

function readAeonConnectStatus() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AEON_CONNECT_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Replace `file` with `text` so that a stop at any moment leaves either the
// old or the new content on disk, never a partial or missing file.
function writeFileDurably(file, text, mode) {
  const tmp = file + ".hivra-tmp";
  try {
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    try {
      const dir = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch {}
    return true;
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.error("hivra-chat: " + file + " could not be written: " + ((error && error.message) || error));
    return false;
  }
}

function writeAeonConnectStatus(state) {
  const record = Object.assign({}, state, { at: new Date().toISOString() });
  try {
    fs.mkdirSync(path.dirname(AEON_CONNECT_FILE), { recursive: true });
  } catch {}
  writeFileDurably(AEON_CONNECT_FILE, JSON.stringify(record) + "\n", 0o600);
  return record;
}

// Hivra's basePath config: the AEON_BASE_PATH switch setting both basePath and
// assetPrefix, and no conflict-marker lines (a file git left mid-merge holds
// both sides, so it names AEON_BASE_PATH and is still a syntax error).
function aeonNextConfigUsable(text) {
  return typeof text === "string"
    && text.includes(AEON_NEXT_CONFIG_MARKER)
    && /\bbasePath\b/.test(text)
    && /\bassetPrefix\b/.test(text)
    && !/^(<{7}|={7}|>{7}|\|{7})(\s|$)/m.test(text);
}

// Keep the dashboard's /aeon basePath config in place. While the working-tree
// file is Hivra's version, a durable copy of it is kept; whenever it is not
// (a sync stopped part-way, an autostash git could not put back, a fork that
// changed the file, the dashboard's own `pull --rebase --autostash` leaving it
// conflicted), the durable copy (or the provisioner's text) is put back and
// an unmerged index entry for it is cleared. Nothing is written while a git
// operation is unfinished in the clone. The running dashboard keeps serving
// its build; the file matters for the next build, so it must never be lost.
async function ensureAeonNextConfig(gitDir) {
  if (aeonGitOperation(gitDir)) return;
  const file = path.join(AEON_DIR, AEON_NEXT_CONFIG);
  if ((await aeonGit("ls-files", "--unmerged", "--", AEON_NEXT_CONFIG)).out) {
    const cleared = await aeonGit("reset", "--quiet", "--", AEON_NEXT_CONFIG);
    if (!cleared.ok) {
      console.error("hivra-chat: aeon clone: the unresolved merge of " + AEON_NEXT_CONFIG + " could not be cleared: " + aeonDetail(cleared.err));
      return;
    }
    console.error("hivra-chat: aeon clone: cleared an unresolved merge of " + AEON_NEXT_CONFIG + " (git stash list keeps what was set aside)");
  }
  let current = null;
  try { current = fs.readFileSync(file, "utf8"); } catch {}
  if (aeonNextConfigUsable(current)) {
    let saved = null;
    try { saved = fs.readFileSync(AEON_NEXT_CONFIG_BACKUP, "utf8"); } catch {}
    if (saved !== current) {
      try { fs.mkdirSync(path.dirname(AEON_NEXT_CONFIG_BACKUP), { recursive: true }); } catch {}
      writeFileDurably(AEON_NEXT_CONFIG_BACKUP, current, 0o600);
    }
    return;
  }
  let text = null;
  try { text = fs.readFileSync(AEON_NEXT_CONFIG_BACKUP, "utf8"); } catch {}
  if (!aeonNextConfigUsable(text)) text = AEON_HIVRA_NEXT_CONFIG;
  if (!fs.existsSync(path.dirname(file))) {
    console.error("hivra-chat: aeon dashboard folder is missing; " + AEON_NEXT_CONFIG + " could not be restored");
    return;
  }
  if (writeFileDurably(file, text, 0o644)) {
    const what = current !== null && current.includes(AEON_NEXT_CONFIG_MARKER) ? "was damaged in " : "was missing from ";
    console.error("hivra-chat: aeon dashboard basePath config " + what + AEON_NEXT_CONFIG + " and has been restored");
  }
}

// owner/name of the connected fork from the clone's origin, or null while the
// clone still points at the upstream template (GitHub not connected yet).
async function aeonConnectedRepo() {
  // The configured URL, not `remote get-url` (which applies url.insteadOf).
  const origin = await aeonGit("config", "--get", "remote.origin.url");
  const m = origin.ok && origin.out.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  if (!m || m[1].toLowerCase() === AEON_UPSTREAM.toLowerCase()) return null;
  return m[1];
}

// Enable the fork's Aeon workflows GitHub disabled by itself. Reports each
// workflow's resulting state: active | enable_failed | missing | unknown |
// any other GitHub state (e.g. disabled_manually, left as the user chose).
// Uses the REST endpoints directly (what `gh workflow list/enable` wrap), so
// the result does not depend on how a gh version filters workflow states.
async function enableAeonWorkflows(repo) {
  const result = {};
  const listed = await aeonGh("api", "repos/" + repo + "/actions/workflows?per_page=100");
  let rows = null;
  try { rows = JSON.parse(listed.out).workflows; } catch {}
  if (!listed.ok || !Array.isArray(rows)) {
    console.error("hivra-chat: aeon workflows of " + repo + " could not be listed: " + aeonDetail(listed.err));
    for (const file of AEON_WORKFLOWS) result[file] = "unknown";
    return result;
  }
  for (const file of AEON_WORKFLOWS) {
    const row = rows.find((workflow) => workflow && workflow.path === ".github/workflows/" + file);
    if (!row) { result[file] = "missing"; continue; }
    if (!AEON_AUTO_DISABLED_WORKFLOWS.has(row.state)) { result[file] = String(row.state || "unknown"); continue; }
    const enabled = await aeonGh("api", "-X", "PUT", "repos/" + repo + "/actions/workflows/" + file + "/enable");
    if (!enabled.ok) console.error("hivra-chat: aeon workflow " + file + " could not be enabled on " + repo + ": " + aeonDetail(enabled.err));
    result[file] = enabled.ok ? "active" : "enable_failed";
  }
  return result;
}

function aeonRebaseInProgress(gitDir) {
  return fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"));
}

// A git operation left unfinished in the clone, with how to finish or cancel
// it, or null. The sync starts only rebases, so every merge, cherry-pick,
// revert, am or bisect is someone else's.
function aeonGitOperation(gitDir) {
  const has = (name) => fs.existsSync(path.join(gitDir, name));
  if (has("rebase-apply/applying")) return { name: "git am", how: "Finish it (git am --continue) or cancel it (git am --abort)" };
  if (aeonRebaseInProgress(gitDir)) return { name: "git rebase", rebase: true, how: "Finish it (git rebase --continue) or cancel it (git rebase --abort)" };
  if (has("MERGE_HEAD")) return { name: "git merge", how: "Finish it (git commit) or cancel it (git merge --abort)" };
  if (has("CHERRY_PICK_HEAD")) return { name: "git cherry-pick", how: "Finish it (git cherry-pick --continue) or cancel it (git cherry-pick --abort)" };
  if (has("REVERT_HEAD")) return { name: "git revert", how: "Finish it (git revert --continue) or cancel it (git revert --abort)" };
  if (has("sequencer")) return { name: "git cherry-pick or revert", how: "Finish it (git cherry-pick --continue or git revert --continue) or cancel it (--abort)" };
  if (has("BISECT_LOG")) return { name: "git bisect", how: "End it (git bisect reset)" };
  return null;
}

// Record, before the sync starts a rebase, what git will record for it, so a
// later sync can tell this rebase from one started anywhere else.
async function recordAeonSyncRebase(onto) {
  const head = await aeonRev("HEAD");
  const ref = await aeonGit("symbolic-ref", "--quiet", "HEAD");
  const record = { origHead: head, headName: ref.ok && ref.out ? ref.out : "detached HEAD", onto: await aeonRev(onto) };
  if (!head || !record.onto) return false;
  try { fs.mkdirSync(path.dirname(AEON_SYNC_REBASE_MARKER), { recursive: true }); } catch {}
  return writeFileDurably(AEON_SYNC_REBASE_MARKER, JSON.stringify(record) + "\n", 0o600);
}

// The record goes once no rebase is in progress (a rebase the sync could not
// roll back keeps it, so the next sync can).
function clearAeonSyncRebase(gitDir) {
  if (aeonRebaseInProgress(gitDir)) return;
  try { fs.rmSync(AEON_SYNC_REBASE_MARKER, { force: true }); } catch {}
}

// Whether the rebase in progress is the one the sync recorded: git's own
// orig-head, head-name and onto must match the record. A file git had not
// written yet (it was stopped as the rebase began) does not count against it.
function aeonSyncOwnsRebase(gitDir) {
  let record = null;
  try { record = JSON.parse(fs.readFileSync(AEON_SYNC_REBASE_MARKER, "utf8")); } catch {}
  if (!record || typeof record !== "object" || typeof record.origHead !== "string") return false;
  const stateDir = ["rebase-merge", "rebase-apply"].map((name) => path.join(gitDir, name)).find((dir) => fs.existsSync(dir));
  if (!stateDir || fs.existsSync(path.join(stateDir, "applying"))) return false;
  const recorded = { "orig-head": record.origHead, "head-name": record.headName, onto: record.onto };
  return Object.keys(recorded).every((name) => {
    let actual = null;
    try { actual = fs.readFileSync(path.join(stateDir, name), "utf8").trim(); } catch {}
    return actual === null || actual === recorded[name];
  });
}

// Before anything else reads the clone. A gateway stopped mid-sync can leave
// the sync's own rebase half done: roll it back. `rebase --abort` returns HEAD
// to where it was and puts the autostash back. If git itself was stopped
// before it wrote its rebase state, `rebase --quit` keeps the autostash in the
// stash list, and it is put straight back when nothing has moved since it was
// made. Any other unfinished git operation is left exactly as it is and
// returned as { busy }; { error } when the sync's own rebase stays.
async function recoverAeonClone(gitDir) {
  const operation = aeonGitOperation(gitDir);
  if (!operation) {
    clearAeonSyncRebase(gitDir);
    return {};
  }
  if (!operation.rebase || !aeonSyncOwnsRebase(gitDir)) return { busy: operation };
  const aborted = await aeonGit("rebase", "--abort");
  if (aborted.ok) {
    clearAeonSyncRebase(gitDir);
    console.error("hivra-chat: aeon clone: rolled back a rebase an earlier sync left unfinished");
    return {};
  }
  const stashBefore = await aeonRev("refs/stash");
  const quit = await aeonGit("rebase", "--quit");
  if (!quit.ok) {
    const detail = aeonDetail(aborted.err) + "; " + aeonDetail(quit.err);
    console.error("hivra-chat: aeon clone: an unfinished rebase could not be rolled back: " + detail);
    return { error: "A rebase an earlier sync left unfinished in the Aeon folder on this computer could not be rolled back: " + detail };
  }
  clearAeonSyncRebase(gitDir);
  const stashAfter = await aeonRev("refs/stash");
  if (stashAfter && stashAfter !== stashBefore
    && (await aeonRev(stashAfter + "^1")) === (await aeonRev("HEAD"))
    && (await aeonGit("diff", "--quiet", "HEAD")).ok) {
    const popped = await aeonGit("stash", "pop", "--quiet");
    if (!popped.ok) console.error("hivra-chat: aeon clone: edits set aside by an unfinished rebase stay in the stash list: " + aeonDetail(popped.err));
  }
  console.error("hivra-chat: aeon clone: cleared an unfinished rebase an earlier sync left behind");
  return {};
}

// Where this computer's own edits begin. The provisioned clone is a depth-1
// checkout of the pinned template commit, so its shallow boundary is exactly
// that point. It is preferred to a merge-base, which for a fork older than the
// pinned commit would also replay template commits the user never chose.
async function aeonEditsBase(gitDir, head, upstream) {
  let boundaries = [];
  try { boundaries = fs.readFileSync(path.join(gitDir, "shallow"), "utf8").split(/\s+/).filter((sha) => /^[0-9a-f]{40}$/.test(sha)); } catch {}
  for (const commit of boundaries) {
    if ((await aeonGit("merge-base", "--is-ancestor", commit, head)).ok) return commit;
  }
  const common = await aeonGit("merge-base", head, upstream);
  return common.ok && /^[0-9a-f]{40}$/.test(common.out) ? common.out : null;
}

// Commit the dashboard's unpushed saves (never anything else, never apps/) and
// put the clone on `branch`, tracking origin/<branch>, with those commits
// replayed on top of the fork. HEAD is either `branch` itself, the branch an
// earlier sync followed for a previously connected fork, or the provisioned
// detached checkout (the caller leaves any other checkout alone). Nothing the
// fork lacks is ever dropped: commits that conflict with the fork (or were made
// while another fork was connected) are kept on a local
// hivra/unpushed-edits-<time> branch and the clone follows the fork; every
// other edit rides through each move in git's autostash. Returns
// { parked, notes }, { error } or, when a git operation the sync did not start
// is unfinished in the clone, { busy } with nothing moved around it.
async function carryAeonEdits({ branch, gitDir, onBranch, switchedRepo }) {
  const upstream = "refs/remotes/origin/" + branch;
  const localRef = "refs/heads/" + branch;
  const parked = [];
  const notes = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  // Branches already kept aside stay reported with the error.
  const fail = (error) => ({ error, parked, notes });
  // Before a ref is moved, keep any commit on it the fork does not have (once).
  const keep = async (commit) => {
    if (!commit || (await aeonGit("merge-base", "--is-ancestor", commit, upstream)).ok) return "";
    const existing = await aeonGit("for-each-ref", "--format=%(refname:short)", "--points-at", commit, "refs/heads/hivra/");
    const already = existing.out.split("\n").find((name) => /^hivra\/unpushed-edits-/.test(name));
    if (already) {
      if (!parked.includes(already)) parked.push(already);
      return "";
    }
    for (let n = 1; n <= 20; n++) {
      const name = "hivra/unpushed-edits-" + stamp + (n > 1 ? "-" + n : "");
      if ((await aeonGit("branch", name, commit)).ok) {
        parked.push(name);
        return "";
      }
    }
    return "Local Aeon edits could not be kept aside on a branch.";
  };

  // A git operation someone else started since the sync began: left alone.
  const busy = aeonGitOperation(gitDir);
  if (busy) return { busy, parked, notes };
  // A file git left conflicted (an autostash the dashboard's own pull could
  // not put back, a `git stash pop` in the terminal) holds conflict markers:
  // it is never staged, committed or pushed, and nothing is moved around it.
  const unresolved = (await aeonGit("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
  if (unresolved.length) {
    return fail("Files in the Aeon folder on this computer have unresolved git conflicts: " + unresolved.slice(0, 10).join(", ")
      + ". Resolve them in the terminal; nothing was committed or pushed.");
  }

  // The dashboard's saves: tracked edits under the paths it writes, plus what
  // it already staged. Pathspecs git does not know are skipped (git add fails
  // on them). A staged file under apps/ is unstaged, never committed.
  const known = await aeonGit("ls-files", "-z", "--", ...AEON_SAVED_PATHS);
  const knownFiles = known.out.split("\0").filter(Boolean);
  const saved = AEON_SAVED_PATHS.filter((spec) => knownFiles.some((file) => file === spec || file.startsWith(spec + "/")));
  if (saved.length) {
    const added = await aeonGit("add", "--update", "--", ...saved);
    if (!added.ok) return fail("Aeon dashboard saves could not be staged: " + aeonDetail(added.err));
  }
  if ((await aeonGit("diff", "--cached", "--name-only", "--", "apps")).out) {
    const unstaged = await aeonGit("reset", "--quiet", "--", "apps");
    if (!unstaged.ok) return fail("Staged dashboard build files could not be left out: " + aeonDetail(unstaged.err));
  }
  if (!(await aeonGit("diff", "--cached", "--quiet")).ok) {
    const committed = await aeonGit("commit", "--quiet", "--no-verify", "-m", "chore: save Aeon dashboard edits made on this computer");
    if (!committed.ok) return fail("Aeon dashboard saves could not be committed: " + aeonDetail(committed.err));
  }
  const tip = await aeonRev("HEAD");
  if (!tip) return fail("The Aeon folder on this computer has no commit checked out.");

  // Where this computer's own commits begin: the fork's own history (on the
  // branch), the provisioned template commit (detached), or nowhere (another
  // fork's commits are never replayed into this one).
  let from = upstream;
  if (switchedRepo) {
    const failure = await keep(tip);
    if (failure) return fail(failure);
    from = tip;
  } else if (!onBranch) {
    const base = await aeonEditsBase(gitDir, tip, upstream);
    if (base) {
      from = base;
    } else {
      const failure = await keep(tip);
      if (failure) return fail(failure);
      notes.push("this computer's Aeon folder shares no history with the fork");
      from = tip;
    }
  }
  // Moving onto `branch`: a local branch of that name keeps its own commits.
  if (onBranch !== branch) {
    const failure = await keep(await aeonRev(localRef));
    if (failure) return fail(failure);
  }
  if (onBranch && onBranch !== branch) {
    // The branch an earlier sync followed for another fork: switch names in place.
    const renamed = await aeonGit("checkout", "--quiet", "-B", branch);
    if (!renamed.ok) return fail("The Aeon folder could not switch to " + branch + ": " + aeonDetail(renamed.err));
  }

  const stashBefore = await aeonRev("refs/stash");
  // Each rebase is recorded first, so only the sync's own is ever rolled back.
  const replay = async (start) => {
    if (!(await recordAeonSyncRebase(upstream))) return { ok: false, unrecorded: true, err: "" };
    return aeonGit("rebase", "--quiet", "--autostash", "--onto", upstream, start);
  };
  const unrecorded = "The Aeon folder on this computer could not follow the fork: the sync could not record its progress in " + AEON_SYNC_REBASE_MARKER + ".";
  // A rebase in progress that is not the one just recorded was started
  // elsewhere while this one could not begin: it is never rolled back.
  const foreignRebase = () => (aeonRebaseInProgress(gitDir) && !aeonSyncOwnsRebase(gitDir) ? { busy: aeonGitOperation(gitDir), parked, notes } : null);
  let moved = await replay(from);
  if (moved.unrecorded) return fail(unrecorded);
  if (!moved.ok && foreignRebase()) return foreignRebase();
  if (!moved.ok) {
    const conflicted = aeonRebaseInProgress(gitDir)
      && Boolean((await aeonGit("diff", "--name-only", "--diff-filter=U")).out);
    if (!conflicted) {
      // Not a conflict (an untracked file in the way, a lock held by a
      // dashboard save): roll back whatever git started, change nothing else
      // and force nothing.
      if (aeonRebaseInProgress(gitDir)) await aeonGit("rebase", "--abort");
      return fail("The Aeon folder on this computer could not follow the fork. " + aeonMoveFailureDetail(moved.err));
    }
    // A real conflict between this computer's commits and the fork: roll the
    // replay back (HEAD returns to the tip and the autostash is put back),
    // keep those commits on a local branch, then follow the fork.
    const aborted = await aeonGit("rebase", "--abort");
    if (!aborted.ok) return fail("A conflicting replay onto the fork could not be rolled back: " + aeonDetail(aborted.err));
    const failure = await keep(await aeonRev("HEAD"));
    if (failure) return fail(failure);
    notes.push(aeonDetail(moved.err));
    moved = await replay("HEAD");
    if (moved.unrecorded) return fail(unrecorded);
    if (!moved.ok && foreignRebase()) return foreignRebase();
    if (!moved.ok) {
      if (aeonRebaseInProgress(gitDir)) await aeonGit("rebase", "--abort");
      return fail("The Aeon folder on this computer could not follow the fork. " + aeonMoveFailureDetail(moved.err));
    }
  }
  // Edits git could not put back after the move are in the stash list: leave
  // no conflict markers or half-staged files behind (the edits are safe there).
  const stashAfter = await aeonRev("refs/stash");
  if (stashAfter && stashAfter !== stashBefore) {
    const unmerged = (await aeonGit("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
    await aeonGit("reset", "--quiet");
    if (unmerged.length) await aeonGit("checkout", "--quiet", "HEAD", "--", ...unmerged);
    notes.push("edits on this computer to " + (unmerged.length ? unmerged.join(", ") : "files") + " that the fork also changed were kept in the git stash (git stash list)");
  }
  if (!onBranch) {
    // The replay ran on the detached checkout; attach it (no working-tree change).
    const attached = await aeonGit("checkout", "--quiet", "-B", branch);
    if (!attached.ok) return fail("The Aeon folder could not switch to " + branch + ": " + aeonDetail(attached.err));
  }
  const tracked = await aeonGit("branch", "--quiet", "--set-upstream-to=origin/" + branch, branch);
  if (!tracked.ok) return fail("The Aeon clone could not track the fork: " + aeonDetail(tracked.err));
  if (parked.length) console.error("hivra-chat: aeon edits kept on " + parked.join(", ") + " (" + notes.join("; ") + ")");
  return { parked, notes };
}

async function syncAeonForkOnce(reason, attempt) {
  if (!fs.existsSync(path.join(AEON_DIR, ".git"))) return null;
  const repo = await aeonConnectedRepo();
  if (!repo) return null;
  const previous = readAeonConnectStatus();
  const state = { status: "syncing", repo, branch: null, pushReady: false, workflows: {}, parkedBranches: [], attempt: attempt + 1 };
  // Branches kept aside by earlier syncs stay reported while they exist.
  for (const name of previous && Array.isArray(previous.parkedBranches) ? previous.parkedBranches : []) {
    if (typeof name === "string" && /^hivra\/unpushed-edits-[0-9TZ-]+$/.test(name) && !state.parkedBranches.includes(name)
      && (await aeonRev("refs/heads/" + name))) state.parkedBranches.push(name);
  }
  writeAeonConnectStatus(state);
  const finish = (status, detail) => {
    state.status = status;
    if (detail) state.detail = detail;
    if (AEON_RETRYABLE_STATUSES.has(status) && attempt < AEON_SYNC_RETRY_DELAYS_MS.length) {
      state.retryAt = new Date(Date.now() + AEON_SYNC_RETRY_DELAYS_MS[attempt]).toISOString();
    }
    if (status !== "ok") console.error("hivra-chat: aeon fork sync (" + reason + ") " + status + ": " + (detail || "") + (state.retryAt ? " (retrying at " + state.retryAt + ")" : ""));
    return state;
  };
  // The outcome is written only once the clone is settled, so whoever reads
  // it (the connect reply, /api/login/status, a test) sees the final state.
  const settle = (status, detail) => writeAeonConnectStatus(finish(status, detail));

  const gitDir = (await aeonGit("rev-parse", "--absolute-git-dir")).out;
  if (!gitDir) return settle("error", "The Aeon folder on this computer is not a git clone.");
  // Before anything else: roll back what an interrupted sync left, and make
  // sure the basePath config is on disk (and durably copied) before any move.
  // A git operation started anywhere else (the owner's terminal, a dashboard
  // save stopped part-way) is left exactly as it is: nothing is written into
  // it, and saves wait until it is finished or cancelled.
  const busyDetail = (operation) => "A " + operation.name + (operation.rebase ? " that Hivra's sync did not start" : "")
    + " is unfinished in the Aeon folder on this computer, and the sync left it exactly as it is. " + operation.how
    + " in the terminal; Aeon dashboard saves are not pushed to " + repo + " until then.";
  const recovered = await recoverAeonClone(gitDir);
  if (recovered.busy) return settle("operation_in_progress", busyDetail(recovered.busy));
  if (recovered.error) return settle("error", recovered.error);
  await ensureAeonNextConfig(gitDir);
  const steps = async () => {
    const account = await aeonGh("api", "user");
    let user = null;
    try { user = JSON.parse(account.out); } catch {}
    const login = user && typeof user.login === "string" ? user.login : "";
    const id = user && Number.isSafeInteger(user.id) ? user.id : 0;
    if (!account.ok || !/^[A-Za-z0-9-]{1,39}$/.test(login) || id <= 0) {
      const kind = account.ok ? "other" : aeonRemoteFailure(account.err);
      if (kind === "transient") return finish("unreachable", "Could not reach GitHub from this computer: " + aeonDetail(account.err));
      if (kind === "denied" || kind === "credentials") return finish("auth_failed", "GitHub sign-in on this computer is not working: " + aeonDetail(account.err));
      return finish("error", "The GitHub account on this computer could not be read: " + aeonDetail(account.err || account.out));
    }
    state.workflows = await enableAeonWorkflows(repo);
    // gh becomes git's HTTPS credential helper for github.com (~/.gitconfig).
    const helper = await aeonGh("auth", "setup-git", "--hostname", "github.com");
    if (!helper.ok) {
      return finish("credentials_failed", "Git on this computer could not be given the GitHub sign-in for " + repo + ": " + aeonDetail(helper.err));
    }
    // Commits are made as the connected account, like GitHub's own web editor.
    const named = await aeonGit("config", "user.name", login);
    const mailed = await aeonGit("config", "user.email", id + "+" + login + "@users.noreply.github.com");
    if (!named.ok || !mailed.ok) return finish("error", "The Aeon clone's commit identity could not be set: " + aeonDetail(named.err || mailed.err));

    // A failed read of the fork: unreachable (retried), no credentials, or refused.
    const readFailure = (result, what) => {
      const kind = aeonRemoteFailure(result.err);
      if (kind === "transient") return finish("unreachable", "Could not reach GitHub to " + what + " " + repo + ": " + aeonDetail(result.err));
      if (kind === "credentials") return finish("credentials_failed", "Git on this computer has no GitHub sign-in for " + repo + ": " + aeonDetail(result.err));
      return finish("fetch_failed", "Could not " + what + " " + repo + " from GitHub: " + aeonDetail(result.err));
    };
    const head = await aeonGit("ls-remote", "--symref", "origin", "HEAD");
    const symref = head.ok && head.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m);
    if (!head.ok) return readFailure(head, "read");
    if (!symref || !(await aeonGit("check-ref-format", "--branch", symref[1])).ok) {
      return finish("fetch_failed", "Could not read the default branch of " + repo + " from GitHub.");
    }
    const branch = symref[1];
    state.branch = branch;

    // Only the fork's default branch (or the one an earlier sync followed for
    // another fork, or the untouched provisioned checkout) is ever moved. A
    // branch or commit the owner checked out by hand is left exactly as it
    // is, with nothing committed onto it; saves are not pushed until they
    // switch back.
    const current = await aeonGit("symbolic-ref", "--quiet", "--short", "HEAD");
    const onBranch = current.ok ? current.out : null;
    const followed = (await aeonGit("config", "--get", "hivra.syncedFork")).out;
    const followedBranch = (await aeonGit("config", "--get", "hivra.syncedBranch")).out;
    const ours = onBranch ? onBranch === branch || (Boolean(followedBranch) && onBranch === followedBranch) : !followed;
    if (!ours) {
      return finish("on_other_branch", "The Aeon folder on this computer is on " + (onBranch ? "the branch " + onBranch : "a commit checked out by hand")
        + ", not " + branch + ". Aeon dashboard saves are not pushed to " + repo + " until " + branch + " is checked out again; nothing was changed.");
    }

    const fetchFork = () => aeonExec("git", ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/" + branch + ":refs/remotes/origin/" + branch], 600000);
    const fetched = await fetchFork();
    if (!fetched.ok) return readFailure(fetched, "fetch");

    // Commits from a previously connected fork are never replayed into a different one.
    const switchedRepo = Boolean(followed) && followed.toLowerCase() !== repo.toLowerCase();
    // Branches this sync kept aside are reported even if a later step fails.
    const parked = new Set();
    const notes = [];
    const recordCarry = (carry) => {
      for (const name of carry.parked || []) {
        parked.add(name);
        if (!state.parkedBranches.includes(name)) state.parkedBranches.push(name);
      }
      notes.push(...(carry.notes || []));
    };
    const carried = await carryAeonEdits({ branch, gitDir, onBranch, switchedRepo });
    recordCarry(carried);
    if (carried.busy) return finish("operation_in_progress", busyDetail(carried.busy));
    if (carried.error) return finish("error", carried.error);
    await aeonGit("config", "hivra.syncedFork", repo);
    await aeonGit("config", "hivra.syncedBranch", branch);

    // Push the way the dashboard does: a plain `git push` of the tracked
    // branch. With nothing to push, a dry run still proves the credentials can
    // write. A push GitHub did not refuse (most often: the fork moved since the
    // fetch, e.g. an Actions run committed) is retried once after a new fetch
    // and replay.
    const pushOnce = async () => {
      const ahead = await aeonGit("rev-list", "--count", "refs/remotes/origin/" + branch + "..refs/heads/" + branch);
      return Number(ahead.out) > 0
        ? await aeonExec("git", ["push", "--quiet"], 300000)
        : await aeonGit("push", "--quiet", "--dry-run");
    };
    let push = await pushOnce();
    if (!push.ok && !["denied", "credentials"].includes(aeonRemoteFailure(push.err))) {
      console.error("hivra-chat: aeon fork sync (" + reason + ") push failed, fetching and retrying once: " + aeonDetail(push.err));
      const refetched = await fetchFork();
      if (refetched.ok) {
        const again = await carryAeonEdits({ branch, gitDir, onBranch: branch, switchedRepo: false });
        recordCarry(again);
        if (again.busy) return finish("operation_in_progress", busyDetail(again.busy));
        if (again.error) return finish("error", again.error);
        push = await pushOnce();
      } else {
        push = { ok: false, err: refetched.err };
      }
    }
    state.pushReady = push.ok;
    if (!push.ok) {
      const kind = aeonRemoteFailure(push.err);
      if (kind === "credentials") return finish("credentials_failed", "Git on this computer has no GitHub sign-in to push to " + repo + ": " + aeonDetail(push.err));
      if (kind === "denied") return finish("push_denied", "GitHub refused this computer's push to " + repo + ": " + aeonDetail(push.err));
      if (kind === "transient") return finish("unreachable", "Could not reach GitHub to push to " + repo + ": " + aeonDetail(push.err));
      // What GitHub said (a repository rule, push protection, a protected
      // branch), not git's closing "failed to push some refs" line.
      const rejection = aeonPushRejection(push.err);
      if (rejection) return finish("push_failed", "GitHub rejected this computer's push to " + repo + ": " + rejection);
      return finish("push_failed", "This computer could not push to " + repo + ": " + aeonDetail(push.err));
    }
    const said = [];
    if (parked.size) said.push("Edits made on this computer could not be applied to " + repo + " and were kept on the local branch " + Array.from(parked).join(", ") + ".");
    const stashed = notes.filter((note) => /git stash/.test(note));
    if (stashed.length) said.push(stashed.map((note) => note.charAt(0).toUpperCase() + note.slice(1) + ".").join(" "));
    return finish("ok", said.join(" "));
  };
  let outcome;
  try {
    outcome = await steps();
  } finally {
    clearAeonSyncRebase(gitDir);
    await ensureAeonNextConfig(gitDir);
  }
  return writeAeonConnectStatus(outcome);
}

let aeonSyncChain = Promise.resolve();
let aeonSyncRetry = null;
let aeonSyncGeneration = 0;
// Serialized; a sync GitHub could not be reached for is retried with backoff
// (AEON_SYNC_RETRY_DELAYS_MS). A newer sync (a reconnect) replaces a pending retry.
function syncAeonFork(reason, attempt) {
  const tries = attempt || 0;
  const generation = ++aeonSyncGeneration;
  if (aeonSyncRetry) {
    clearTimeout(aeonSyncRetry);
    aeonSyncRetry = null;
  }
  const run = aeonSyncChain.then(() => syncAeonForkOnce(reason, tries)).catch((error) => {
    console.error("hivra-chat: aeon fork sync (" + reason + ") crashed: " + ((error && error.stack) || error));
    const previous = readAeonConnectStatus();
    return writeAeonConnectStatus(Object.assign({}, previous || {}, { status: "error", pushReady: false, retryAt: undefined, detail: "The computer could not finish syncing with GitHub." }));
  });
  aeonSyncChain = run.then(() => undefined, () => undefined);
  void run.then((state) => {
    if (generation !== aeonSyncGeneration || !state || !state.retryAt || tries >= AEON_SYNC_RETRY_DELAYS_MS.length) return;
    aeonSyncRetry = setTimeout(() => {
      aeonSyncRetry = null;
      void syncAeonFork(reason, tries + 1);
    }, AEON_SYNC_RETRY_DELAYS_MS[tries]);
  });
  return run;
}

function managementCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
}
// Opt-in only from the installed computer service. Historical/managed guests
// retain their existing routes until the immutable installer supplies this
// protocol and its complete module/configuration closure.
const WORKSPACE_ROUTER = COMPUTER_PROFILE && process.env.HIVRA_WORKSPACE_PROTOCOL === "hivra-workspace-v1"
  ? require("./workspace-router.cjs").createWorkspaceRouter({
    computerId: process.env.HIVRA_REMOTE_DESKTOP_COMPUTER_ID,
    publicOrigin: process.env.HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN,
    controlOrigin: process.env.HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN,
    files: { list: handleFilesList, read: handleFileRead, write: handleFileWrite },
  }) : null;
const server = http.createServer((req, res) => {
  if (WORKSPACE_ROUTER && req.url.startsWith("/workspace/")) return void WORKSPACE_ROUTER.handleHttp(req, res);
  const u = req.url.split("?")[0];
  let q; try { q = new URL(req.url, "http://x").searchParams; } catch { q = new URLSearchParams(); }
  if (DEEPSEEK_BROKER) {
    const kind = DEEPSEEK_POLICY.routeKind(req.method, u);
    if (kind === "native") {
      // Native OPTIONS is authenticated by the broker too. Only exact Hivra
      // preflights belong to the management CORS response below.
      const preflight = req.method === "OPTIONS" && DEEPSEEK_POLICY.routeKind(req.headers["access-control-request-method"], u);
      if (preflight !== "computer" && preflight !== "unsupported" && preflight !== "public") return DEEPSEEK_BROKER.handleHttp(req, res);
    } else if (kind === "computer" || kind === "unsupported") {
      managementCors(res);
      if (!bearerAuthed(req)) return jsonRes(res, 401, { error: "Hivra management bearer required" });
      if (kind === "unsupported") return jsonRes(res, 409, { error: "Use the DeepSeek native interface for this operation", surface: "/" });
    } else if (kind === "bootstrap") {
      if (!DEEPSEEK_POLICY.matchesHost(req, DEEPSEEK_CONFIG.publicOrigin)) return denyHtml(res);
    } else if (kind === "surface" && !DEEPSEEK_POLICY.surfaceOriginAllowed(req, DEEPSEEK_CONFIG.publicOrigin)) {
      return denyHtml(res);
    }
  }
  // CORS: the Hivra dashboard streams browser->box directly (cross-origin).
  managementCors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method === "GET" && u === "/healthz") {
    const ready = !DEEPSEEK_BROKER || DEEPSEEK_BROKER.ready();
    res.writeHead(ready ? 200 : 503); return res.end(ready ? "ok" : "native runtime not ready");
  }
  if (req.method === "POST" && u === "/auth/bootstrap") return handleAuthBootstrap(req, res);
  // Aeon dashboard client code issues root-absolute requests (fetch("/api/strategy"),
  // <img src="/...">): Next's basePath only rewrites URLs the router/asset pipeline
  // controls, so these land on the box root — this chat server — and die as 404s.
  // Symptom: embedded dashboard stuck on "Loading…", dead Run buttons, broken images,
  // while the same endpoints work on :5555 under /aeon. Re-home them: any non-/aeon
  // request whose Referer is the /aeon app gets the basePath restored and proxied to
  // the dashboard. Requests from the Hivra parent (different origin in the Referer)
  // still reach this server's own /api/* — only in-app traffic is re-homed.
  if (AGENT_KIND === "aeon" && !u.startsWith("/aeon")) {
    let refPath = "";
    try { refPath = new URL(String(req.headers["referer"] || "")).pathname; } catch {}
    if (refPath === "/aeon" || refPath.startsWith("/aeon/")) {
      req.url = "/aeon" + req.url;
      return gateProxy(req, res, AEON_PORT);
    }
  }
  // OpenClaw's Control UI serves at root (no basePath option), so its root-absolute
  // assets/RPC (e.g. /assets/*, /api/*) land here instead of under /openclaw. Re-home
  // any in-app request (Referer is the /openclaw surface) back under /openclaw, where
  // the mount below strips the prefix before forwarding to the gateway.
  if (AGENT_KIND === "openclaw" && !u.startsWith("/openclaw")) {
    let refPath = "";
    try { refPath = new URL(String(req.headers["referer"] || "")).pathname; } catch {}
    if (refPath === "/openclaw" || refPath.startsWith("/openclaw/")) {
      req.url = "/openclaw" + req.url;
      return gateProxy(req, res, OPENCLAW_PORT, "/openclaw");
    }
  }
  // Agent Zero's web UI serves at root (no basePath), so its root-absolute assets/
  // RPC (e.g. /assets/*, /api/*) land here instead of under /agent-zero. Re-home any
  // in-app request (Referer is the /agent-zero surface) back under /agent-zero, where
  // the mount below strips the prefix before forwarding to the container.
  if (AGENT_KIND === "agent-zero" && !u.startsWith("/agent-zero")) {
    // The native Socket.IO client uses its default root transport path for
    // both polling and WebSocket upgrades. Keep that one exact endpoint at
    // root; a0Proxy applies the same owner/Origin gate as mounted native RPC.
    if (u === "/socket.io/" && (req.method === "GET" || req.method === "POST")) {
      req.url = "/agent-zero" + req.url;
      return a0Proxy(req, res);
    }
    let refPath = "";
    try { refPath = new URL(String(req.headers["referer"] || "")).pathname; } catch {}
    // Agent Zero's component loader creates blob modules. Their static imports
    // intentionally arrive without Referer; only these explicit static asset
    // namespaces and their exact shared /index.js entry may use that route,
    // never arbitrary root files, management APIs or writes.
    const nativeStatic = (req.method === "GET" || req.method === "HEAD")
      && (u === "/index.js" || /^\/(components|plugins|vendor|js|extensions\/webui)\//.test(u));
    if (nativeStatic) {
      // Native component/blob loaders resolve imports against location.origin.
      // Keep their URL identity at root, matching the two HTML entry scripts.
      // Redirecting aliases produces separate ModuleMap entries and executes
      // the same module twice even when the final response URL is identical.
      req.url = "/agent-zero" + req.url;
      return a0Proxy(req, res);
    }
    if (refPath === "/agent-zero" || refPath.startsWith("/agent-zero/")) {
      if (!authed(req)) return denyHtml(res);
      // Other document-origin requests retain the existing mounted route;
      // only the explicit static namespaces above use canonical root URLs.
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(307, { Location: "/agent-zero" + req.url, "Cache-Control": "no-store" });
        return res.end();
      }
      req.url = "/agent-zero" + req.url;
      return a0Proxy(req, res);
    }
  }
  if (req.method === "GET" && u === "/api/meta") return jsonRes(res, 200, { agentKind: AGENT_KIND, model: readAgentModel() || null, surfaceAuth: "post-cookie-v1", ...(COMPUTER_PROFILE ? { resourceKind: "computer", chatAvailable: false, loginAvailable: false, workspace: "Hivra" } : {}), ...(DEEPSEEK_BROKER ? { nativeSurface: "/", nativeReady: DEEPSEEK_BROKER.ready() } : {}), ...(AGENT_KIND === "codex" ? { llmApplication: LLM_APPLICATION_PROTOCOL } : {}) });
  // Per-box model override (Manage tab) — token-gated like everything stateful.
  if (req.method === "GET" && u === "/api/model") return authed(req) ? handleModelGet(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/model") return authed(req) ? readBody(req, (b) => handleModelSet(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  // Alternative LLM provider (Manage tab) — token-gated; GET never echoes the key.
  if (u === "/api/llm" || u === "/api/llm/application") res.setHeader("Cache-Control", "no-store");
  if (u === "/api/llm/application") return handleLlmApplication(req, res);
  if (req.method === "GET" && u === "/api/llm") return authed(req) ? handleLlmGet(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/llm") return authed(req) ? readBody(req, (b) => handleLlmSet(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  // Permission presets (Manage tab).
  if (req.method === "GET" && u === "/api/restrict") return authed(req) ? handleRestrictGet(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/restrict") return authed(req) ? readBody(req, (b) => handleRestrictSet(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  // Git explorer (Git tab).
  if (req.method === "GET" && u === "/api/git/status") return authed(req) ? handleGitStatus(res, q) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && u === "/api/git/diff") return authed(req) ? handleGitDiff(res, q) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/git/commit") return authed(req) ? readBody(req, (b) => handleGitCommit(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/git/checkout") return authed(req) ? readBody(req, (b) => handleGitCheckout(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  // Uploads (chat attachments).
  if (req.method === "POST" && u === "/api/upload") return authed(req) ? handleUpload(req, res) : jsonRes(res, 401, { error: "unauthorized" });
  // MCP server management (Manage tab).
  if (req.method === "GET" && u === "/api/mcp") return authed(req) ? handleMcpList(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/mcp") return authed(req) ? readBody(req, (b) => handleMcpAdd(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "DELETE" && u.startsWith("/api/mcp/")) return authed(req) ? handleMcpRemove(res, decodeURIComponent(u.slice("/api/mcp/".length))) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && (u === "/" || u === "/index.html")) return COMPUTER_PROFILE
    ? jsonRes(res, 404, { error: "agent chat is unavailable for this computer" })
    : serveFile(res, "index.html", "text/html; charset=utf-8");
  if (req.method === "GET" && u === "/app.js") return serveFile(res, "app.js", "application/javascript; charset=utf-8");
  // Code execution + account login are token-gated (was: open to anyone with the URL).
  if (req.method === "POST" && u === "/api/chat") return authed(req)
    ? COMPUTER_PROFILE ? jsonRes(res, 409, { error: "agent chat is unavailable for this computer" }) : handleChat(req, res)
    : jsonRes(res, 401, { error: "unauthorized" });
  if (u === "/api/chat/runs" || u.startsWith("/api/chat/runs/")) {
    if (!authed(req)) return jsonRes(res, 401, { error: "unauthorized" });
    if (!CHAT_RUNS) return jsonRes(res, 409, { error: "agent chat is unavailable for this computer" });
    try { return handleChatRuns(req, res, u, q); }
    catch (error) {
      console.error("hivra-chat: chat run request failed: " + ((error && error.stack) || error));
      if (!res.headersSent) return jsonRes(res, 500, { error: "The agent run could not be read." });
      return res.end();
    }
  }
  if (req.method === "GET" && u === "/api/login/status") return authed(req) ? handleLoginStatus(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/login/start") return authed(req) ? (COMPUTER_PROFILE ? jsonRes(res, 409, { error: "agent login is unavailable for this computer" }) : (AGENT_KIND === "generic" || AGENT_KIND === "openclaw" || AGENT_KIND === "agent-zero") ? jsonRes(res, 400, { error: "login not required for this agent" }) : AGENT_KIND === "aeon" ? jsonRes(res, 400, { error: "GitHub connect has no start step" }) : AGENT_KIND === "codex" ? handleLoginStartCodex(res) : handleLoginStart(res)) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/login/complete") return authed(req) ? (COMPUTER_PROFILE ? jsonRes(res, 409, { error: "agent login is unavailable for this computer" }) : (AGENT_KIND === "generic" || AGENT_KIND === "openclaw" || AGENT_KIND === "agent-zero") ? jsonRes(res, 200, { ok: true }) : AGENT_KIND === "aeon" ? readBody(req, (b) => handleLoginCompleteAeon(res, b)) : AGENT_KIND === "codex" ? handleLoginCompleteCodex(res) : readBody(req, (b) => handleLoginComplete(res, b))) : jsonRes(res, 401, { error: "unauthorized" });
  // Introspection endpoints (token-gated): chat history, file browser, skills.
  if (req.method === "GET" && (u === "/api/sessions" || u.startsWith("/api/sessions/"))) {
    if (!authed(req)) return jsonRes(res, 401, { error: "unauthorized" });
    if (COMPUTER_PROFILE) return jsonRes(res, 409, { error: "agent sessions are unavailable for this computer" });
    return u === "/api/sessions" ? handleSessionsList(res) : handleSessionRead(res, decodeURIComponent(u.slice("/api/sessions/".length)));
  }
  if (req.method === "GET" && u === "/api/files") return authed(req) ? handleFilesList(res, q) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && u === "/api/file") return authed(req) ? handleFileRead(res, q) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/file") return authed(req) ? handleFileWrite(req, res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && u === "/api/skills") return authed(req) ? handleSkillsList(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "DELETE" && u.startsWith("/api/skills/")) return authed(req) ? handleSkillDelete(res, decodeURIComponent(u.slice("/api/skills/".length))) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && u === "/api/telegram/status") return authed(req) ? handleTelegramStatus(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/telegram/connect") return authed(req) ? readBody(req, (b) => { void handleTelegramConnect(res, b); }) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/telegram/disconnect") return authed(req) ? handleTelegramDisconnect(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/cookies/import") return authed(req) ? readBodyLarge(req, (b) => handleCookieImport(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && u === "/api/browser/status") return authed(req) ? handleBrowserStatus(res) : jsonRes(res, 401, { error: "unauthorized" });
  if (req.method === "POST" && u === "/api/browser/toggle") return authed(req) ? readBody(req, (b) => handleBrowserToggle(res, b)) : jsonRes(res, 401, { error: "unauthorized" });
  // Proxied surfaces — token-gated (was: open to anyone with the URL = a free shell).
  // The dedicated remote-desktop broker performs its own one-time PKCE exchange,
  // continuous session introspection and input lifecycle fencing. Preserve the
  // public Host so that broker can bind the request to this exact computer.
  if (u === "/desktop" || u.startsWith("/desktop/")) {
    return proxyHttp(req, res, REMOTE_DESKTOP_BROKER_PORT, null, true);
  }
  if (u === "/terminal" || u.startsWith("/terminal/")) return gateProxy(req, res, 7681);
  if (u === "/box-terminal" || u.startsWith("/box-terminal/")) return gateProxy(req, res, 7682);
  // Live browser view: noVNC/websockify serves at root, so mount it under /vnc.
  if (u === "/vnc" || u.startsWith("/vnc/")) return gateProxy(req, res, 6080, "/vnc");
  // Aeon dashboard (Next.js). NO strip: Aeon is configured with basePath=/aeon
  // (set by the provisioner), so its own asset paths (/aeon/_next/...) route back
  // through this same gate. The dashboard has no auth of its own, so the gate is
  // the access boundary — same as the terminals.
  if (u === "/aeon" || u.startsWith("/aeon/")) return gateProxy(req, res, AEON_PORT);
  // OpenClaw gateway Control UI. STRIP /openclaw: the gateway serves at root, so we
  // peel the mount prefix before forwarding; root-absolute sub-resources are caught
  // by the re-home block above. Same gate-as-access-boundary model as Aeon.
  if (u === "/openclaw" || u.startsWith("/openclaw/")) return gateProxy(req, res, OPENCLAW_PORT, "/openclaw");
  if (u === "/agent-zero" || u.startsWith("/agent-zero/")) return a0Proxy(req, res);
  res.writeHead(404); res.end("not found");
});

server.on("upgrade", (req, socket, head) => {
  if (WORKSPACE_ROUTER && req.url.startsWith("/workspace/")) return void WORKSPACE_ROUTER.handleUpgrade(req, socket, head);
  if (DEEPSEEK_BROKER) {
    const pathname = req.url.split("?")[0];
    if (DEEPSEEK_POLICY.routeKind(req.method, pathname) !== "surface") return DEEPSEEK_BROKER.handleUpgrade(req, socket, head);
    if (!DEEPSEEK_POLICY.surfaceOriginAllowed(req, DEEPSEEK_CONFIG.publicOrigin)) { socket.destroy(); return; }
  }
  const u = req.url.split("?")[0];
  const remoteDesktopUpgrade = u.startsWith("/desktop/");
  // The ttyd/noVNC websockets carry the actual terminal/VNC I/O — gate them too.
  // The browser sends the hivra_auth cookie (set on the iframe's first load) on
  // the upgrade handshake automatically.
  // /desktop has a separate short-lived session cookie and must never accept
  // the management bearer/cookie as equivalent authority.
  if (!remoteDesktopUpgrade && !authed(req)) { try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch (e) {} socket.destroy(); return; }
  let port = null, strip = null;
  if (remoteDesktopUpgrade) port = REMOTE_DESKTOP_BROKER_PORT;
  else if (u.startsWith("/terminal")) port = 7681;
  else if (u.startsWith("/box-terminal")) port = 7682;
  else if (u.startsWith("/vnc")) { port = 6080; strip = "/vnc"; }
  else if (u.startsWith("/aeon")) port = AEON_PORT; // Next.js HMR ws (dev); no strip (basePath=/aeon)
  else if (u.startsWith("/openclaw")) { port = OPENCLAW_PORT; strip = "/openclaw"; } // gateway WS control/RPC (served at root)
  else if (u.startsWith("/agent-zero")) { port = AGENT_ZERO_PORT; strip = "/agent-zero"; } // Agent Zero WS (served at root)
  else if (AGENT_KIND === "agent-zero" && u === "/socket.io/") port = AGENT_ZERO_PORT;
  if (!port) { socket.destroy(); return; }
  let fwdUrl = req.url;
  if (strip) { fwdUrl = req.url.slice(strip.length); if (!fwdUrl.startsWith("/")) fwdUrl = "/" + fwdUrl; }
  // Agent Zero's WS also rides its form-login session (the browser never holds one —
  // we inject our managed cookie), so its live chat/canvas connect behind our gate.
  const a0Ws = port === AGENT_ZERO_PORT;
  const proxy = net.connect(port, "127.0.0.1", () => {
    let hdr = req.method + " " + fwdUrl + " HTTP/1.1\r\n";
    for (const [k, raw] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (a0Ws && key === "cookie") continue;
      if (key === "authorization") {
        const bearer = String(raw || "").match(/^Bearer\s+(.+)$/i);
        if (bearer && safeEq(bearer[1], API_TOKEN)) continue;
      }
      let v = raw;
      if (key === "cookie") {
        v = String(raw || "").split(";").map(part => part.trim()).filter(part => part && part.split("=", 1)[0] !== AUTH_COOKIE).join("; ");
        if (!v) continue;
      }
      hdr += k + ": " + v + "\r\n";
    }
    const nativeCookie = a0Ws ? a0UpstreamCookie() : null;
    if (nativeCookie) hdr += "cookie: " + nativeCookie + "\r\n";
    hdr += "\r\n";
    proxy.write(hdr);
    if (head && head.length) proxy.write(head);
    proxy.pipe(socket);
    socket.pipe(proxy);
  });
  proxy.on("error", () => socket.destroy());
  socket.on("error", () => proxy.destroy());
});

// Bind loopback only: cloudflared runs in-VM and connects to localhost, and the
// health checks curl 127.0.0.1 — so nothing legitimate needs the LAN interface.
// This keeps a compromised sibling VM from reaching the gateway by private IP.
server.listen(PORT, "127.0.0.1", () => console.log("hivra-chat listening on 127.0.0.1:" + PORT));
// Idempotent on every start: an Aeon computer connected to GitHub before the
// fork sync existed is repaired by the gateway restart of a runtime update.
if (AGENT_KIND === "aeon") setTimeout(() => { void syncAeonFork("startup"); }, 0);
if (WORKSPACE_ROUTER) {
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    WORKSPACE_ROUTER.close(); server.close(); process.exit(0);
  });
}
if (DEEPSEEK_BROKER) {
  const controller = new AbortController();
  let stopping = false;
  function stopGateway(code) {
    if (stopping) return;
    stopping = true;
    DEEPSEEK_BROKER.close(); controller.abort(); server.close();
    // Exiting the supervisor is intentional: systemd owns and reaps the whole
    // cgroup (including detached tool groups) before it can restart the unit.
    // The child helper alone must never certify descendant cleanup.
    process.exit(code);
  }
  process.once("SIGTERM", () => stopGateway(0));
  process.once("SIGINT", () => stopGateway(0));
  require("./deepseek-harness/runtime-process.cjs").startRuntime({
    ...DEEPSEEK_CONFIG, broker: DEEPSEEK_BROKER, signal: controller.signal,
    onUnexpectedExit: () => stopGateway(1),
  }).catch(() => {
    console.error("DeepSeek native startup failed; inspect the owned service. Native output is withheld because it contains credentials.");
    stopGateway(1);
  });
}
