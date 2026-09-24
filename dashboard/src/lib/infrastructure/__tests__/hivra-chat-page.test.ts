/** @jest-environment jsdom */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import { clearTimeout, setImmediate, setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";

// Behaviour of the computer's own chat page (provisioner/hivra-chat/index.html
// + app.js, served at GET / by server.js). The unmodified page and script run
// in a same-origin jsdom frame against a fake gateway that speaks the detached
// chat run API: POST /api/chat, GET /api/chat/runs, GET /api/chat/runs/<id>/events
// and POST /api/chat/runs/<id>/stop. A reload is a fresh frame on the same
// origin, so it keeps the origin's localStorage exactly as a browser does. The
// last block drives the same page over HTTP against the real gateway
// (server.js), its detached runner (chat-runs.cjs) and a fake agent CLI.

const DIR = path.join(process.cwd(), "provisioner/hivra-chat");
const SCRIPT_TAG = '<script src="/app.js"></script>';
const HTML_SOURCE = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const APP = fs.readFileSync(path.join(DIR, "app.js"), "utf8");
const ORIGIN = "https://computer.example.test";
const STORE_KEY = "hivra-chat:conversation:v1";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const RUN_1 = "00000000-0000-4000-8000-000000000002";
const RUN_2 = "00000000-0000-4000-8000-000000000003";

type Event = Record<string, unknown>;
type Call = { method: string; path: string; body: unknown; credentials: string | undefined };
type FakeResponse = { ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; text(): Promise<string>; json(): Promise<unknown> };
type Handler = (call: Call) => FakeResponse;

const encoder = new TextEncoder();

// Just the Response surface the page uses. A JSON answer also has a readable
// body, as a real fetch Response does.
function reply(status: number, body: ReadableStream<Uint8Array> | string): FakeResponse {
  const text = typeof body === "string" ? body : "";
  const stream = typeof body === "string"
    ? new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(encoder.encode(text)); controller.close(); } })
    : body;
  return {
    ok: status >= 200 && status < 300, status, body: stream,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}
function json(status: number, value: unknown) {
  return reply(status, JSON.stringify(value));
}

// One NDJSON response body the test writes to as the "computer" produces lines.
class LiveStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly body = new ReadableStream<Uint8Array>({ start: (controller) => { this.controller = controller; } });
  push(...events: Event[]) {
    for (const event of events) this.controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
  }
  end() { this.controller.close(); }
  drop() { this.controller.error(new TypeError("network connection lost")); }
  response() { return reply(200, this.body); }
}

// What the page's `fetch` talks to. `detach` runs when the page goes away.
type Transport = { fetch: (input: unknown, init?: { method?: string; body?: string; credentials?: string }) => Promise<FakeResponse>; detach?: () => void };

class FakeComputer implements Transport {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Handler>();
  constructor(meta: Event = { agentKind: "claude", model: null }) {
    this.on("GET", "/api/meta", () => json(200, meta));
    this.on("GET", "/api/chat/runs", () => json(200, { runs: [] }));
  }
  on(method: string, pathname: string, handler: Handler) {
    this.routes.set(method + " " + pathname, handler);
    return this;
  }
  fetch = async (input: unknown, init: { method?: string; body?: string; credentials?: string } = {}) => {
    const url = new URL(String(input), ORIGIN + "/");
    if (url.origin !== ORIGIN || !String(input).startsWith("/")) throw new Error("the page fetched another origin: " + String(input));
    const call: Call = {
      method: (init.method || "GET").toUpperCase(), path: url.pathname,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, credentials: init.credentials,
    };
    this.calls.push(call);
    const handler = this.routes.get(call.method + " " + call.path);
    return handler ? handler(call) : json(404, { error: "run not found" });
  };
  callsTo(method: string, pathname: string) {
    return this.calls.filter((call) => call.method === method && call.path === pathname);
  }
}

function waitFor<T>(probe: () => T | undefined | null | false, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value: T | undefined | null | false;
      try { value = probe(); } catch { value = undefined; }
      if (value) return resolve(value as T);
      if (Date.now() > deadline) return reject(new Error("Timed out waiting for " + label));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const pages: Array<{ close(): void }> = [];
afterEach(() => {
  while (pages.length) pages.pop()!.close();
  window.localStorage.clear();
});

type PageWindow = Window & typeof globalThis & { eval(source: string): unknown };

// Load the page into a new same-origin frame: the frame shares this origin's
// localStorage, so a second frame is what the same page is after a reload.
function openPage(computer: Transport, runIds: string[] = []) {
  expect(HTML_SOURCE).toContain(SCRIPT_TAG);
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const w = frame.contentWindow as PageWindow;
  const doc = w.document;
  doc.open();
  doc.write(HTML_SOURCE.replace(SCRIPT_TAG, ""));
  doc.close();
  const errors: string[] = [];
  const warnings: string[] = [];
  w.addEventListener("error", (event) => errors.push(String((event as ErrorEvent).error?.stack || (event as ErrorEvent).message)));
  const ids = [...runIds];
  let closed = false;
  Object.defineProperty(w.crypto, "randomUUID", { configurable: true, value: () => ids.shift() || "00000000-0000-4000-8000-0000000000ff" });
  Object.assign(w, {
    // A page that went away never hears back from its requests.
    fetch: (input: unknown, init?: { method?: string; body?: string; credentials?: string }) => (closed ? new Promise(() => undefined) : computer.fetch(input, init)),
    TextDecoder,
    console: { ...console, warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")), error: (...args: unknown[]) => errors.push(args.map(String).join(" ")) },
  });
  w.eval(APP);
  const close = () => {
    if (closed) return;
    closed = true;
    computer.detach?.();
    w.close();
    frame.remove();
  };
  pages.push({ close });
  const el = <T extends Element>(selector: string) => doc.querySelector(selector) as T;
  const page = {
    w, doc, errors, warnings,
    input: () => el<HTMLTextAreaElement>("#input"),
    sendButton: () => el<HTMLButtonElement>("#send"),
    stopButton: () => el<HTMLButtonElement>("#stop"),
    status: () => el<HTMLElement>("#status").textContent,
    send(text: string) {
      page.input().value = text;
      page.sendButton().click();
    },
    userMessages: () => Array.from(doc.querySelectorAll(".msg.user .body"), (node) => node.textContent),
    replies: () => Array.from(doc.querySelectorAll(".msg.assistant .body"), (node) => node.textContent),
    notes: () => Array.from(doc.querySelectorAll(".msg.assistant .note"), (node) => node.textContent),
    chips: () => Array.from(doc.querySelectorAll(".msg.assistant .chip"), (node) => node.textContent),
    stored: () => JSON.parse(w.localStorage.getItem(STORE_KEY) || "null"),
    // A reload: the page hides, goes away, and loads again on the same origin.
    reload(nextComputer: Transport, nextRunIds: string[] = []) {
      w.dispatchEvent(new w.Event("pagehide"));
      close();
      return openPage(nextComputer, nextRunIds);
    },
  };
  return page;
}

function claudeTurn(text: string): Event[] {
  return [
    { type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-opus-4-8[1m]" },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool_1", name: "Bash", input: {} } } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } }] } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
    { type: "assistant", message: { content: [{ type: "text", text }] } },
    { type: "result", subtype: "success", session_id: SESSION_ID, is_error: false },
  ];
}

describe("the computer's own chat page", () => {
  it("starts detached runs with a fresh run id and keeps the conversation on the device", async () => {
    const first = new LiveStream();
    const second = new LiveStream();
    const streams = [first, second];
    const computer = new FakeComputer().on("POST", "/api/chat", () => streams.shift()!.response());
    const page = openPage(computer, [RUN_1, RUN_2]);

    page.send("List the files");
    const [start] = await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1 && computer.callsTo("POST", "/api/chat"), "the first start");
    expect(start.body).toEqual({ message: "List the files", sessionId: null, detach: true, runId: RUN_1 });
    expect(start.credentials).toBe("same-origin");
    expect(page.stopButton().hidden).toBe(false);
    expect(page.sendButton().hidden).toBe(true);
    expect(page.status()).toBe("thinking…");
    // Saved before the start even answers: a reload now still finds the run.
    expect(page.stored().turns).toEqual([expect.objectContaining({ user: "List the files", runId: RUN_1, done: false })]);

    first.push({ type: "_run", runId: RUN_1, detached: true }, ...claudeTurn("Here are the files."), { type: "_ping" }, { type: "_done", code: 0 });
    first.end();
    await waitFor(() => page.status() === "ready", "the first reply to finish");
    expect(page.replies()).toEqual(["Here are the files."]);
    expect(page.chips()).toEqual(["⚙Bashls"]);
    expect(page.stopButton().hidden).toBe(true);
    expect(page.doc.querySelector("#model")!.textContent).toBe("opus-4-8");
    expect(page.stored()).toEqual({
      v: 1, sessionId: SESSION_ID,
      turns: [{ user: "List the files", assistant: "Here are the files.", tools: [{ id: "tool_1", name: "Bash", detail: "ls" }], warnings: [], runId: RUN_1, done: true, outcome: "complete" }],
    });

    page.send("And the hidden ones?");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the second start");
    expect(computer.callsTo("POST", "/api/chat")[1].body).toEqual({ message: "And the hidden ones?", sessionId: SESSION_ID, detach: true, runId: RUN_2 });
    second.push({ type: "_run", runId: RUN_2, detached: true }, { type: "_done", code: 0 });
    second.end();
    await waitFor(() => page.status() === "ready", "the second reply to finish");
    expect(page.errors).toEqual([]);
  });

  it.each(["running", "finished"])("rebuilds a reply it did not see finish after a reload (%s on the computer)", async (state) => {
    const live = new LiveStream();
    const before = new FakeComputer().on("POST", "/api/chat", () => live.response());
    const first = openPage(before, [RUN_1]);
    first.send("Research the market");
    await waitFor(() => before.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true });
    live.push({ type: "system", subtype: "init", session_id: SESSION_ID });
    live.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on it." } } });
    await waitFor(() => first.replies()[0] === "Working on it.", "the partial reply");

    const replay = new LiveStream();
    const after = new FakeComputer()
      .on("GET", "/api/chat/runs", () => json(200, { runs: [{ runId: RUN_1, state, agentSessionId: SESSION_ID, clientRef: null }] }))
      .on("GET", `/api/chat/runs/${RUN_1}/events`, () => replay.response());
    const second = first.reload(after);
    // The conversation is back before the computer answers.
    expect(second.userMessages()).toEqual(["Research the market"]);
    expect(second.replies()).toEqual(["Working on it."]);
    expect(second.status()).toBe("reconnecting…");
    await waitFor(() => after.callsTo("GET", `/api/chat/runs/${RUN_1}/events`).length === 1, "the page to follow the run");
    expect(after.callsTo("GET", "/api/chat/runs")[0].credentials).toBe("same-origin");
    expect(second.stopButton().hidden).toBe(false);

    // The run's log replays from the start, then continues live.
    replay.push(
      { type: "system", subtype: "init", session_id: SESSION_ID },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on it." } } },
      { type: "_ping" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " Done: three findings." } } },
      { type: "result", subtype: "success", session_id: SESSION_ID, is_error: false },
      { type: "_done", code: 0 },
    );
    replay.end();
    await waitFor(() => second.status() === "ready", "the rebuilt reply to finish");
    expect(second.replies()).toEqual(["Working on it. Done: three findings."]);
    expect(after.callsTo("POST", "/api/chat")).toEqual([]);
    expect(second.stored()).toMatchObject({ sessionId: SESSION_ID, turns: [{ runId: RUN_1, assistant: "Working on it. Done: three findings.", done: true, outcome: "complete" }] });

    // A finished reply is not fetched again on the next load.
    const idle = new FakeComputer();
    const third = second.reload(idle);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(third.replies()).toEqual(["Working on it. Done: three findings."]);
    expect(idle.calls.map((call) => call.path)).toEqual(["/api/meta"]);
    expect([...first.errors, ...second.errors, ...third.errors]).toEqual([]);
  });

  it("re-attaches to the run's log after the stream drops, without doubling the reply or resending", async () => {
    const live = new LiveStream();
    const replay = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => live.response())
      .on("GET", `/api/chat/runs/${RUN_1}/events`, () => replay.response());
    const page = openPage(computer, [RUN_1]);
    page.send("Write the report");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true }, { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Part one." } } });
    await waitFor(() => page.replies()[0] === "Part one.", "the first part");
    live.drop();

    await waitFor(() => computer.callsTo("GET", `/api/chat/runs/${RUN_1}/events`).length === 1, "the re-attach");
    replay.push(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Part one." } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " Part two." } } },
      { type: "_done", code: 0 },
    );
    replay.end();
    await waitFor(() => page.status() === "ready", "the reply to finish");
    expect(page.replies()).toEqual(["Part one. Part two."]);
    expect(computer.callsTo("POST", "/api/chat")).toHaveLength(1);
    expect(page.warnings.some((line) => line.includes("the reply stream dropped"))).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it("repeats a start whose connection failed with the same run id, so the message runs once", async () => {
    const live = new LiveStream();
    let attempts = 0;
    const computer = new FakeComputer().on("POST", "/api/chat", () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return live.response();
    });
    const page = openPage(computer, [RUN_1, RUN_2]);
    page.send("Book the table");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the repeated start");
    const [first, second] = computer.callsTo("POST", "/api/chat");
    expect(second.body).toEqual(first.body);
    expect(second.body).toMatchObject({ runId: RUN_1, detach: true });
    live.push({ type: "_run", runId: RUN_1, detached: true }, { type: "_text", text: "Booked." }, { type: "_done", code: 0 });
    live.end();
    await waitFor(() => page.status() === "ready", "the reply");
    expect(page.replies()).toEqual(["Booked."]);
    expect(page.errors).toEqual([]);
  });

  it("keeps a start with no answer open, then asks to send again once the computer says it never arrived", async () => {
    const computer = new FakeComputer().on("POST", "/api/chat", () => { throw new TypeError("Failed to fetch"); });
    const page = openPage(computer, [RUN_1]);
    page.send("Order the parts");
    await waitFor(() => page.status() === "offline", "the start to give up", 10_000);
    expect(computer.callsTo("POST", "/api/chat")).toHaveLength(3);
    expect(page.notes()[0]).toContain("Couldn't reach the computer");
    // Unknown outcome: the run may exist, so the turn stays open and the
    // message is not offered for sending again yet.
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: false });
    expect(page.input().value).toBe("");

    page.w.dispatchEvent(new page.w.Event("online"));
    await waitFor(() => page.status() === "ready", "the resume check");
    expect(computer.callsTo("GET", `/api/chat/runs/${RUN_1}/events`)).toHaveLength(1);
    expect(page.replies()[0]).toBe("⚠ This message didn't reach the computer. Send it again.");
    expect(page.input().value).toBe("Order the parts");
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "error" });
    expect(page.errors).toEqual([]);
  }, 20_000);

  it("Stop asks the computer to end the run, and the reply closes as stopped", async () => {
    const live = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => live.response())
      .on("POST", `/api/chat/runs/${RUN_1}/stop`, () => json(200, { ok: true, run: { runId: RUN_1, state: "running" } }));
    const page = openPage(computer, [RUN_1]);
    page.send("Crawl every page");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true }, { type: "_text", text: "Crawling…" });
    await waitFor(() => page.replies()[0] === "Crawling…", "the reply to stream");

    page.stopButton().click();
    const [stop] = await waitFor(() => computer.callsTo("POST", `/api/chat/runs/${RUN_1}/stop`).length === 1 && computer.callsTo("POST", `/api/chat/runs/${RUN_1}/stop`), "the stop request");
    expect(stop.credentials).toBe("same-origin");
    expect(page.status()).toBe("stopping…");
    // Stopping is the computer's job: the run ends through its own stream.
    live.push({ type: "_done", code: 143, signal: null, stopped: "user" });
    live.end();
    await waitFor(() => page.status() === "ready", "the stopped reply");
    expect(page.replies()).toEqual(["Crawling…"]);
    expect(page.notes()).toEqual(["Stopped."]);
    expect(page.stopButton().hidden).toBe(true);
    expect(page.sendButton().hidden).toBe(false);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "stopped" });
    expect(page.errors).toEqual([]);
  });

  it("renders Codex runs: agent messages, commands and the thread id to resume", async () => {
    const live = new LiveStream();
    const next = new LiveStream();
    const streams = [live, next];
    const computer = new FakeComputer({ agentKind: "codex", model: "gpt-5-codex" })
      .on("POST", "/api/chat", () => streams.shift()!.response());
    const page = openPage(computer, [RUN_1, RUN_2]);
    page.send("What is in this folder?");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push(
      { type: "_run", runId: RUN_1, detached: true },
      { type: "thread.started", thread_id: SESSION_ID },
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_0", type: "command_execution", command: "ls -la", status: "in_progress" } },
      { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "ls -la", aggregated_output: "notes.md\n", exit_code: 0 } },
      { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "There is" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "There is one file: notes.md." } },
      { type: "item.completed", item: { id: "item_2", item_type: "assistant_message", text: "Want me to open it?" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
      { type: "_done", code: 0 },
    );
    live.end();
    await waitFor(() => page.status() === "ready", "the Codex reply");
    expect(page.replies()).toEqual(["There is one file: notes.md.\n\nWant me to open it?"]);
    expect(page.chips()).toEqual(["⚙Bashls -la"]);
    expect(page.doc.title).toBe("Hivra · Codex");
    expect(Array.from(page.doc.querySelectorAll(".msg.assistant .who"), (node) => node.textContent)).toEqual(["Codex"]);
    expect(page.doc.querySelector("#model")!.textContent).toBe("gpt-5-codex");
    expect(page.input().placeholder).toBe("Message Codex…");
    expect(page.stored().sessionId).toBe(SESSION_ID);

    page.send("Yes");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the follow-up start");
    expect(computer.callsTo("POST", "/api/chat")[1].body).toMatchObject({ sessionId: SESSION_ID, detach: true, runId: RUN_2 });
    expect(page.errors).toEqual([]);
  });

  it("renders a generic agent's plain text and surfaces its real errors", async () => {
    const live = new LiveStream();
    const computer = new FakeComputer({ agentKind: "generic", model: null }).on("POST", "/api/chat", () => live.response());
    const page = openPage(computer, [RUN_1]);
    page.send("hello");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push(
      { type: "_run", runId: RUN_1, detached: true },
      { type: "_text", text: "Hello " },
      { type: "_stderr", text: "loading plugins\n" },
      { type: "_text", text: "from the agent." },
      { type: "_stderr", text: "Traceback: tool crashed\n" },
      { type: "_done", code: 0 },
    );
    live.end();
    await waitFor(() => page.status() === "ready", "the generic reply");
    expect(page.replies()).toEqual(["Hello from the agent.\n\n⚠ Traceback: tool crashed"]);
    expect(page.doc.title).toBe("Hivra · Agent");
    expect(page.doc.querySelector("#model")!.hasAttribute("hidden")).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it.each([
    [409, { error: "This conversation is still working on the previous message.", code: "conversation_busy" }, "This conversation is still working on the previous message.", "ready"],
    [401, { error: "unauthorized" }, "Reopen this page from your Hivra dashboard and send it again.", "signed out"],
    [429, { error: "The agent is already working on 8 conversations. Stop one or wait for it to finish.", code: "too_many_runs" }, "already working on 8 conversations", "ready"],
  ])("shows why the computer refused a message (HTTP %s) and puts it back in the composer", async (status, body, shown, statusText) => {
    const computer = new FakeComputer().on("POST", "/api/chat", () => json(status, body));
    const page = openPage(computer, [RUN_1]);
    page.send("Summarize the inbox");
    await waitFor(() => page.status() === statusText && page.sendButton().hidden === false, "the refusal");
    expect(page.replies()[0]).toContain("⚠ ");
    expect(page.replies()[0]).toContain(shown);
    expect(page.input().value).toBe("Summarize the inbox");
    expect(page.stopButton().hidden).toBe(true);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "error" });
    expect(page.errors).toEqual([]);
  });

  it("keeps an unfinished reply when its session ended, and says how to get back to it", async () => {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({
      v: 1, sessionId: SESSION_ID,
      turns: [{ user: "Deploy the site", assistant: "Building…", tools: [], warnings: [], runId: RUN_1, done: false, outcome: null }],
    }));
    const computer = new FakeComputer().on("GET", "/api/chat/runs", () => json(401, { error: "unauthorized" }));
    const page = openPage(computer);
    await waitFor(() => page.status() === "signed out", "the signed-out state");
    expect(page.replies()).toEqual(["Building…"]);
    expect(page.notes()[0]).toContain("Reopen this page from your Hivra dashboard to see the reply");
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: false });
    expect(computer.callsTo("GET", `/api/chat/runs/${RUN_1}/events`)).toEqual([]);
    expect(page.errors).toEqual([]);
  });
});

// ---- the page against the real gateway ------------------------------------------

const TOKEN = "c".repeat(64);
const SERVER_PATH = path.join(DIR, "server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const HOST = new URL(ORIGIN).host;

// A stand-in for `claude -p --output-format stream-json`: prints the init line
// and a first delta, waits WAIT:<ms> from the prompt, then finishes. It leaves
// done-<tag> when it finished and term-<tag> when it was stopped.
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_AGENT_DIR;
const prompt = fs.readFileSync(0, "utf8");
const tag = (prompt.match(/TAG:([a-z0-9-]+)/) || [, "untagged"])[1];
const wait = Number((prompt.match(/WAIT:(\\d+)/) || [, "0"])[1]);
process.on("SIGTERM", () => { fs.writeFileSync(path.join(dir, "term-" + tag), "1"); process.exit(143); });
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
out({ type: "system", subtype: "init", session_id: "${SESSION_ID}", model: "claude-opus-4-8" });
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on " + tag + "." } } });
setTimeout(() => {
  fs.writeFileSync(path.join(dir, "done-" + tag), "1");
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " Finished " + tag + "." } } });
  out({ type: "result", subtype: "success", session_id: "${SESSION_ID}", is_error: false });
  process.exit(0);
}, wait);
`;

async function readAll(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

describe("the computer's own chat page against the real gateway", () => {
  let home: string;
  let server: http.Server | undefined;
  const sockets = new Set<net.Socket>();

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-chat-page-")));
    fs.mkdirSync(path.join(home, "fake"));
    fs.mkdirSync(path.join(home, ".hivra"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), "claude\n");
    fs.writeFileSync(path.join(home, "fake-claude"), FAKE_CLAUDE, { mode: 0o755 });
  });

  afterEach(async () => {
    while (pages.length) pages.pop()!.close();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    const runsDir = path.join(home, ".hivra", "chat-runs");
    for (const name of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
      try {
        const status = JSON.parse(fs.readFileSync(path.join(runsDir, name, "status.json"), "utf8"));
        for (const pid of [status.cliPid, status.runnerPid]) if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
      } catch { /* no status */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The unmodified gateway module on a loopback port, as in the detached runs test.
  async function bootGateway() {
    const realRequire = createRequire(SERVER_PATH);
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") {
          return {
            ...http,
            createServer: (handler: http.RequestListener) => {
              server = http.createServer(handler);
              server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
              return server;
            },
          };
        }
        if (["fs", "path", "child_process", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0", CLAUDE_BIN: path.join(home, "fake-claude"), FAKE_AGENT_DIR: path.join(home, "fake") }, once: () => undefined },
      __dirname: DIR,
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    const created = server!;
    if (!created.listening) await new Promise((resolve) => created.once("listening", resolve));
    return (created.address() as net.AddressInfo).port;
  }

  function send(port: number, method: string, pathname: string, headers: Record<string, string>, body?: string) {
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, agent: false, headers }, resolve);
      req.once("error", reject);
      req.end(body);
    });
  }

  // Manage -> Endpoint -> Open: the dashboard POSTs the bearer once and the
  // computer answers with its short-lived session cookie.
  async function signIn(port: number) {
    const res = await send(port, "POST", "/auth/bootstrap", { "Content-Type": "application/x-www-form-urlencoded" }, new URLSearchParams({ token: TOKEN, destination: "/" }).toString());
    res.resume();
    expect(res.statusCode).toBe(303);
    const cookie = String(res.headers["set-cookie"]?.[0] || "").split(";")[0];
    expect(cookie).toMatch(/^__Host-hivra_auth=[a-f0-9]{64}$/);
    return cookie;
  }

  // The browser side of one page: same-origin requests carrying the session
  // cookie (and, as browsers do for POST, the page's Origin). Going away tears
  // down its open connections, like closing the tab; the gone page's script
  // hears nothing more.
  function browser(port: number, cookie: string): Transport {
    const open = new Set<http.ClientRequest>();
    let gone = false;
    return {
      fetch: (input, init = {}) => {
        if (gone) return new Promise(() => undefined);
        return new Promise((resolve, reject) => {
          const method = (init.method || "GET").toUpperCase();
          const req = http.request({
            hostname: "127.0.0.1", port, path: String(input), method, agent: false,
            headers: { Host: HOST, Cookie: cookie, ...(method === "GET" ? {} : { Origin: ORIGIN }), ...(init.body ? { "Content-Type": "application/json" } : {}) },
          }, (res) => {
            res.once("close", () => open.delete(req));
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                res.on("data", (chunk: Buffer) => { if (!gone) controller.enqueue(new Uint8Array(chunk)); });
                res.once("end", () => { if (!gone) controller.close(); });
                res.once("error", () => { if (!gone) controller.error(new TypeError("network error")); });
              },
            });
            resolve({
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, body,
              text: () => readAll(body),
              json: async () => JSON.parse(await readAll(body)),
            });
          });
          open.add(req);
          req.once("error", (error) => {
            open.delete(req);
            if (!gone) reject(new TypeError("Failed to fetch: " + error.message));
          });
          req.end(init.body);
        });
      },
      detach: () => {
        gone = true;
        for (const req of open) req.destroy();
        open.clear();
      },
    };
  }

  const marker = (name: string) => fs.existsSync(path.join(home, "fake", name));

  it("keeps the agent working through a reload, rebuilds the reply, and stops a run on request", async () => {
    const port = await bootGateway();
    const cookie = await signIn(port);

    const first = openPage(browser(port, cookie), [RUN_1]);
    first.send("TAG:one WAIT:1500 research the market");
    await waitFor(() => first.replies()[0] === "Working on one.", "the reply to start", 10_000);

    // Reload mid-turn: the old page's connection is torn down with it.
    const second = first.reload(browser(port, cookie), [RUN_2]);
    expect(second.replies()).toEqual(["Working on one."]);
    expect(second.status()).toBe("reconnecting…");
    await waitFor(() => second.replies()[0] === "Working on one. Finished one." && second.status() === "ready", "the resumed reply to finish", 15_000);
    expect(marker("done-one")).toBe(true);
    expect(marker("term-one")).toBe(false);
    expect(second.stored()).toMatchObject({ sessionId: SESSION_ID, turns: [{ runId: RUN_1, done: true, outcome: "complete" }] });

    // The next turn resumes the same conversation; Stop really ends it.
    second.send("TAG:two WAIT:20000 crawl everything");
    await waitFor(() => second.replies()[1] === "Working on two.", "the second reply to start", 10_000);
    second.stopButton().click();
    await waitFor(() => second.status() === "ready", "the stopped reply", 15_000);
    expect(marker("term-two")).toBe(true);
    expect(marker("done-two")).toBe(false);
    expect(second.notes()[1]).toBe("Stopped.");
    expect(second.stored().turns[1]).toMatchObject({ runId: RUN_2, done: true, outcome: "stopped" });
    expect(fs.readdirSync(path.join(home, ".hivra", "chat-runs")).sort()).toEqual([RUN_1, RUN_2].sort());
    expect([...first.errors, ...second.errors]).toEqual([]);
  }, 45_000);
});
