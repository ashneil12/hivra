// Hivra chat page served by the computer itself (GET /).
//
// Every turn runs detached on the computer (see chat-runs.cjs): this page starts
// a run and streams it, but it can go away at any time (reload, closed tab,
// dropped network, a restarted chat service) without ending the agent's work.
// The conversation is kept in localStorage, and a reply the page did not see
// finish is rebuilt from the run's event log when the page comes back. Only
// Stop ends a run early.
//
// GET / and this script are public, so nothing saved on this device is shown
// until the computer has accepted this page's session. Tabs of this page share
// the saved conversation: every save merges by run id, other tabs' saves arrive
// as `storage` events, and a Web Lock per run keeps two tabs from following the
// same run. While another tab is following a reply, this tab does not send: the
// agent's conversation is busy until that reply finishes.
//
// Stream lines (one JSON object each):
//   claude   `claude -p --output-format stream-json --include-partial-messages`
//   codex    `codex exec --json`: thread.started, item.*, turn.failed, error
//   generic  {type:"_text"} lines wrapping a plain CLI's stdout
// plus the computer's own: _run (preface), _ping (heartbeat), _stderr, and
// _done (the run's outcome, always the last line). All but _run and _ping are
// the run's log, which `/events?offset=` counts in bytes.
"use strict";

const STORE_KEY = "hivra-chat:conversation:v1";
const MAX_TURNS = 30;
const MAX_STORED_CHARS = 1500000;
// Starting a run is idempotent per runId, so a start whose connection failed is
// repeated: it attaches to the run if the first request did reach the computer.
const START_DELAYS_MS = [0, 1000, 3000];
// While the computer swaps its agent CLI for the vetted version it refuses a new
// run with 503 agent_updating for a few seconds: keep the message and send it
// again, for about two minutes.
const UPDATING_DELAYS_MS = [3000, 5000, 5000, 10000, 10000, 15000, 15000, 20000, 20000, 20000];
// Re-attach attempts in a row that bring nothing new from the run's log. After
// that the page waits for focus, the network coming back, or the periodic check.
const RETRY_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
const REATTACH_INTERVAL_MS = 20000;
// A stream carries at least a `_ping` line every 15s. This much silence means
// the connection died without an error (a laptop asleep, a proxy or NAT that
// dropped it): the page cuts it and re-attaches. Focus and the network coming
// back use the shorter limit.
const STALL_MS = 45000;
const WAKE_STALL_MS = 30000;
const SESSION_ID_RE = /^[0-9a-f-]{8,}$/i;
const CURSOR = '<span class="cursor"></span>';
const UNREACHABLE = "Can't reach this computer right now. This page keeps trying.";
const SIGNED_OUT = "Your session on this computer has ended. Reopen this page from your Hivra dashboard to see your conversation; the agent keeps working in the meantime.";
const SIGNED_OUT_SEND = "Your session on this computer has ended, so the message was not sent. Reopen this page from your Hivra dashboard and send it again.";
const OFFLINE = "Lost the connection to the computer. The agent keeps working; the reply continues here when the computer is reachable again.";
const UNSENT = "Couldn't reach the computer. This page checks again when the connection is back and tells you if the message needs sending again.";
const ELSEWHERE = "This reply is showing live in another tab of this page.";
const ELSEWHERE_STATUS = "a reply is running in another tab";
const SESSION_LOST = "The agent couldn't reopen this conversation on the computer (it may have been cleaned up), so it did not get your message. Send it again to start a new conversation with the agent, or press New chat.";

// `warn` picks the stderr lines worth showing, as the dashboard's chat does.
const AGENTS = {
  claude: { name: "Claude Code", avatar: "C", runs: "Runs the official <code>claude</code> CLI on your own login", warn: /error|invalid|denied|expired|unauthor|not found|no conversation found/i },
  codex: { name: "Codex", avatar: "C", runs: "Runs the official <code>codex</code> CLI on your own login", warn: /error|invalid|denied|expired|unauthor|not found|no conversation found/i },
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
const gate = $("gate");
const gateText = $("gate-text");
const modelEl = $("model");
const noop = () => {};

// The run this page is following live, or null. At most one at a time.
let active = null;
let refreshing = false;
// A message is waiting on the check that no other tab is following a reply.
let sending = false;
// Run ids of unfinished replies another tab of this page is following, as far
// as this tab knows (see checkElsewhere).
let elsewhere = new Set();
// Run locks this tab holds, by run id, until the browser has let them go.
// `lockEpoch` changes whenever this tab takes or lets go of one.
const ownLocks = new Set();
let lockEpoch = 0;
let elsewhereChecks = 0;
// "open" once the computer accepted this page's session; "checking",
// "signed-out" or "unreachable" keep the saved conversation off the screen.
let access = "checking";
let saveTimer = null;
const views = new Map(); // turn -> { body, tools, note, offer, transient }
const dirty = new Map(); // turn -> { text, tools } waiting for the next frame
let frame = 0;
// How far this page got through the log of a run it stopped showing live
// (offline, signed out): { offset, parse }. Picking the run back up in this
// page continues from there instead of reading the whole log again. Dropped
// when another tab saves a newer copy of the turn, which this page's offset
// no longer matches.
const positions = new WeakMap();

// ---- the conversation, kept on this device ----------------------------------
//
// One conversation per device, its turns keyed by run id. Tabs merge their
// copies of a turn, keeping the one further along, and a New chat in any tab
// drops every turn created before it (`clearedAt`). The agent session the next
// message continues is the newest one a turn reported.

function emptyState(clearedAt) {
  return { clearedAt: clearedAt || 0, turns: [] };
}
function timeOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function sessionOf(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value) ? value : null;
}
function normalizeTurn(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  return {
    user: String(t.user || ""),
    assistant: String(t.assistant || ""),
    tools: Array.isArray(t.tools) ? t.tools.filter((x) => x && typeof x === "object").map((x) => ({ id: String(x.id || ""), name: String(x.name || "tool"), detail: String(x.detail || "") })) : [],
    warnings: Array.isArray(t.warnings) ? t.warnings.map(String) : [],
    runId: typeof t.runId === "string" && t.runId ? t.runId : null,
    done: t.done === true,
    outcome: typeof t.outcome === "string" ? t.outcome : null,
    // The agent session this run reported, and the one it was asked to continue.
    sessionId: sessionOf(t.sessionId),
    resumes: sessionOf(t.resumes),
    sessionLost: t.sessionLost === true,
    stopRequested: t.stopRequested === true,
    createdAt: timeOf(t.createdAt),
    updatedAt: timeOf(t.updatedAt),
  };
}
function byCreation(a, b) {
  return a.createdAt - b.createdAt;
}
function readStored() {
  let raw = null;
  try { raw = window.localStorage.getItem(STORE_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const turns = Array.isArray(parsed.turns) ? parsed.turns.map(normalizeTurn).filter((t) => t.user && t.runId) : [];
    return { clearedAt: timeOf(parsed.clearedAt), turns: turns.sort(byCreation) };
  } catch (e) {
    console.warn("hivra-chat: ignoring an unreadable saved conversation", e);
    return null;
  }
}
let state = readStored() || emptyState(0);

function currentSessionId() {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const turn = state.turns[i];
    if (turn.sessionId) return turn.sessionId;
    if (turn.sessionLost) return null;
  }
  return null;
}

// Copy `a` of a run's turn is further along than copy `b`.
function isNewer(a, b) {
  if (a.done !== b.done) return a.done;
  return a.updatedAt > b.updatedAt;
}
function driving(turn) {
  return Boolean(active && active.turn === turn);
}

// Fold in what other tabs of this page saved: turns they added, newer copies of
// turns this tab is not following itself, and a New chat pressed there.
function sync() {
  const stored = readStored();
  if (!stored) return;
  let reshaped = false;
  if (stored.clearedAt > state.clearedAt) state.clearedAt = stored.clearedAt;
  const mine = new Map(state.turns.map((turn) => [turn.runId, turn]));
  for (const theirs of stored.turns) {
    const turn = mine.get(theirs.runId);
    if (!turn) {
      if (theirs.createdAt >= state.clearedAt) {
        state.turns.push(theirs);
        reshaped = true;
      }
    } else if (!driving(turn) && isNewer(theirs, turn)) {
      Object.assign(turn, theirs);
      positions.delete(turn);
      schedulePaint(turn, "all");
    }
  }
  const kept = state.turns.filter((turn) => turn.createdAt >= state.clearedAt || driving(turn));
  if (kept.length !== state.turns.length) {
    state.turns = kept;
    reshaped = true;
  }
  if (reshaped) {
    state.turns.sort(byCreation);
    if (access === "open") renderAll();
  }
}

function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  sync(); // never write over turns another tab saved
  const turns = state.turns.slice(-MAX_TURNS);
  for (;;) {
    const json = JSON.stringify({ v: 1, clearedAt: state.clearedAt, turns });
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

// A run event changed the turn: repaint it on the next frame and save it soon.
function changed(turn, part) {
  turn.updatedAt = Date.now();
  schedulePaint(turn, part);
  saveSoon();
}

function adoptSession(run, id) {
  const session = sessionOf(id);
  if (!session || run.turn.sessionId === session) return;
  run.turn.sessionId = session;
  run.turn.updatedAt = Date.now();
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
  if (emptyEl) emptyEl.hidden = true;
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
  let offer = null;
  if (role === "assistant") {
    // Shown under a reply whose agent conversation is gone (see finishRun).
    offer = document.createElement("button");
    offer.type = "button";
    offer.className = "badge offer";
    offer.textContent = "Start a new chat";
    offer.hidden = true;
    offer.addEventListener("click", () => newChat());
    col.appendChild(offer);
  }
  msg.appendChild(av);
  msg.appendChild(col);
  log.appendChild(msg);
  return { body, tools, note, offer, transient: "" };
}

function toolChip(tool) {
  const chip = document.createElement("span");
  chip.className = "chip";
  const icon = tool.name === "Bash" ? "⚙" : (/browser|cdp|harness/i.test(tool.name) ? "🌐" : "🔧");
  chip.innerHTML = "<span>" + icon + "</span><b>" + escapeHtml(tool.name) + "</b>" +
    (tool.detail ? '<span class="t">' + escapeHtml(tool.detail) + "</span>" : "");
  return chip;
}

function renderTurn(turn, transient) {
  addMessage("user").body.textContent = turn.user;
  const view = addMessage("assistant");
  view.transient = transient || "";
  views.set(turn, view);
  paintTurn(turn);
}

// The whole conversation, again: once the page opens, and when another tab
// added turns or started a new chat.
function renderAll() {
  const transients = new Map(Array.from(views, ([turn, view]) => [turn, view.transient]));
  views.clear();
  dirty.clear();
  log.textContent = "";
  for (const turn of state.turns) renderTurn(turn, transients.get(turn));
  if (emptyEl) emptyEl.hidden = state.turns.length > 0;
}

function paintText(turn) {
  const view = views.get(turn);
  if (!view) return;
  // Transient lines (reconnecting, offline, another tab) are about a reply
  // that is still coming. Once it has ended, here or in another tab, they go.
  if (turn.done) view.transient = "";
  const live = driving(turn);
  let text = turn.assistant;
  for (const warning of turn.warnings) text += (text ? "\n\n" : "") + "⚠ " + warning;
  if (text) view.body.innerHTML = renderMarkdown(text) + (live ? CURSOR : "");
  else if (live) view.body.innerHTML = CURSOR;
  else if (turn.done && turn.outcome !== "stopped") view.body.innerHTML = "<span class='think'>(no text response)</span>";
  else view.body.innerHTML = "";
  const note = view.transient || (turn.outcome === "stopped" ? "Stopped." : "");
  view.note.textContent = note;
  view.note.style.display = note ? "" : "none";
  if (view.offer) view.offer.hidden = !(turn.sessionLost && !active && state.turns[state.turns.length - 1] === turn);
}

function paintTools(turn) {
  const view = views.get(turn);
  if (!view) return;
  view.tools.textContent = "";
  view.tools.style.display = turn.tools.length ? "flex" : "none";
  for (const tool of turn.tools) view.tools.appendChild(toolChip(tool));
}

function paintTurn(turn) {
  dirty.delete(turn);
  paintTools(turn);
  paintText(turn);
  scrollSoon();
}

// Stream events only mark the turn; it is painted, and the log scrolled, at
// most once a frame. A replayed run log can be thousands of lines that arrive
// at once, and repainting the whole reply for each of them froze the page.
const nextFrame = typeof window.requestAnimationFrame === "function"
  ? (fn) => window.requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);
function schedulePaint(turn, part) {
  const marks = dirty.get(turn) || { text: false, tools: false };
  if (part !== "tools") marks.text = true;
  if (part !== "text") marks.tools = true;
  dirty.set(turn, marks);
  scrollSoon();
}
function scrollSoon() {
  if (!frame) frame = nextFrame(flushPaints);
}
function flushPaints() {
  frame = 0;
  for (const [turn, marks] of dirty) {
    if (marks.tools) paintTools(turn);
    if (marks.text) paintText(turn);
  }
  dirty.clear();
  scrollDown();
}

// A transient line under a reply (reconnecting, another tab). Not persisted.
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

function syncControls() {
  const busy = Boolean(active);
  const open = access === "open";
  const waiting = replyElsewhere();
  sendBtn.disabled = busy || waiting || !open;
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  stopBtn.disabled = Boolean(active && active.stopping);
  if (newBtn) newBtn.disabled = busy || waiting || !open;
}

function setAccess(next, message) {
  const wasOpen = access === "open";
  access = next;
  const open = next === "open";
  if (gate) gate.hidden = open;
  if (gateText) gateText.textContent = open ? "" : message || "";
  log.hidden = !open;
  if (open && !wasOpen) renderAll();
  if (!open && wasOpen) {
    views.clear();
    dirty.clear();
    log.textContent = "";
  }
  if (!open && emptyEl) emptyEl.hidden = true;
  syncControls();
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
  return { seenText: false, sawSession: false, segments: new Map(), done: null, badLine: false };
}

function appendText(turn, text) {
  turn.assistant += text;
  changed(turn, "text");
}
function addWarning(turn, text) {
  const warning = String(text || "").trim();
  if (!warning || turn.warnings.includes(warning)) return;
  turn.warnings.push(warning);
  changed(turn, "text");
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
  changed(turn, "tools");
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
    changed(turn, "text");
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
      let raw = String(ev.text || "");
      if (agent === AGENTS.codex) raw = withoutCodexTracing(raw);
      const text = raw.trim();
      if (text && agent.warn.test(text)) addWarning(turn, text);
      return;
    }
    case "system":
      if (ev.subtype === "init") {
        run.parse.sawSession = true;
        adoptSession(run, ev.session_id);
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
    case "result": {
      adoptSession(run, ev.session_id);
      // API failures (an invalid model, an expired login) end the turn here.
      // A failed resume names what it could not find in `errors`.
      if (ev.is_error) {
        const errors = Array.isArray(ev.errors) ? ev.errors.map(String).filter(Boolean).join("\n") : "";
        addWarning(turn, typeof ev.result === "string" && ev.result ? ev.result : errors || "The request failed.");
      }
      return;
    }
    case "thread.started":
      run.parse.sawSession = true;
      adoptSession(run, ev.thread_id);
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
function newAbort() {
  return typeof AbortController === "function" ? new AbortController() : null;
}

// One tab at a time follows a run: it holds the run's Web Lock, which the
// browser releases when the tab goes away. Resolves to a release function, or
// null when another tab of this page holds the run. Without Web Locks every
// tab may follow it.
function lockName(runId) {
  return "hivra-chat:run:" + runId;
}
function claimRun(runId) {
  const locks = navigator.locks;
  if (!locks || typeof locks.request !== "function") return Promise.resolve(noop);
  return new Promise((resolve) => {
    let answered = false;
    let granted = false;
    const unavailable = (e) => {
      console.warn("hivra-chat: could not coordinate this reply with other tabs of this page", e);
      if (!answered) resolve(noop);
    };
    try {
      locks.request(lockName(runId), { ifAvailable: true }, (lock) => {
        answered = true;
        if (!lock) { resolve(null); return null; }
        granted = true;
        ownLocks.add(runId);
        lockEpoch += 1;
        return new Promise((release) => resolve(() => release()));
      }).catch(unavailable).then(() => {
        // The browser has let the lock go.
        if (!granted) return;
        ownLocks.delete(runId);
        lockEpoch += 1;
      });
    } catch (e) {
      unavailable(e);
    }
  });
}

// ---- replies other tabs are following ----------------------------------------
//
// The agent works on one message of a conversation at a time. While another tab
// is following a reply (it holds the run's lock), a message from this tab would
// start a second conversation with the agent (that reply has no session yet) or
// be refused as busy. So this tab holds its message, says why, and takes
// messages again once the reply finishes there, or picks the reply up itself if
// that tab goes away.

// This conversation's unfinished replies another tab holds the lock of. Empty
// when this browser has no Web Locks (every tab may follow a run then).
async function followedElsewhere() {
  const locks = navigator.locks;
  if (!locks || typeof locks.query !== "function") return new Set();
  let snapshot = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const epoch = lockEpoch;
    try {
      snapshot = await locks.query();
    } catch (e) {
      console.warn("hivra-chat: could not ask the other tabs of this page what they are showing", e);
      return new Set();
    }
    // Unless this tab took or let go of a lock meanwhile: then the answer may
    // still list one of its own, so ask again.
    if (epoch === lockEpoch) break;
  }
  const held = new Set((snapshot && Array.isArray(snapshot.held) ? snapshot.held : []).map((lock) => lock.name));
  return new Set(state.turns
    .filter((turn) => !turn.done && !driving(turn) && !ownLocks.has(turn.runId) && held.has(lockName(turn.runId)))
    .map((turn) => turn.runId));
}
// Ask again which replies other tabs are following, and show it. Resolves to
// what this check found.
async function checkElsewhere() {
  const check = ++elsewhereChecks;
  const found = await followedElsewhere();
  if (check === elsewhereChecks) {
    elsewhere = found;
    showElsewhere();
  }
  return found;
}
function replyElsewhere() {
  return !active && state.turns.some((turn) => !turn.done && elsewhere.has(turn.runId));
}
// A note under each reply another tab is following, and no sending until they
// finish.
function showElsewhere() {
  const unfinished = new Set(state.turns.filter((turn) => !turn.done && !driving(turn)).map((turn) => turn.runId));
  for (const runId of Array.from(elsewhere)) if (!unfinished.has(runId)) elsewhere.delete(runId);
  for (const turn of state.turns) {
    const view = views.get(turn);
    if (!view || !unfinished.has(turn.runId)) continue;
    if (elsewhere.has(turn.runId)) {
      if (view.transient !== ELSEWHERE) note(turn, ELSEWHERE);
    } else if (view.transient === ELSEWHERE) {
      note(turn, ""); // that tab went away: this one picks the reply up on its next check
    }
  }
  syncControls();
  if (access !== "open" || active) return;
  if (replyElsewhere()) setStatus(ELSEWHERE_STATUS);
  else if (statusEl.textContent === ELSEWHERE_STATUS) setStatus("ready");
}
// Another tab saved: ask about an unfinished reply this tab has not placed yet
// (that tab may be following it), and let go of any that finished there.
function afterOtherTabSaved() {
  if (!active && state.turns.some((turn) => !turn.done && !driving(turn) && !elsewhere.has(turn.runId))) void checkElsewhere();
  else showElsewhere();
}

function beginRun(turn, starting, release) {
  const view = views.get(turn);
  if (view) view.transient = "";
  elsewhere.delete(turn.runId);
  const position = positions.get(turn);
  positions.delete(turn);
  active = {
    turn, runId: turn.runId, parse: position ? position.parse : newParse(),
    // Bytes of the run's log applied to the reply, for `/events?offset=`.
    offset: position ? position.offset : 0,
    starting, stopping: turn.stopRequested, stopSent: false,
    release: release || noop,
    reader: null, abort: null, heardAt: Date.now(), stalled: false,
  };
  syncControls();
  setStatus(active.stopping ? "stopping…" : "thinking…");
  paintTurn(turn);
  return active;
}
// The page stops showing the run live. `turn.done` says whether it finished.
function endRun(run, status) {
  if (active === run) active = null;
  run.release();
  run.release = noop;
  if (!run.turn.done && run.offset > 0) positions.set(run.turn, { offset: run.offset, parse: run.parse });
  run.turn.updatedAt = Date.now();
  syncControls();
  setStatus(status);
  paintTurn(run.turn);
  saveNow();
}

function stopReading(run) {
  if (run.abort) {
    try { run.abort.abort(); } catch { /* already aborted */ }
  }
  if (run.reader) run.reader.cancel().catch(noop);
}
// Heartbeats keep an open stream talking; one that went quiet is cut and the
// run re-attached from what the page already has.
function cutIfStalled(run, limitMs) {
  const quiet = Date.now() - run.heardAt;
  if ((!run.reader && !run.abort) || quiet <= limitMs) return;
  console.warn("hivra-chat: nothing from the computer for " + Math.round(quiet / 1000) + "s; re-attaching to the run");
  run.stalled = true;
  stopReading(run);
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
  } else if (done.code !== 0) {
    // A non-zero exit, a signal (code null), or an agent that never started.
    turn.outcome = "error";
    const exited = typeof done.code === "number";
    if (exited && turn.resumes && !run.parse.sawSession && !turn.assistant && !turn.tools.length) {
      // Asked to continue a conversation, the agent failed before opening it
      // (Claude Code: "No conversation found", after its transcript cleanup).
      // Continuing it again would fail the same way, so the next message
      // starts a new conversation with the agent.
      turn.sessionLost = true;
      turn.sessionId = null; // its error result echoes the id it could not find
      addWarning(turn, SESSION_LOST);
      if (!input.value) { input.value = turn.user; autoGrow(); }
    } else if (!turn.assistant && !turn.warnings.length) {
      addWarning(turn, exited
        ? "The agent exited with an error (code " + done.code + ")."
        : "The agent ended before it finished" + (done.signal ? " (" + String(done.signal) + ")" : "") + ".");
    }
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
  if (turn.stopRequested && !turn.assistant && !turn.tools.length) {
    // Stopped before it ever reached the computer.
    turn.outcome = "stopped";
  } else if (!turn.assistant && !turn.tools.length) {
    turn.outcome = "error";
    addWarning(turn, "This message didn't reach the computer. Send it again.");
    if (!input.value) { input.value = turn.user; autoGrow(); }
  } else {
    turn.outcome = "error";
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

async function startFailure(resp, preread) {
  if (resp.status === 401) return SIGNED_OUT_SEND;
  let detail = "";
  try {
    const raw = (preread != null ? preread : await resp.text()).trim();
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

function joinBytes(parts) {
  if (parts.length === 1) return parts[0];
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// One line from the computer. Everything but the `_run` preface and `_ping`
// heartbeats (added to each response) is the run's own log and counts toward
// the offset a re-attach continues from.
function takeLine(run, decoder, bytes, terminated) {
  const text = decoder.decode(bytes);
  let parsed = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!run.parse.badLine) {
        run.parse.badLine = true;
        console.warn("hivra-chat: skipped a line from the computer that is not JSON", text.slice(0, 120));
      }
    }
  }
  const ev = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  if (!ev || (ev.type !== "_run" && ev.type !== "_ping")) run.offset += bytes.length + (terminated ? 1 : 0);
  if (ev) applyEvent(run, ev);
}

// Read one NDJSON stream into the run's reply. "done" once the run's `_done`
// line arrived; "ended" when the stream stopped first (network drop, proxy
// timeout, a restarted chat service, or cut by this page as silent) while the
// run keeps working. Lines are split as bytes so `run.offset` stays exact.
async function readStream(run, body) {
  if (!body) return "ended";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  run.reader = reader;
  run.heardAt = Date.now();
  let parts = [];
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (active !== run) {
        reader.cancel().catch(noop);
        return "superseded";
      }
      if (run.stalled) break;
      if (done) { complete = true; break; }
      run.heardAt = Date.now();
      let start = 0;
      for (let end = value.indexOf(10); end >= 0; end = value.indexOf(10, start)) {
        parts.push(value.subarray(start, end));
        takeLine(run, decoder, joinBytes(parts), true);
        parts = [];
        start = end + 1;
      }
      if (start < value.length) parts.push(value.slice(start));
    }
    // A finished run's stream ends on a whole line. A cut stream's partial line
    // is not applied: the re-attach reads it again from the log.
    if (complete && parts.length) takeLine(run, decoder, joinBytes(parts), false);
  } catch (e) {
    if (active !== run) return "superseded";
    if (!run.stalled) console.warn("hivra-chat: the reply stream dropped; re-attaching to the run", e);
  } finally {
    if (run.reader === reader) {
      run.reader = null;
      run.abort = null;
    }
  }
  run.stalled = false;
  saveSoon();
  return run.parse.done ? "done" : "ended";
}

// Rebuilding from the start of the run's log: the replay replaces the reply.
function restartReply(run) {
  run.parse = newParse();
  run.turn.assistant = "";
  run.turn.tools = [];
  run.turn.warnings = [];
  schedulePaint(run.turn, "all");
}

// Follow a run live until it finishes. A page that has part of the run's log
// continues from there; a new one (after a reload) rebuilds the reply from the
// start of the log.
async function follow(run) {
  let misses = 0;
  while (misses < RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[misses];
    if (delay) {
      note(run.turn, "Reconnecting to the computer…");
      await sleep(delay);
    }
    if (active !== run) return;
    const from = run.offset;
    let resp;
    try {
      run.stalled = false;
      run.abort = newAbort();
      run.heardAt = Date.now();
      resp = await fetch(runUrl(run.runId, "/events") + (from ? "?offset=" + from : ""), {
        credentials: "same-origin", cache: "no-store", signal: run.abort ? run.abort.signal : undefined,
      });
    } catch (e) {
      if (active !== run) return;
      console.warn("hivra-chat: re-attaching to the run failed", e);
      misses += 1;
      continue;
    }
    if (active !== run) return;
    if (resp.status === 401) return signedOut();
    if (resp.status === 404) return missingRun(run);
    if (!resp.ok) {
      console.warn("hivra-chat: the run's log could not be read (HTTP " + resp.status + ")");
      misses += 1;
      continue;
    }
    note(run.turn, "");
    if (!from) restartReply(run);
    if (run.turn.stopRequested && !run.stopSent) void sendStop(run);
    const result = await readStream(run, resp.body);
    if (result === "done") return finishRun(run);
    if (result === "superseded") return;
    // A stream that brought more of the log was a working connection: the
    // retries start over.
    misses = run.offset > from ? 0 : misses + 1;
  }
  suspendRun(run, OFFLINE, "offline");
}

// Codex logs its own diagnostics to stderr through tracing (a time, a level
// padded to five, any spans, then the Rust module path), for example a skill it
// could not load. They are not part of the reply; a problem the owner must act
// on (sign-in, a usage limit, a model) arrives as an error event instead. The
// dashboard's chat filters the same lines (src/lib/hivra/agent-adapters.ts).
const CODEX_TRACING_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s/;
const CODEX_UNTIMED_TRACING_LINE = /^(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+(?:[^\s:{}]+(?:\{[^}]*\})?:)*\s*[A-Za-z_]\w*(?:::\w+)+:(?:\s|$)/;
function withoutCodexTracing(text) {
  const kept = [];
  let inEvent = false;
  for (const line of text.split(/\r?\n/)) {
    const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    if (CODEX_TRACING_LINE.test(plain) || CODEX_UNTIMED_TRACING_LINE.test(plain)) { inEvent = true; continue; }
    // A tracing event's message can run on over indented or blank lines.
    if (inEvent && (!plain.trim() || /^\s/.test(plain))) continue;
    inEvent = false;
    kept.push(line);
  }
  return kept.join("\n");
}

async function send(raw) {
  if (active || sending || access !== "open") return;
  const text = String(raw != null ? raw : input.value).trim();
  if (!text) return;
  // Not while another tab is following a reply (see followedElsewhere). Read
  // the saved conversation first: that tab's newest turn may not have arrived
  // here as a storage event yet. The message stays in the composer.
  sending = true;
  let found;
  try {
    sync();
    found = await checkElsewhere();
  } finally {
    sending = false;
  }
  if (found.size) {
    if (access === "open" && !active) setStatus(ELSEWHERE_STATUS);
    return;
  }
  if (active || access !== "open") return;
  input.value = "";
  autoGrow();
  const now = Date.now();
  const turn = normalizeTurn({ user: text, runId: newRunId(), resumes: currentSessionId(), createdAt: now, updatedAt: now });
  const previous = state.turns[state.turns.length - 1];
  state.turns.push(turn);
  if (previous) schedulePaint(previous, "text"); // its "Start a new chat" offer goes
  renderTurn(turn);
  const run = beginRun(turn, true, noop);
  // Hold the run's lock before other tabs hear of the turn, so they see that
  // this tab is following it and hold their own messages.
  const release = await claimRun(turn.runId); // a new run id: no other tab has it
  if (active !== run) {
    if (release) release();
    return;
  }
  run.release = release || noop;
  saveNow(); // a reload from here on finds the turn and its run
  const body = JSON.stringify({ message: text, sessionId: turn.resumes, detach: true, runId: turn.runId });
  let resp = null;
  for (let attempt = 0; attempt < START_DELAYS_MS.length && !resp; attempt++) {
    if (START_DELAYS_MS[attempt]) await sleep(START_DELAYS_MS[attempt]);
    if (active !== run) return;
    try {
      run.stalled = false;
      run.abort = newAbort();
      run.heardAt = Date.now();
      resp = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
        signal: run.abort ? run.abort.signal : undefined,
      });
    } catch (e) {
      console.warn("hivra-chat: sending the message failed (attempt " + (attempt + 1) + ")", e);
    }
  }
  // A body read here is handed to startFailure, since it can be read only once.
  let preread = null;
  for (let wait = 0; resp && resp.status === 503 && wait < UPDATING_DELAYS_MS.length && active === run; wait++) {
    let raw = "";
    try { raw = await resp.text(); } catch { /* no body */ }
    let detail = null;
    try { detail = JSON.parse(raw); } catch { /* not JSON */ }
    if (!detail || detail.code !== "agent_updating") { preread = raw; break; }
    setStatus("Your computer is updating " + agent.name + " to a new version. Your message will send in a moment.");
    await sleep(UPDATING_DELAYS_MS[wait]);
    if (active !== run) return;
    try {
      run.abort = newAbort();
      run.heardAt = Date.now();
      resp = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
        signal: run.abort ? run.abort.signal : undefined,
      });
    } catch (e) {
      console.warn("hivra-chat: sending the message after the agent update failed", e);
      resp = null;
    }
    if (resp && resp.status !== 503) setStatus("thinking…");
  }
  if (active !== run) return;
  // No answer at all: the message may or may not have reached the computer.
  // Keep the turn open; picking it up later finds the run or asks to send again.
  if (!resp) return suspendRun(run, UNSENT, "offline");
  if (!resp.ok) {
    const reason = await startFailure(resp, preread);
    if (resp.status === 401) {
      failStart(run, reason, text, "signed out");
      return signedOut();
    }
    failStart(run, reason, text, "ready");
    // "Still working on the previous message": pick that reply back up.
    if (resp.status === 409) void refresh();
    return;
  }
  run.starting = false;
  if (turn.stopRequested && !run.stopSent) void sendStop(run);
  const result = await readStream(run, resp.body);
  if (result === "done") return finishRun(run);
  if (result === "ended") return follow(run);
}

// Ask the computer to end the run. The run's stream then ends with its
// `_done` line (stopped: "user"), which finishes the reply here.
async function requestStop(run) {
  const beforeStart = run.starting;
  let resp;
  try {
    resp = await fetch(runUrl(run.runId, "/stop"), { method: "POST", credentials: "same-origin" });
  } catch (e) {
    console.warn("hivra-chat: stopping the run failed", e);
    note(run.turn, "Couldn't reach the computer to stop the reply. Try again.");
    return false;
  }
  if (resp.ok) {
    run.stopSent = true;
    return true;
  }
  // Stop pressed before the start reached the computer. The turn keeps the
  // request, and it is sent once the run is found (this start, or a later pick-up).
  if (resp.status === 404 && beforeStart) return true;
  if (resp.status === 401) {
    signedOut();
    return false;
  }
  console.warn("hivra-chat: the computer did not stop the run (HTTP " + resp.status + ")");
  note(run.turn, "The computer couldn't stop the reply (HTTP " + resp.status + "). Try again.");
  return false;
}
async function sendStop(run) {
  if (!(await requestStop(run))) stopFailed(run);
}

async function stopActive() {
  const run = active;
  if (!run || run.stopping) return;
  run.stopping = true;
  run.turn.stopRequested = true;
  run.turn.updatedAt = Date.now();
  saveNow(); // a reload, or a start that never got an answer, still stops it
  syncControls();
  setStatus("stopping…");
  await sendStop(run);
}
// The run is still going: offer Stop again.
function stopFailed(run) {
  if (active !== run) return;
  run.stopping = false;
  syncControls();
  setStatus("thinking…");
}

// The computer no longer accepts this page's session: it expired, or the chat
// service restarted and forgot it. The conversation leaves the screen until the
// session is back (the page reopened from the dashboard, in any tab); the agent
// keeps working in the meantime.
function signedOut() {
  if (active) {
    const run = active;
    stopReading(run);
    suspendRun(run, "", "signed out");
  }
  setAccess("signed-out", SIGNED_OUT);
  setStatus("signed out");
}

// Check in with the computer: on load, focus, the network coming back and every
// 20s. The first answer opens the page. Then a reply this page did not see
// finish (still running, or finished while the page was closed) is picked back
// up from its run log, oldest first, unless another tab is already showing it.
async function refresh() {
  if (active || refreshing) return;
  const pending = () => state.turns.filter((turn) => !turn.done && turn.runId);
  if (access === "open" && !pending().length) return;
  refreshing = true;
  let run = null;
  try {
    // A tab that was following a reply may have gone away since: take
    // messages again while this check waits on the computer.
    if (access === "open" && elsewhere.size) await checkElsewhere();
    let resp;
    try {
      resp = await fetch("/api/chat/runs", { credentials: "same-origin", cache: "no-store" });
    } catch (e) {
      console.warn("hivra-chat: could not reach the computer", e);
      if (access !== "open") {
        setAccess("unreachable", UNREACHABLE);
        setStatus("offline");
      } else if (!active && pending().length) {
        for (const turn of pending()) note(turn, OFFLINE);
        setStatus("offline");
      }
      return;
    }
    if (resp.status === 401) return signedOut();
    if (!resp.ok) {
      console.warn("hivra-chat: the computer's runs could not be listed (HTTP " + resp.status + ")");
      if (access !== "open") {
        setAccess("unreachable", UNREACHABLE);
        setStatus("offline");
      } else if (!active) {
        const message = "The computer couldn't report on this reply (HTTP " + resp.status + "). This page tries again shortly.";
        for (const turn of pending()) note(turn, message);
      }
      return;
    }
    if (access !== "open") {
      setAccess("open");
      for (const turn of pending()) note(turn, "Picking the reply back up from the computer…");
      if (!active) setStatus(pending().length ? "reconnecting…" : "ready");
    }
    // Re-read after every wait: New chat, a send or another tab may have
    // changed the conversation meanwhile.
    if (active) return;
    for (const turn of pending()) {
      const release = await claimRun(turn.runId);
      if (active || turn.done || !state.turns.includes(turn) || access !== "open") {
        if (release) release();
        return;
      }
      if (!release) {
        elsewhere.add(turn.runId);
        showElsewhere();
        continue;
      }
      run = beginRun(turn, false, release);
      break;
    }
  } finally {
    refreshing = false;
  }
  if (run) await follow(run);
}

async function newChat() {
  if (active || access !== "open") return;
  // A new chat would drop a reply another tab is still following.
  sync();
  if ((await checkElsewhere()).size) {
    if (access === "open" && !active) setStatus(ELSEWHERE_STATUS);
    return;
  }
  if (active || access !== "open") return;
  state = emptyState(Date.now());
  renderAll();
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

// Focus, the network coming back and the periodic check: open the page once
// the computer answers, pick up unfinished replies, and cut a silent stream.
// A hidden tab still cuts a silent stream: it holds the run's lock, so other
// tabs of this page leave the reply to it.
function wake(limitMs) {
  if (active) cutIfStalled(active, limitMs);
  else if (document.visibilityState !== "hidden") void refresh();
}
const onWake = () => wake(WAKE_STALL_MS);
window.addEventListener("focus", onWake);
window.addEventListener("online", onWake);
// Back from the back-forward cache: other tabs may have saved meanwhile.
window.addEventListener("pageshow", () => { sync(); afterOtherTabSaved(); onWake(); });
document.addEventListener("visibilitychange", onWake);
setInterval(() => wake(STALL_MS), REATTACH_INTERVAL_MS);
window.addEventListener("pagehide", saveNow);
// Another tab of this page saved the conversation.
window.addEventListener("storage", (event) => {
  if (event.key !== STORE_KEY) return;
  sync();
  afterOtherTabSaved();
});

syncControls();
void loadMeta();
void refresh();
