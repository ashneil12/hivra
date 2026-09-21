// Hivra chat client — streams the official `claude` CLI (stream-json) over a POST/NDJSON response.
let sessionId = null;
let busy = false;

const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const sendBtn = $("send");
const statusEl = $("status");
const emptyEl = $("empty");

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
  av.textContent = role === "user" ? "you" : "C";
  const col = document.createElement("div");
  col.style.flex = "1";
  col.style.minWidth = "0";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "You" : "Claude Code";
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.style.display = "none";
  const body = document.createElement("div");
  body.className = "body";
  col.appendChild(who);
  col.appendChild(tools);
  col.appendChild(body);
  msg.appendChild(av);
  msg.appendChild(col);
  log.appendChild(msg);
  scrollDown();
  return { body, tools };
}

function addTool(toolsEl, name, detail) {
  toolsEl.style.display = "flex";
  const chip = document.createElement("span");
  chip.className = "chip";
  const icon = name === "Bash" ? "⚙" : (/browser|cdp|harness/i.test(name) ? "🌐" : "🔧");
  chip.innerHTML = "<span>" + icon + "</span><b>" + escapeHtml(name) + "</b>" +
    (detail ? '<span class="t">' + escapeHtml(detail) + "</span>" : "");
  toolsEl.appendChild(chip);
  scrollDown();
}

function scrollDown() {
  const main = $("main");
  main.scrollTop = main.scrollHeight;
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  statusEl.textContent = b ? "thinking…" : "ready";
}

async function send(text) {
  if (busy) return;
  text = (text != null ? text : input.value).trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  addMessage("user").body.textContent = text;
  const a = addMessage("assistant");
  let acc = "";
  let cursor = '<span class="cursor"></span>';
  a.body.innerHTML = cursor;
  setBusy(true);

  let resp;
  try {
    resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId }),
    });
  } catch (e) {
    a.body.textContent = "⚠ could not reach the box: " + e.message;
    setBusy(false);
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        handle(ev, a, (t) => { acc += t; a.body.innerHTML = renderMarkdown(acc) + cursor; scrollDown(); });
      }
    }
  };
  try { await pump(); } catch (e) { /* stream ended */ }
  a.body.innerHTML = renderMarkdown(acc) || "<span class='think'>(no text response)</span>";
  setBusy(false);
}

function handle(ev, a, appendText) {
  if (ev.type === "system" && ev.subtype === "init") {
    sessionId = ev.session_id || sessionId;
    if (ev.model) $("model").textContent = String(ev.model).replace(/\[.*\]/, "").replace("claude-", "");
  } else if (ev.type === "stream_event" && ev.event) {
    const e = ev.event;
    if (e.type === "content_block_start" && e.content_block) {
      if (e.content_block.type === "tool_use") {
        const inp = e.content_block.input || {};
        const detail = inp.command || inp.url || inp.file_path || inp.pattern || "";
        addTool(a.tools, e.content_block.name || "tool", String(detail).slice(0, 140));
      }
    } else if (e.type === "content_block_delta" && e.delta) {
      if (e.delta.type === "text_delta" && e.delta.text) appendText(e.delta.text);
    }
  } else if (ev.type === "result") {
    sessionId = ev.session_id || sessionId;
  } else if (ev.type === "_stderr" && ev.text && /error|invalid|denied|expired/i.test(ev.text)) {
    appendText("\n⚠ " + ev.text.trim() + "\n");
  }
}

// composer behavior
function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", () => send());
document.querySelectorAll(".ex").forEach((el) =>
  el.addEventListener("click", () => send(el.textContent))
);
