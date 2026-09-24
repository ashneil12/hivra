// Hivra chat page served by the computer itself (GET /).
//
// Every turn runs detached on the computer (see chat-runs.cjs): this page starts
// a run and streams it, but it can go away at any time (reload, closed tab,
// dropped network, a restarted chat service) without ending the agent's work.
// The conversation is kept in localStorage, and a reply the page did not see
// finish is rebuilt from the run's event log when the page comes back. Only
// Stop ends a run early.
//
// Stream lines (one JSON object each):
//   claude   `claude -p --output-format stream-json --include-partial-messages`
//   codex    `codex exec --json`: thread.started, item.*, turn.failed, error
//   generic  {type:"_text"} lines wrapping a plain CLI's stdout
// plus the computer's own: _run (preface), _ping (heartbeat), _stderr, and
// _done (the run's outcome, always the last line).
"use strict";

const STORE_KEY = "hivra-chat:conversation:v1";
const MAX_TURNS = 30;
const MAX_STORED_CHARS = 1500000;
// Starting a run is idempotent per runId, so a start whose connection failed is
// repeated: it attaches to the run if the first request did reach the computer.
const START_DELAYS_MS = [0, 1000, 3000];
// Re-attach attempts after a stream drops. After that the page waits for focus,
// the network coming back, or the periodic check below.
const RETRY_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
const REATTACH_INTERVAL_MS = 20000;
const SESSION_ID_RE = /^[0-9a-f-]{8,}$/i;
const CURSOR = '<span class="cursor"></span>';
const SIGNED_OUT_SEND = "Your session on this computer has ended, so the message was not sent. Reopen this page from your Hivra dashboard and send it again.";
const SIGNED_OUT_FOLLOW = "Your session on this computer has ended. Reopen this page from your Hivra dashboard to see the reply; the agent keeps working in the meantime.";
const OFFLINE = "Lost the connection to the computer. The agent keeps working; the reply continues here when the computer is reachable again.";
const UNSENT = "Couldn't reach the computer. This page checks again when the connection is back and tells you if the message needs sending again.";

// `warn` picks the stderr lines worth showing, as the dashboard's chat does.
const AGENTS = {
  claude: { name: "Claude Code", avatar: "C", runs: "Runs the official <code>claude</code> CLI on your own login", warn: /error|invalid|denied|expired|unauthor/i },
  codex: { name: "Codex", avatar: "C", runs: "Runs the official <code>codex</code> CLI on your own login", warn: /error|invalid|denied|expired|unauthor/i },
  generic: { name: "Agent", avatar: "A", runs: "Runs your agent's own command on this computer", warn: /error|invalid|denied|expired|unauthor|fatal|traceback/i },
};
let agent = AGENTS.claude;

const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const newBtn = $("new");
const statusEl = $("status");
const emptyEl = $("empty");
const modelEl = $("model");

// The run this page is showing live, or null. At most one at a time.
let active = null;
let resuming = false;
let saveTimer = null;
const views = new Map(); // turn -> { body, tools, note, transient }

// ---- the conversation, kept on this device ----------------------------------

function emptyState() {
  return { sessionId: null, turns: [] };
}
function normalizeTurn(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  return {
    user: String(t.user || ""),
    assistant: String(t.assistant || ""),
    tools: Array.isArray(t.tools) ? t.tools.filter((x) => x && typeof x === "object").map((x) => ({ id: String(x.id || ""), name: String(x.name || "tool"), detail: String(x.detail || "") })) : [],
    warnings: Array.isArray(t.warnings) ? t.warnings.map(String) : [],
    runId: typeof t.runId === "string" ? t.runId : null,
    done: t.done === true,
    outcome: typeof t.outcome === "string" ? t.outcome : null,
  };
}
function loadState() {
  let raw = null;
  try { raw = window.localStorage.getItem(STORE_KEY); } catch { return emptyState(); }
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw);
    return {
      sessionId: typeof parsed.sessionId === "string" && SESSION_ID_RE.test(parsed.sessionId) ? parsed.sessionId : null,
      turns: Array.isArray(parsed.turns) ? parsed.turns.map(normalizeTurn).filter((t) => t.user) : [],
    };
  } catch (e) {
    console.warn("hivra-chat: ignoring an unreadable saved conversation", e);
    return emptyState();
  }
}
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const turns = state.turns.slice(-MAX_TURNS);
  for (;;) {
    const json = JSON.stringify({ v: 1, sessionId: state.sessionId, turns });
    if (json.length > MAX_STORED_CHARS && turns.length > 1) { turns.shift(); continue; }
    try {
      window.localStorage.setItem(STORE_KEY, json);
      return;
    } catch (e) {
      // Quota: keep the newest turns, which include any unfinished reply.
      if (turns.length > 1) { turns.shift(); continue; }
      console.warn("hivra-chat: could not save the conversation on this device", e);
      return;
    }
  }
}
let state = loadState();

function adoptSession(id) {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id) || state.sessionId === id) return;
  state.sessionId = id;
  saveSoon();
}

// ---- rendering ----------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Minimal markdown: fenced code blocks + inline code. Everything else is plain
// text with whitespace preserved by CSS (white-space:pre-wrap).
function renderMarkdown(text) {
  const parts = text.split(/```/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let code = parts[i].replace(/^[a-zA-Z0-9_-]*\n/, "");
      out += "<pre><code>" + escapeHtml(code) + "</code></pre>";
    } else {
      let seg = escapeHtml(parts[i]).replace(/`([^`]+)`/g, "<code>$1</code>");
      out += seg;
    }
  }
  return out;
}

function addMessage(role) {
  if (emptyEl) emptyEl.style.display = "none";
  const msg = document.createElement("div");
  msg.className = "msg " + role;
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = role === "user" ? "you" : agent.avatar;
  const col = document.createElement("div");
  col.style.flex = "1";
  col.style.minWidth = "0";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "You" : agent.name;
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.style.display = "none";
  const body = document.createElement("div");
  body.className = "body";
  const note = document.createElement("div");
  note.className = "note";
  note.style.display = "none";
  col.appendChild(who);
  col.appendChild(tools);
  col.appendChild(body);
  col.appendChild(note);
  msg.appendChild(av);
  msg.appendChild(col);
  log.appendChild(msg);
  scrollDown();
  return { body, tools, note, transient: "" };
}

function toolChip(tool) {
  const chip = document.createElement("span");
  chip.className = "chip";
  const icon = tool.name === "Bash" ? "⚙" : (/browser|cdp|harness/i.test(tool.name) ? "🌐" : "🔧");
  chip.innerHTML = "<span>" + icon + "</span><b>" + escapeHtml(tool.name) + "</b>" +
    (tool.detail ? '<span class="t">' + escapeHtml(tool.detail) + "</span>" : "");
  return chip;
}

function renderTurn(turn) {
  addMessage("user").body.textContent = turn.user;
  views.set(turn, addMessage("assistant"));
  paintTools(turn);
  paintText(turn);
}

function paintText(turn) {
  const view = views.get(turn);
  if (!view) return;
  const live = Boolean(active && active.turn === turn);
  let text = turn.assistant;
  for (const warning of turn.warnings) text += (text ? "\n\n" : "") + "⚠ " + warning;
  if (text) view.body.innerHTML = renderMarkdown(text) + (live ? CURSOR : "");
  else if (live) view.body.innerHTML = CURSOR;
  else if (turn.done && turn.outcome !== "stopped") view.body.innerHTML = "<span class='think'>(no text response)</span>";
  else view.body.innerHTML = "";
  const note = view.transient || (turn.outcome === "stopped" ? "Stopped." : "");
  view.note.textContent = note;
  view.note.style.display = note ? "" : "none";
  scrollDown();
}

function paintTools(turn) {
  const view = views.get(turn);
  if (!view) return;
  view.tools.textContent = "";
  view.tools.style.display = turn.tools.length ? "flex" : "none";
  for (const tool of turn.tools) view.tools.appendChild(toolChip(tool));
  scrollDown();
}

// A transient line under a reply (reconnecting, signed out). Not persisted.
function note(turn, text) {
  const view = views.get(turn);
  if (!view) return;
  view.transient = text || "";
  paintText(turn);
}

function scrollDown() {
  const main = $("main");
  main.scrollTop = main.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setBusy(busy, status) {
  sendBtn.disabled = busy;
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  stopBtn.disabled = false;
  if (newBtn) newBtn.disabled = busy;
  setStatus(status || (busy ? "thinking…" : "ready"));
}

function showModel(model) {
  if (!modelEl) return;
  modelEl.textContent = String(model).replace(/\[.*\]/, "").replace("claude-", "");
  modelEl.hidden = false;
}

function applyAgent(next) {
  agent = next;
  document.title = "Hivra · " + agent.name;
  document.querySelectorAll(".agent-name").forEach((el) => { el.textContent = agent.name; });
  document.querySelectorAll(".msg.assistant .who").forEach((el) => { el.textContent = agent.name; });
  document.querySelectorAll(".msg.assistant .avatar").forEach((el) => { el.textContent = agent.avatar; });
  input.placeholder = "Message " + agent.name + "…";
  const hint = $("hint-runtime");
  if (hint) hint.innerHTML = agent.runs;
}

// /api/meta is public and says which agent this computer runs.
async function loadMeta() {
  try {
    const resp = await fetch("/api/meta", { credentials: "same-origin", cache: "no-store" });
    if (!resp.ok) return;
    const meta = await resp.json();
    if (meta && Object.prototype.hasOwnProperty.call(AGENTS, meta.agentKind)) applyAgent(AGENTS[meta.agentKind]);
    if (meta && typeof meta.model === "string" && meta.model) showModel(meta.model);
  } catch (e) {
    console.warn("hivra-chat: could not read this computer's agent details", e);
  }
}

// ---- stream parsing (claude, codex and generic share one page) ----------------

function newParse() {
  return { seenText: false, segments: new Map(), done: null };
}

function appendText(turn, text) {
  turn.assistant += text;
  paintText(turn);
  saveSoon();
}
function addWarning(turn, text) {
  const warning = String(text || "").trim();
  if (!warning || turn.warnings.includes(warning)) return;
  turn.warnings.push(warning);
  paintText(turn);
  saveSoon();
}
function upsertTool(turn, id, name, detail) {
  const key = id ? String(id) : "";
  const existing = key ? turn.tools.find((t) => t.id === key) : null;
  const clean = String(detail || "").slice(0, 140);
  if (existing) {
    existing.name = name || existing.name;
    if (clean) existing.detail = clean;
  } else {
    turn.tools.push({ id: key, name: name || "tool", detail: clean });
  }
  paintTools(turn);
  saveSoon();
}
function toolDetail(input) {
  const i = input && typeof input === "object" ? input : {};
  return String(i.command || i.url || i.file_path || i.path || i.pattern || i.query || "");
}
function codexFiles(item) {
  if (Array.isArray(item.changes)) {
    return item.changes.map((c) => (c && typeof c === "object" ? String(c.path || c.file || "") : "")).filter(Boolean).join(", ");
  }
  return String(item.path || "");
}
function blocksText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : "")).join("");
}

function codexItem(run, item) {
  const turn = run.turn;
  const kind = String(item.item_type || item.type || "");
  const id = String(item.id || kind);
  if (kind === "agent_message" || kind === "assistant_message") {
    // Codex re-sends a message's full text on each update; keep one segment per
    // item so several messages in one turn read in order.
    const text = String(item.text || item.message || blocksText(item.content)).trim();
    if (!text) return;
    run.parse.segments.set(id, text);
    turn.assistant = Array.from(run.parse.segments.values()).join("\n\n");
    paintText(turn);
    saveSoon();
  } else if (kind === "command_execution") {
    upsertTool(turn, id, "Bash", String(item.command || ""));
  } else if (kind === "file_change" || kind === "patch" || kind === "patch_apply") {
    upsertTool(turn, id, "Edit", codexFiles(item));
  } else if (kind === "web_search") {
    upsertTool(turn, id, "WebSearch", String(item.query || ""));
  } else if (kind === "mcp_tool_call") {
    upsertTool(turn, id, String(item.tool || item.name || "mcp"), String(item.server || ""));
  } else if (kind === "error") {
    addWarning(turn, String(item.message || "error"));
  }
}

function applyEvent(run, ev) {
  const turn = run.turn;
  switch (ev.type) {
    case "_run":
    case "_ping":
      return;
    case "_done":
      run.parse.done = ev;
      return;
    case "_text":
      if (ev.text) appendText(turn, String(ev.text));
      return;
    case "_stderr": {
      const text = String(ev.text || "").trim();
      if (text && agent.warn.test(text)) addWarning(turn, text);
      return;
    }
    case "system":
      if (ev.subtype === "init") {
        adoptSession(ev.session_id);
        if (ev.model) showModel(ev.model);
      }
      return;
    case "stream_event": {
      const e = ev.event && typeof ev.event === "object" ? ev.event : {};
      if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && e.delta.text) {
        run.parse.seenText = true;
        appendText(turn, String(e.delta.text));
      } else if (e.type === "content_block_start" && e.content_block && e.content_block.type === "tool_use") {
        upsertTool(turn, e.content_block.id, e.content_block.name || "tool", toolDetail(e.content_block.input));
      }
      return;
    }
    case "assistant": {
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      for (const block of content) {
        if (block && block.type === "tool_use") upsertTool(turn, block.id, block.name || "tool", toolDetail(block.input));
      }
      // Without partial messages there are no deltas, only whole messages. Use
      // their text only then, so partial + final never double the reply.
      if (!run.parse.seenText) {
        const text = content.map((b) => (b && b.type === "text" ? String(b.text || "") : "")).join("");
        if (text) { run.parse.seenText = true; appendText(turn, text); }
      }
      return;
    }
    case "result":
      adoptSession(ev.session_id);
      // API failures (an invalid model, an expired login) end the turn here.
      if (ev.is_error) addWarning(turn, typeof ev.result === "string" && ev.result ? ev.result : "The request failed.");
      return;
    case "thread.started":
      adoptSession(ev.thread_id);
      return;
    case "item.started":
    case "item.updated":
    case "item.completed":
      codexItem(run, ev.item && typeof ev.item === "object" ? ev.item : {});
      return;
    case "turn.failed":
      addWarning(turn, String((ev.error && ev.error.message) || "The turn failed."));
      return;
    case "error":
      if (ev.message) addWarning(turn, String(ev.message));
      return;
    default:
      return;
  }
}

// ---- runs ---------------------------------------------------------------------

function runUrl(runId, suffix) {
  return "/api/chat/runs/" + encodeURIComponent(runId) + suffix;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function newRunId() {
  const c = window.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function beginRun(turn, starting) {
  const view = views.get(turn);
  if (view) view.transient = "";
  active = { turn, runId: turn.runId, parse: newParse(), starting, stopping: false, stopRequested: false };
  setBusy(true);
  paintText(turn);
  return active;
}
// The page stops showing the run live. `turn.done` says whether it finished.
function endRun(run, status) {
  if (active === run) active = null;
  setBusy(false, status);
  paintText(run.turn);
  saveNow();
}

function finishRun(run) {
  const turn = run.turn;
  const done = run.parse.done || {};
  turn.done = true;
  if (done.interrupted) {
    turn.outcome = "interrupted";
    addWarning(turn, "The run was interrupted before it finished because the computer restarted.");
  } else if (done.stopped) {
    turn.outcome = "stopped";
  } else if (typeof done.code === "number" && done.code !== 0) {
    turn.outcome = "error";
    if (!turn.assistant && !turn.warnings.length) addWarning(turn, "The agent exited with an error (code " + done.code + ").");
  } else {
    turn.outcome = "complete";
  }
  const view = views.get(turn);
  if (view) view.transient = "";
  endRun(run, "ready");
}

// The run keeps going on the computer; this page just cannot show it right now.
function suspendRun(run, message, status) {
  const view = views.get(run.turn);
  if (view) view.transient = message;
  endRun(run, status);
}

// The computer has no such run: either the message never reached it (a start
// cut off by a reload or a dropped connection) or the run was cleared since.
function missingRun(run) {
  const turn = run.turn;
  turn.done = true;
  turn.outcome = "error";
  if (!turn.assistant && !turn.tools.length) {
    addWarning(turn, "This message didn't reach the computer. Send it again.");
    if (!input.value) { input.value = turn.user; autoGrow(); }
  } else {
    addWarning(turn, "This reply is no longer available on the computer.");
  }
  endRun(run, "ready");
}

// The message never became a run. Put it back in the composer to send again.
function failStart(run, reason, text, status) {
  const turn = run.turn;
  turn.done = true;
  turn.outcome = "error";
  addWarning(turn, reason);
  if (!input.value) { input.value = text; autoGrow(); }
  endRun(run, status || "ready");
}

async function startFailure(resp) {
  if (resp.status === 401) return SIGNED_OUT_SEND;
  let detail = "";
  try {
    const raw = (await resp.text()).trim();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch {
      if (raw && raw.length <= 300 && raw[0] !== "<") detail = raw;
    }
  } catch { /* no body */ }
  console.warn("hivra-chat: the computer did not start the reply (HTTP " + resp.status + ")", detail);
  return detail || "The computer returned an error (HTTP " + resp.status + "). Try again.";
}

// Read one NDJSON stream into the run's reply. "done" once the run's `_done`
// line arrived; "ended" when the stream stopped first (network drop, proxy
// timeout, a restarted chat service) while the run keeps working.
async function readStream(run, body) {
  if (!body) return "ended";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const dispatch = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev && typeof ev === "object") applyEvent(run, ev);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (active !== run) {
        reader.cancel().catch(() => { /* already closed */ });
        return "superseded";
      }
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        dispatch(line);
      }
      if (done) break;
    }
    dispatch(buf);
  } catch (e) {
    if (active !== run) return "superseded";
    console.warn("hivra-chat: the reply stream dropped; re-attaching to the run", e);
  }
  saveSoon();
  return run.parse.done ? "done" : "ended";
}

// Re-read a run from the start of its log, rebuilding the reply, and follow it
// live until it finishes.
async function follow(run) {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt]) {
      note(run.turn, "Reconnecting to the computer…");
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
    if (active !== run) return;
    let resp;
    try {
      resp = await fetch(runUrl(run.runId, "/events"), { credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      console.warn("hivra-chat: re-attaching to the run failed", e);
      continue;
    }
    if (active !== run) return;
    if (resp.status === 401) return suspendRun(run, SIGNED_OUT_FOLLOW, "signed out");
    if (resp.status === 404) return missingRun(run);
    if (!resp.ok) {
      console.warn("hivra-chat: the run's log could not be read (HTTP " + resp.status + ")");
      continue;
    }
    note(run.turn, "");
    run.parse = newParse();
    run.turn.assistant = "";
    run.turn.tools = [];
    run.turn.warnings = [];
    paintTools(run.turn);
    paintText(run.turn);
    const result = await readStream(run, resp.body);
    if (result === "done") return finishRun(run);
    if (result === "superseded") return;
  }
  suspendRun(run, OFFLINE, "offline");
}

async function send(raw) {
  if (active) return;
  const text = String(raw != null ? raw : input.value).trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  const turn = normalizeTurn({ user: text, runId: newRunId() });
  state.turns.push(turn);
  renderTurn(turn);
  const run = beginRun(turn, true);
  saveNow(); // a reload from here on finds the turn and its run
  const body = JSON.stringify({ message: text, sessionId: state.sessionId, detach: true, runId: turn.runId });
  let resp = null;
  for (let attempt = 0; attempt < START_DELAYS_MS.length && !resp; attempt++) {
    if (START_DELAYS_MS[attempt]) await sleep(START_DELAYS_MS[attempt]);
    try {
      resp = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      console.warn("hivra-chat: sending the message failed (attempt " + (attempt + 1) + ")", e);
    }
  }
  if (active !== run) return;
  // No answer at all: the message may or may not have reached the computer.
  // Keep the turn open; resuming it finds the run or asks to send again.
  if (!resp) return suspendRun(run, UNSENT, "offline");
  if (!resp.ok) {
    const reason = await startFailure(resp);
    failStart(run, reason, text, resp.status === 401 ? "signed out" : "ready");
    // "Still working on the previous message": pick that reply back up.
    if (resp.status === 409) void resume();
    return;
  }
  run.starting = false;
  if (run.stopRequested) void requestStop(run).then((ok) => { if (!ok) stopFailed(run); });
  const result = await readStream(run, resp.body);
  if (result === "done") return finishRun(run);
  if (result === "ended") return follow(run);
}

// Ask the computer to end the run. The run's stream then ends with its
// `_done` line (stopped: "user"), which finishes the reply here.
async function requestStop(run) {
  let resp;
  try {
    resp = await fetch(runUrl(run.runId, "/stop"), { method: "POST", credentials: "same-origin" });
  } catch (e) {
    console.warn("hivra-chat: stopping the run failed", e);
    note(run.turn, "Couldn't reach the computer to stop the reply. Try again.");
    return false;
  }
  if (resp.ok) return true;
  // Stop pressed before the start reached the computer: stop right after it does.
  if (resp.status === 404 && run.starting) { run.stopRequested = true; return true; }
  console.warn("hivra-chat: the computer did not stop the run (HTTP " + resp.status + ")");
  note(run.turn, resp.status === 401 ? SIGNED_OUT_FOLLOW : "The computer couldn't stop the reply (HTTP " + resp.status + "). Try again.");
  return false;
}

async function stopActive() {
  const run = active;
  if (!run || run.stopping) return;
  run.stopping = true;
  stopBtn.disabled = true;
  setStatus("stopping…");
  if (!(await requestStop(run))) stopFailed(run);
}
// The run is still going: offer Stop again.
function stopFailed(run) {
  if (active !== run) return;
  run.stopping = false;
  stopBtn.disabled = false;
  setStatus("thinking…");
}

// Pick up a reply this page did not see finish: still running on the computer,
// or finished while the page was closed. Its run log rebuilds it either way.
async function resume() {
  if (active || resuming) return;
  const turn = state.turns.find((t) => !t.done && t.runId);
  if (!turn) return;
  resuming = true;
  let runs = null;
  try {
    let resp;
    try {
      resp = await fetch("/api/chat/runs", { credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      console.warn("hivra-chat: could not reach the computer to resume the reply", e);
      note(turn, OFFLINE);
      setStatus("offline");
      return;
    }
    if (resp.status === 401) {
      note(turn, SIGNED_OUT_FOLLOW);
      setStatus("signed out");
      return;
    }
    if (!resp.ok) {
      console.warn("hivra-chat: the computer's runs could not be listed (HTTP " + resp.status + ")");
      note(turn, "The computer couldn't report on this reply (HTTP " + resp.status + "). This page tries again shortly.");
      return;
    }
    try {
      const data = await resp.json();
      runs = data && Array.isArray(data.runs) ? data.runs : null;
    } catch (e) {
      console.warn("hivra-chat: the computer's run list was unreadable", e);
    }
  } finally {
    resuming = false;
  }
  if (active || turn.done) return;
  const known = runs && runs.find((r) => r && r.runId === turn.runId);
  if (known && known.agentSessionId && !state.sessionId) adoptSession(known.agentSessionId);
  // Follow even a run missing from the recent list: its own log is
  // authoritative and answers 404 once the run is gone.
  await follow(beginRun(turn, false));
}

function newChat() {
  if (active) return;
  state = emptyState();
  views.clear();
  log.textContent = "";
  if (emptyEl) emptyEl.style.display = "";
  saveNow();
  setStatus("ready");
  input.focus();
}

// ---- composer + lifecycle -----------------------------------------------------

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", () => send());
stopBtn.addEventListener("click", () => stopActive());
if (newBtn) newBtn.addEventListener("click", () => newChat());
document.querySelectorAll(".ex").forEach((el) =>
  el.addEventListener("click", () => send(el.textContent))
);

const wake = () => {
  if (document.visibilityState !== "hidden") void resume();
};
window.addEventListener("focus", wake);
window.addEventListener("online", wake);
document.addEventListener("visibilitychange", wake);
setInterval(wake, REATTACH_INTERVAL_MS);
window.addEventListener("pagehide", saveNow);

for (const turn of state.turns) renderTurn(turn);
for (const turn of state.turns) {
  if (!turn.done && turn.runId) {
    note(turn, "Picking the reply back up from the computer…");
    setStatus("reconnecting…");
  }
}
void loadMeta();
void resume();
