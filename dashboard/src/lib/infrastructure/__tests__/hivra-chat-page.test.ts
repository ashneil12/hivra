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
// origin, so it keeps the origin's localStorage exactly as a browser does, and
// two open frames are two tabs (jsdom sends each the other's `storage` events).
// The last block drives the same page over HTTP against the real gateway
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
const RUN_3 = "00000000-0000-4000-8000-000000000004";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000005";
const ELSEWHERE = "This reply is showing live in another tab of this page.";
const ELSEWHERE_STATUS = "a reply is running in another tab";
const eventsPath = (runId: string) => `/api/chat/runs/${runId}/events`;
const stopPath = (runId: string) => `/api/chat/runs/${runId}/stop`;

type Event = Record<string, unknown>;
type Init = { method?: string; body?: string; credentials?: string; signal?: unknown };
type Call = { method: string; path: string; query: string; body: unknown; credentials: string | undefined };
type FakeResponse = { ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; text(): Promise<string>; json(): Promise<unknown> };
type Handler = (call: Call) => FakeResponse | Promise<FakeResponse>;

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const delta = (text: string): Event => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
// Bytes the events carry in the run's log, which `?offset=` counts.
const logBytes = (...events: Event[]) => events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event) + "\n"), 0);

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
  // The computer writes a replayed log in large reads, cut anywhere: inside a
  // line and inside a multi-byte character.
  pushInChunks(events: Event[], count: number) {
    const bytes = encoder.encode(events.map((event) => JSON.stringify(event) + "\n").join(""));
    const size = Math.ceil(bytes.length / count);
    for (let at = 0; at < bytes.length; at += size) this.controller.enqueue(bytes.slice(at, at + size));
  }
  end() { this.controller.close(); }
  drop() { this.controller.error(new TypeError("network connection lost")); }
  response() { return reply(200, this.body); }
}

// What the page's `fetch` talks to. `detach` runs when the page goes away.
type Transport = { fetch: (input: unknown, init?: Init) => Promise<FakeResponse>; detach?: () => void };

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
  fetch = async (input: unknown, init: Init = {}) => {
    const url = new URL(String(input), ORIGIN + "/");
    if (url.origin !== ORIGIN || !String(input).startsWith("/")) throw new Error("the page fetched another origin: " + String(input));
    const call: Call = {
      method: (init.method || "GET").toUpperCase(), path: url.pathname, query: url.search,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, credentials: init.credentials,
    };
    this.calls.push(call);
    const handler = this.routes.get(call.method + " " + call.path);
    return handler ? await handler(call) : json(404, { error: "run not found" });
  };
  callsTo(method: string, pathname: string) {
    return this.calls.filter((call) => call.method === method && call.path === pathname);
  }
}

// navigator.locks for the tabs of one origin: exclusive locks, `ifAvailable`
// requests (all the page makes) and query(). A closed tab's locks are
// released, as a browser does.
class FakeLocks {
  private readonly held = new Map<string, string>();
  private paused: Promise<void> | null = null;
  waiting = 0;
  forTab(owner: string) {
    return {
      request: async (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
        // A browser answers a lock request in a later task, not at once.
        if (this.paused) {
          this.waiting += 1;
          await this.paused;
          this.waiting -= 1;
        }
        if (this.held.has(name)) {
          if (!options?.ifAvailable) throw new Error("the fake lock manager only answers ifAvailable requests");
          return callback(null);
        }
        this.held.set(name, owner);
        try {
          return await callback({ name, mode: "exclusive" });
        } finally {
          if (this.held.get(name) === owner) this.held.delete(name);
        }
      },
      query: async () => ({ held: Array.from(this.held, ([name, clientId]) => ({ name, mode: "exclusive", clientId })), pending: [] }),
    };
  }
  pauseGrants() {
    let resume = () => undefined as void;
    this.paused = new Promise<void>((resolve) => { resume = resolve; });
    return () => { this.paused = null; resume(); };
  }
  hold(runId: string, owner: string) { this.held.set("hivra-chat:run:" + runId, owner); }
  holder(runId: string) { return this.held.get("hivra-chat:run:" + runId); }
  releaseAll(owner: string) {
    for (const [name, holder] of Array.from(this.held)) if (holder === owner) this.held.delete(name);
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

type StoredTurn = Record<string, unknown>;
function storedTurn(fields: StoredTurn): StoredTurn {
  return {
    user: "", assistant: "", tools: [], warnings: [], runId: null, done: false, outcome: null,
    sessionId: null, resumes: null, sessionLost: false, stopRequested: false, createdAt: 1, updatedAt: 1,
    ...fields,
  };
}
function seed(turns: StoredTurn[], clearedAt = 0) {
  window.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, clearedAt, turns }));
}

const pages: Array<{ close(): void }> = [];
afterEach(() => {
  while (pages.length) pages.pop()!.close();
  window.localStorage.clear();
});

type PageWindow = Window & typeof globalThis & { eval(source: string): unknown };
// `holdStorageEvents`: the tab handles other tabs' saves late (a busy tab
// runs its own queued work first) until `deliverStorageEvents()`.
type PageOptions = { locks?: FakeLocks; owner?: string; holdStorageEvents?: boolean };

// Load the page into a new same-origin frame: the frame shares this origin's
// localStorage, so a second frame is what the same page is after a reload, or
// the page in another tab.
function openPage(computer: Transport, runIds: string[] = [], options: PageOptions = {}) {
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
  const owner = options.owner || "tab";
  if (options.locks) Object.defineProperty(w.navigator, "locks", { configurable: true, value: options.locks.forTab(owner) });
  // The page's clock, which the test can move forward.
  const realNow = w.Date.now.bind(w.Date);
  let skew = 0;
  w.Date.now = () => realNow() + skew;
  Object.assign(w, {
    // A page that went away never hears back from its requests.
    fetch: (input: unknown, init?: Init) => (closed ? new Promise(() => undefined) : computer.fetch(input, init)),
    TextDecoder,
    console: { ...console, warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")), error: (...args: unknown[]) => errors.push(args.map(String).join(" ")) },
  });
  const heldStorageEvents: StorageEvent[] = [];
  let holdingStorageEvents = Boolean(options.holdStorageEvents);
  // Registered before the page's own listener, so it can keep an event from it.
  w.addEventListener("storage", (event) => {
    if (!holdingStorageEvents) return;
    event.stopImmediatePropagation();
    heldStorageEvents.push(event);
  });
  w.eval(APP);
  const close = () => {
    if (closed) return;
    closed = true;
    computer.detach?.();
    options.locks?.releaseAll(owner);
    w.close();
    frame.remove();
  };
  pages.push({ close });
  const el = <T extends Element>(selector: string) => doc.querySelector(selector) as T;
  const page = {
    w, doc, errors, warnings, close,
    input: () => el<HTMLTextAreaElement>("#input"),
    sendButton: () => el<HTMLButtonElement>("#send"),
    stopButton: () => el<HTMLButtonElement>("#stop"),
    newChatButton: () => el<HTMLButtonElement>("#new"),
    status: () => el<HTMLElement>("#status").textContent,
    gate: () => (el<HTMLElement>("#gate").hidden ? "" : el<HTMLElement>("#gate").textContent),
    // The computer accepted the page's session and the conversation is shown.
    opened: () => waitFor(() => !el<HTMLElement>("#log").hidden, "the page to open"),
    send(text: string) {
      page.input().value = text;
      page.sendButton().click();
    },
    userMessages: () => Array.from(doc.querySelectorAll(".msg.user .body"), (node) => node.textContent),
    replies: () => Array.from(doc.querySelectorAll(".msg.assistant .body"), (node) => node.textContent),
    notes: () => Array.from(doc.querySelectorAll(".msg.assistant .note"), (node) => node.textContent),
    chips: () => Array.from(doc.querySelectorAll(".msg.assistant .chip"), (node) => node.textContent),
    offers: () => Array.from(doc.querySelectorAll<HTMLElement>(".msg.assistant .offer"), (node) => (node.hidden ? "" : node.textContent)).filter(Boolean),
    stored: () => JSON.parse(w.localStorage.getItem(STORE_KEY) || "null"),
    skewClock(ms: number) { skew = ms; },
    deliverStorageEvents() {
      holdingStorageEvents = false;
      for (const event of heldStorageEvents.splice(0)) {
        w.dispatchEvent(new w.StorageEvent("storage", { key: event.key, oldValue: event.oldValue, newValue: event.newValue, url: event.url }));
      }
    },
    // How many times a reply's body is rewritten from here on.
    countPaints() {
      let count = 0;
      const tally = (records: MutationRecord[]) => {
        for (const record of records) {
          const target = record.target as Element;
          if (target.classList?.contains("body") && target.closest(".msg.assistant")) count += 1;
        }
      };
      const observer = new w.MutationObserver(tally);
      observer.observe(el("#log"), { childList: true, subtree: true });
      return () => { tally(observer.takeRecords()); return count; };
    },
    // How many times the log's height is read (each read forces a layout).
    countScrolls() {
      let reads = 0;
      Object.defineProperty(el("#main"), "scrollHeight", { configurable: true, get: () => { reads += 1; return 0; } });
      return () => reads;
    },
    // A reload: the page hides, goes away, and loads again on the same origin.
    reload(nextComputer: Transport, nextRunIds: string[] = [], nextOptions: PageOptions = options) {
      page.closeTab();
      return openPage(nextComputer, nextRunIds, nextOptions);
    },
    closeTab() {
      w.dispatchEvent(new w.Event("pagehide"));
      close();
    },
  };
  return page;
}

function claudeTurn(text: string): Event[] {
  return [
    { type: "system", subtype: "init", session_id: SESSION_ID, model: "claude-opus-4-8[1m]" },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool_1", name: "Bash", input: {} } } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } }] } },
    delta(text),
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
    await page.opened();
    expect(computer.callsTo("GET", "/api/chat/runs")[0].credentials).toBe("same-origin");

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
      v: 1, clearedAt: 0,
      turns: [{
        user: "List the files", assistant: "Here are the files.", tools: [{ id: "tool_1", name: "Bash", detail: "ls" }], warnings: [],
        runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID, resumes: null, sessionLost: false, stopRequested: false,
        createdAt: expect.any(Number), updatedAt: expect.any(Number),
      }],
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
    await first.opened();
    first.send("Research the market");
    await waitFor(() => before.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true });
    live.push({ type: "system", subtype: "init", session_id: SESSION_ID });
    live.push(delta("Working on it."));
    await waitFor(() => first.replies()[0] === "Working on it.", "the partial reply");

    const replay = new LiveStream();
    const after = new FakeComputer()
      .on("GET", "/api/chat/runs", () => json(200, { runs: [{ runId: RUN_1, state, agentSessionId: SESSION_ID, clientRef: null }] }))
      .on("GET", eventsPath(RUN_1), () => replay.response());
    const second = first.reload(after);
    // The conversation comes back once the computer accepts the page's session.
    expect(second.userMessages()).toEqual([]);
    await second.opened();
    expect(second.userMessages()).toEqual(["Research the market"]);
    expect(second.replies()).toEqual(["Working on it."]);
    const [pickUp] = await waitFor(() => after.callsTo("GET", eventsPath(RUN_1)).length === 1 && after.callsTo("GET", eventsPath(RUN_1)), "the page to follow the run");
    // A new page has none of the log yet: it reads it from the start.
    expect(pickUp.query).toBe("");
    expect(after.callsTo("GET", "/api/chat/runs")[0].credentials).toBe("same-origin");
    expect(second.stopButton().hidden).toBe(false);

    // The run's log replays from the start, then continues live.
    replay.push(
      { type: "system", subtype: "init", session_id: SESSION_ID },
      delta("Working on it."),
      { type: "_ping" },
      delta(" Done: three findings."),
      { type: "result", subtype: "success", session_id: SESSION_ID, is_error: false },
      { type: "_done", code: 0 },
    );
    replay.end();
    await waitFor(() => second.status() === "ready", "the rebuilt reply to finish");
    expect(second.replies()).toEqual(["Working on it. Done: three findings."]);
    expect(after.callsTo("POST", "/api/chat")).toEqual([]);
    expect(second.stored()).toMatchObject({ turns: [{ runId: RUN_1, assistant: "Working on it. Done: three findings.", done: true, outcome: "complete", sessionId: SESSION_ID }] });

    // A finished reply is not fetched again on the next load.
    const idle = new FakeComputer();
    const third = second.reload(idle);
    await third.opened();
    await sleep(50);
    expect(third.replies()).toEqual(["Working on it. Done: three findings."]);
    expect(idle.calls.map((call) => call.path)).toEqual(["/api/meta", "/api/chat/runs"]);
    expect([...first.errors, ...second.errors, ...third.errors]).toEqual([]);
  });

  it("re-attaches from the byte offset it has after the stream drops, without doubling the reply or resending", async () => {
    const live = new LiveStream();
    const replay = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => live.response())
      .on("GET", eventsPath(RUN_1), () => replay.response());
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Write the report");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    const partOne = delta("Part one — ✓.");
    live.push({ type: "_run", runId: RUN_1, detached: true }, partOne, { type: "_ping" });
    await waitFor(() => page.replies()[0] === "Part one — ✓.", "the first part");
    live.drop();

    const [reattach] = await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 1 && computer.callsTo("GET", eventsPath(RUN_1)), "the re-attach");
    // Only the log counts: not the `_run` preface or the heartbeat, and bytes, not characters.
    expect(reattach.query).toBe("?offset=" + logBytes(partOne));
    replay.push(delta(" Part two."), { type: "_done", code: 0 });
    replay.end();
    await waitFor(() => page.status() === "ready", "the reply to finish");
    expect(page.replies()).toEqual(["Part one — ✓. Part two."]);
    expect(computer.callsTo("POST", "/api/chat")).toHaveLength(1);
    expect(page.warnings.some((line) => line.includes("the reply stream dropped"))).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it("replays a long run log without repainting the reply for every line", async () => {
    seed([storedTurn({ user: "Write the long report", runId: RUN_1 })]);
    const replay = new LiveStream();
    const computer = new FakeComputer().on("GET", eventsPath(RUN_1), () => replay.response());
    const page = openPage(computer);
    await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 1, "the page to follow the run");
    const paints = page.countPaints();
    const scrolls = page.countScrolls();
    const words = Array.from({ length: 1500 }, (_, i) => `wörd${i} ✓ `);
    replay.pushInChunks([
      { type: "system", subtype: "init", session_id: SESSION_ID },
      ...words.map(delta),
      { type: "result", subtype: "success", session_id: SESSION_ID, is_error: false },
      { type: "_done", code: 0 },
    ], 7);
    replay.end();
    await waitFor(() => page.status() === "ready", "the replayed reply", 20_000);
    expect(page.replies()).toEqual([words.join("")]);
    // Before: every one of the 1,500 lines rewrote the whole reply and forced
    // a layout, so a long run's replay froze the page.
    expect(paints()).toBeLessThanOrEqual(5);
    expect(scrolls()).toBeLessThanOrEqual(5);
    expect(page.stored().turns[0]).toMatchObject({ assistant: words.join(""), done: true, outcome: "complete", sessionId: SESSION_ID });
    expect(page.errors).toEqual([]);
  });

  it("cuts a stream that went silent and re-attaches from where it was; heartbeats keep a stream open", async () => {
    const live = new LiveStream();
    const replay = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => live.response())
      .on("GET", eventsPath(RUN_1), () => replay.response());
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Watch the build");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    const building = delta("Building…");
    live.push({ type: "_run", runId: RUN_1, detached: true }, building);
    await waitFor(() => page.replies()[0] === "Building…", "the reply to stream");

    // 31s pass with only a heartbeat: the stream is alive, and focus leaves it be.
    page.skewClock(31_000);
    live.push({ type: "_ping" });
    await sleep(50);
    page.w.dispatchEvent(new page.w.Event("focus"));
    await sleep(50);
    expect(computer.callsTo("GET", eventsPath(RUN_1))).toEqual([]);

    // Then 31s of nothing, not even a heartbeat: the connection died without an error.
    page.skewClock(62_000);
    page.w.dispatchEvent(new page.w.Event("online"));
    const [reattach] = await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 1 && computer.callsTo("GET", eventsPath(RUN_1)), "the re-attach");
    expect(reattach.query).toBe("?offset=" + logBytes(building));
    replay.push(delta(" Built."), { type: "_done", code: 0 });
    replay.end();
    await waitFor(() => page.status() === "ready", "the reply to finish");
    expect(page.replies()).toEqual(["Building… Built."]);
    expect(computer.callsTo("POST", "/api/chat")).toHaveLength(1);
    expect(page.warnings.some((line) => line.includes("nothing from the computer for 31s"))).toBe(true);
    expect(page.errors).toEqual([]);
  });

  it("a tab in the background also cuts a silent stream, since it holds the reply for every tab", async () => {
    const live = new LiveStream();
    const replay = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => live.response())
      .on("GET", eventsPath(RUN_1), () => replay.response());
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Watch the build");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    const building = delta("Building…");
    live.push({ type: "_run", runId: RUN_1, detached: true }, building);
    await waitFor(() => page.replies()[0] === "Building…", "the reply to stream");

    // The tab goes to the background; its connection dies without an error,
    // and the network comes back 46s later.
    Object.defineProperty(page.doc, "visibilityState", { configurable: true, get: () => "hidden" });
    page.doc.dispatchEvent(new page.w.Event("visibilitychange"));
    page.skewClock(46_000);
    page.w.dispatchEvent(new page.w.Event("online"));
    const [reattach] = await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 1 && computer.callsTo("GET", eventsPath(RUN_1)), "the re-attach");
    expect(reattach.query).toBe("?offset=" + logBytes(building));
    replay.push(delta(" Built."), { type: "_done", code: 0 });
    replay.end();
    await waitFor(() => page.status() === "ready", "the reply to finish");
    expect(page.replies()).toEqual(["Building… Built."]);
    expect(page.errors).toEqual([]);
  });

  it("when its session ends mid-reply and later works again, the page opens by itself and continues from the bytes it has", async () => {
    let signedIn = true;
    const live = new LiveStream();
    const replay = new LiveStream();
    const unauthorized = () => json(401, { error: "unauthorized" });
    const computer = new FakeComputer()
      .on("GET", "/api/chat/runs", () => (signedIn ? json(200, { runs: [] }) : unauthorized()))
      .on("POST", "/api/chat", () => live.response())
      .on("GET", eventsPath(RUN_1), () => (signedIn ? replay.response() : unauthorized()));
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Audit the repo");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    const init = { type: "system", subtype: "init", session_id: SESSION_ID };
    const partOne = delta("Checked 40 files — ✓.");
    live.push({ type: "_run", runId: RUN_1, detached: true }, init, partOne, { type: "_ping" });
    await waitFor(() => page.replies()[0] === "Checked 40 files — ✓.", "the first part");

    // The chat service restarts: the stream drops, and the page's session is no longer accepted.
    signedIn = false;
    live.drop();
    await waitFor(() => page.status() === "signed out", "the signed-out state");
    expect(page.userMessages()).toEqual([]);
    expect(page.gate()).toContain("Reopen this page from your Hivra dashboard");
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: false, assistant: "Checked 40 files — ✓." });

    // The session works again: the page's own checks open it, and it asks only for the rest of the log.
    signedIn = true;
    page.w.dispatchEvent(new page.w.Event("online"));
    await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 2, "the pick-up");
    const [refused, pickUp] = computer.callsTo("GET", eventsPath(RUN_1));
    expect(refused.query).toBe("?offset=" + logBytes(init, partOne));
    expect(pickUp.query).toBe("?offset=" + logBytes(init, partOne));
    expect(page.userMessages()).toEqual(["Audit the repo"]);
    replay.push(delta(" No issues."), { type: "result", subtype: "success", session_id: SESSION_ID, is_error: false }, { type: "_done", code: 0 });
    replay.end();
    await waitFor(() => page.status() === "ready", "the reply to finish");
    expect(page.replies()).toEqual(["Checked 40 files — ✓. No issues."]);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID });
    expect(computer.callsTo("POST", "/api/chat")).toHaveLength(1);
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
    await page.opened();
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

  it("holds the message while the computer updates its agent CLI, then sends it with the same run id", async () => {
    const live = new LiveStream();
    let attempts = 0;
    const computer = new FakeComputer({ agentKind: "codex", model: null }).on("POST", "/api/chat", () => {
      attempts += 1;
      if (attempts === 1) return json(503, { code: "agent_updating", error: "The agent is being updated to a new version. Send your message again in a minute." });
      return live.response();
    });
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Summarise notes.md");
    await waitFor(() => page.status() === "Your computer is updating Codex to a new version. Your message will send in a moment.", "the update note");
    expect(page.notes().filter(Boolean)).toEqual([]);
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the resend", 8000);
    const [first, second] = computer.callsTo("POST", "/api/chat");
    expect(second.body).toEqual(first.body);
    expect(page.status()).toBe("thinking…");
    live.push({ type: "_run", runId: RUN_1, detached: true },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Done." } },
      { type: "turn.completed", usage: {} }, { type: "_done", code: 0 });
    live.end();
    await waitFor(() => page.status() === "ready", "the reply");
    expect(page.replies()).toEqual(["Done."]);
    expect(page.errors).toEqual([]);
  }, 20_000);

  it("keeps Codex's own tracing diagnostics out of the reply, but not its real errors", async () => {
    const live = new LiveStream();
    const computer = new FakeComputer({ agentKind: "codex", model: null }).on("POST", "/api/chat", () => live.response());
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Hello");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true },
      { type: "_stderr", text: "2026-09-24T17:59:18.578959Z ERROR codex_core::session::session: failed to load skill /home/owner/.agents/skills/x/SKILL.md: missing YAML frontmatter\n    delimited by ---\n" },
      { type: "_stderr", text: "\u001b[2m2026-09-24T17:59:26.449919Z\u001b[0m \u001b[33m WARN\u001b[0m codex.exec{otel.kind=\"internal\"}: codex_core::mcp: server did not start\n" },
      { type: "_stderr", text: "Error loading config.toml: invalid type\n" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Hi." } },
      { type: "turn.completed", usage: {} }, { type: "_done", code: 0 });
    live.end();
    await waitFor(() => page.status() === "ready", "the reply");
    expect(page.doc.querySelector(".msg.assistant")!.textContent).not.toMatch(/failed to load skill|delimited by|server did not start/);
    expect(page.doc.querySelector(".msg.assistant")!.textContent).toContain("Error loading config.toml: invalid type");
  });

  it("keeps a start with no answer open, then asks to send again once the computer says it never arrived", async () => {
    const computer = new FakeComputer().on("POST", "/api/chat", () => { throw new TypeError("Failed to fetch"); });
    const page = openPage(computer, [RUN_1]);
    await page.opened();
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
    expect(computer.callsTo("GET", eventsPath(RUN_1))).toHaveLength(1);
    expect(page.replies()[0]).toBe("⚠ This message didn't reach the computer. Send it again.");
    expect(page.input().value).toBe("Order the parts");
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "error" });
    expect(page.errors).toEqual([]);
  }, 20_000);

  it("Stop asks the computer to end the run, and the reply closes as stopped", async () => {
    const live = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => live.response())
      .on("POST", stopPath(RUN_1), () => json(200, { ok: true, run: { runId: RUN_1, state: "running" } }));
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Crawl every page");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true }, { type: "_text", text: "Crawling…" });
    await waitFor(() => page.replies()[0] === "Crawling…", "the reply to stream");

    page.stopButton().click();
    const [stop] = await waitFor(() => computer.callsTo("POST", stopPath(RUN_1)).length === 1 && computer.callsTo("POST", stopPath(RUN_1)), "the stop request");
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

  it("a Stop pressed before the start was answered still stops the run once the page finds it", async () => {
    let stops = 0;
    const replay = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => { throw new TypeError("Failed to fetch"); })
      .on("POST", stopPath(RUN_1), () => (++stops === 1 ? json(404, { error: "run not found" }) : json(200, { ok: true })))
      .on("GET", eventsPath(RUN_1), () => replay.response());
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Crawl every page");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    page.stopButton().click();
    await waitFor(() => stops === 1, "the first stop");
    expect(page.status()).toBe("stopping…");
    await waitFor(() => page.status() === "offline", "the start to give up", 10_000);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: false, stopRequested: true });

    // The first start had reached the computer after all: the page finds the run and stops it.
    page.w.dispatchEvent(new page.w.Event("online"));
    await waitFor(() => stops === 2, "the stop to be sent again");
    expect(page.status()).toBe("stopping…");
    replay.push({ type: "_text", text: "Crawling…" }, { type: "_done", code: 143, signal: null, stopped: "user" });
    replay.end();
    await waitFor(() => page.status() === "ready", "the stopped reply");
    expect(page.notes()).toEqual(["Stopped."]);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "stopped" });
    expect(page.errors).toEqual([]);
  }, 20_000);

  it("a Stop pressed before a start that never reached the computer ends the turn as stopped", async () => {
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => { throw new TypeError("Failed to fetch"); })
      .on("POST", stopPath(RUN_1), () => json(404, { error: "run not found" }));
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Crawl every page");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    page.stopButton().click();
    await waitFor(() => page.status() === "offline", "the start to give up", 10_000);

    page.w.dispatchEvent(new page.w.Event("online"));
    await waitFor(() => page.status() === "ready", "the resume check");
    expect(page.notes()).toEqual(["Stopped."]);
    expect(page.replies()).toEqual([""]);
    // Stopped on purpose: nothing is put back to send again.
    expect(page.input().value).toBe("");
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "stopped" });
    expect(page.errors).toEqual([]);
  }, 20_000);

  it("renders Codex runs: agent messages, commands and the thread id to resume", async () => {
    const live = new LiveStream();
    const next = new LiveStream();
    const streams = [live, next];
    const computer = new FakeComputer({ agentKind: "codex", model: "gpt-5-codex" })
      .on("POST", "/api/chat", () => streams.shift()!.response());
    const page = openPage(computer, [RUN_1, RUN_2]);
    await page.opened();
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
    expect(page.stored().turns[0].sessionId).toBe(SESSION_ID);

    page.send("Yes");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the follow-up start");
    expect(computer.callsTo("POST", "/api/chat")[1].body).toMatchObject({ sessionId: SESSION_ID, detach: true, runId: RUN_2 });
    expect(page.errors).toEqual([]);
  });

  it("renders a generic agent's plain text and surfaces its real errors", async () => {
    const live = new LiveStream();
    const computer = new FakeComputer({ agentKind: "generic", model: null }).on("POST", "/api/chat", () => live.response());
    const page = openPage(computer, [RUN_1]);
    await page.opened();
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
    [409, { error: "This conversation is still working on the previous message.", code: "conversation_busy" }, "This conversation is still working on the previous message."],
    [429, { error: "The agent is already working on 8 conversations. Stop one or wait for it to finish.", code: "too_many_runs" }, "already working on 8 conversations"],
  ])("shows why the computer refused a message (HTTP %s) and puts it back in the composer", async (status, body, shown) => {
    const computer = new FakeComputer().on("POST", "/api/chat", () => json(status, body));
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Summarize the inbox");
    await waitFor(() => page.status() === "ready" && page.sendButton().hidden === false && page.replies()[0]?.includes("⚠ "), "the refusal");
    expect(page.replies()[0]).toContain(shown);
    expect(page.input().value).toBe("Summarize the inbox");
    expect(page.stopButton().hidden).toBe(true);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "error" });
    expect(page.errors).toEqual([]);
  });

  it("a message refused because the session ended goes back to the composer, and the conversation leaves the screen", async () => {
    const computer = new FakeComputer().on("POST", "/api/chat", () => json(401, { error: "unauthorized" }));
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Summarize the inbox");
    await waitFor(() => page.status() === "signed out", "the signed-out state");
    expect(page.gate()).toContain("Reopen this page from your Hivra dashboard");
    expect(page.userMessages()).toEqual([]);
    expect(page.sendButton().disabled).toBe(true);
    expect(page.input().value).toBe("Summarize the inbox");
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "error", warnings: [expect.stringContaining("send it again")] });
    expect(page.errors).toEqual([]);
  });

  it("shows nothing saved on this device until the computer accepts the page's session", async () => {
    seed([storedTurn({ user: "Deploy the site", assistant: "Building…", runId: RUN_1, sessionId: SESSION_ID })]);
    let signedIn = false;
    const replay = new LiveStream();
    const computer = new FakeComputer()
      .on("GET", "/api/chat/runs", () => (signedIn ? json(200, { runs: [] }) : json(401, { error: "unauthorized" })))
      .on("GET", eventsPath(RUN_1), () => replay.response());
    const page = openPage(computer);
    // GET / is public: before and after the computer answers, nothing saved here is on the page.
    expect(page.doc.body.textContent).not.toContain("Deploy the site");
    await waitFor(() => page.status() === "signed out", "the signed-out state");
    expect(page.doc.body.textContent).not.toContain("Deploy the site");
    expect(page.doc.body.textContent).not.toContain("Building…");
    expect(page.gate()).toContain("Reopen this page from your Hivra dashboard");
    expect(page.sendButton().disabled).toBe(true);
    expect(page.newChatButton().disabled).toBe(true);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: false, assistant: "Building…" });
    expect(computer.callsTo("GET", eventsPath(RUN_1))).toEqual([]);

    // Reopened from the dashboard (in this tab or another): the next check opens the page, and the reply continues.
    signedIn = true;
    page.w.dispatchEvent(new page.w.Event("focus"));
    await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 1, "the pick-up");
    expect(page.userMessages()).toEqual(["Deploy the site"]);
    expect(page.gate()).toBe("");
    replay.push(delta("Building… done."), { type: "_done", code: 0 });
    replay.end();
    await waitFor(() => page.status() === "ready", "the reply to finish");
    expect(page.replies()).toEqual(["Building… done."]);
    expect(page.errors).toEqual([]);
  });

  it("drops a conversation the computer no longer has, so the next message starts a new one", async () => {
    seed([storedTurn({ user: "Plan the trip", assistant: "Here is the plan.", runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID })]);
    const failed = new LiveStream();
    const fresh = new LiveStream();
    const streams = [failed, fresh];
    const computer = new FakeComputer().on("POST", "/api/chat", () => streams.shift()!.response());
    const page = openPage(computer, [RUN_2, RUN_3]);
    await page.opened();
    page.send("Book the flights");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    expect(computer.callsTo("POST", "/api/chat")[0].body).toMatchObject({ sessionId: SESSION_ID });
    // What Claude Code 2.1 prints when asked to resume a transcript it no longer has.
    const missing = `No conversation found with session ID: ${SESSION_ID}`;
    failed.push(
      { type: "_run", runId: RUN_2, detached: true },
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: SESSION_ID, errors: [missing] },
      { type: "_stderr", text: missing + "\n" },
      { type: "_done", code: 1 },
    );
    failed.end();
    await waitFor(() => page.status() === "ready", "the failed reply");
    expect(page.replies()[1]).toContain(missing);
    expect(page.replies()[1]).toContain("start a new conversation with the agent");
    expect(page.input().value).toBe("Book the flights");
    expect(page.stored().turns[1]).toMatchObject({ runId: RUN_2, done: true, outcome: "error", sessionId: null, sessionLost: true });
    expect(page.offers()).toEqual(["Start a new chat"]);

    page.sendButton().click();
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the new conversation");
    expect(computer.callsTo("POST", "/api/chat")[1].body).toEqual({ message: "Book the flights", sessionId: null, detach: true, runId: RUN_3 });
    await waitFor(() => page.offers().length === 0, "the offer to go once the next message is on its way");
    expect(page.errors).toEqual([]);
  });

  it("offers a new chat right under a reply whose agent conversation is gone, keeping the unsent message", async () => {
    seed([storedTurn({ user: "Plan the trip", assistant: "Here is the plan.", runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID })]);
    const failed = new LiveStream();
    const fresh = new LiveStream();
    const streams = [failed, fresh];
    const computer = new FakeComputer().on("POST", "/api/chat", () => streams.shift()!.response());
    const page = openPage(computer, [RUN_2, RUN_3]);
    await page.opened();
    expect(page.offers()).toEqual([]);
    page.send("Book the flights");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    failed.push({ type: "_run", runId: RUN_2, detached: true }, { type: "_stderr", text: `No conversation found with session ID: ${SESSION_ID}\n` }, { type: "_done", code: 1 });
    failed.end();
    await waitFor(() => page.offers().length === 1, "the offer");
    // The agent's own words for it are shown too, not just the page's.
    expect(page.replies()[1]).toContain("No conversation found with session ID");

    page.doc.querySelector<HTMLButtonElement>(".msg.assistant .offer")!.click();
    await waitFor(() => page.userMessages().length === 0, "the new chat");
    expect(page.input().value).toBe("Book the flights");
    expect(page.stored()).toEqual({ v: 1, clearedAt: expect.any(Number), turns: [] });
    page.sendButton().click();
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the first message of the new chat");
    expect(computer.callsTo("POST", "/api/chat")[1].body).toEqual({ message: "Book the flights", sessionId: null, detach: true, runId: RUN_3 });
    expect(page.errors).toEqual([]);
  });

  it("a run that ended without an exit code (killed, or never started) closes as failed, not complete", async () => {
    const live = new LiveStream();
    const computer = new FakeComputer().on("POST", "/api/chat", () => live.response());
    const page = openPage(computer, [RUN_1]);
    await page.opened();
    page.send("Index the documents");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true }, { type: "_done", code: null, signal: "SIGKILL" });
    live.end();
    await waitFor(() => page.status() === "ready", "the reply to close");
    expect(page.replies()).toEqual(["⚠ The agent ended before it finished (SIGKILL)."]);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "error" });
    expect(page.errors).toEqual([]);
  });

  it("continues the newest turn's session, even when an older reply is rebuilt after it", async () => {
    seed([
      // Its start got no answer; it did reach the computer, in a conversation of its own.
      storedTurn({ user: "First message", runId: RUN_1, createdAt: 1 }),
      storedTurn({ user: "Second message", assistant: "Second reply.", runId: RUN_2, done: true, outcome: "complete", sessionId: SESSION_ID, createdAt: 2 }),
    ]);
    const replay = new LiveStream();
    const live = new LiveStream();
    const computer = new FakeComputer()
      .on("GET", eventsPath(RUN_1), () => replay.response())
      .on("POST", "/api/chat", () => live.response());
    const page = openPage(computer, [RUN_3]);
    await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 1, "the pick-up");
    replay.push({ type: "system", subtype: "init", session_id: OTHER_SESSION }, delta("First reply."), { type: "_done", code: 0 });
    replay.end();
    await waitFor(() => page.status() === "ready", "the rebuilt reply");
    expect(page.replies()).toEqual(["First reply.", "Second reply."]);

    page.send("Third message");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    expect(computer.callsTo("POST", "/api/chat")[0].body).toMatchObject({ sessionId: SESSION_ID, runId: RUN_3 });
    expect(page.errors).toEqual([]);
  });

  it.each(["the computer's answer", "the run's lock"])("New chat while a reply is being picked up (waiting on %s) leaves that run, and its session, out of the new chat", async (waitingOn) => {
    const locks = new FakeLocks();
    seed([
      storedTurn({ user: "Plan the trip", assistant: "Here is the plan.", runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID, createdAt: 1 }),
      storedTurn({ user: "Book the flights", runId: RUN_2, resumes: SESSION_ID, createdAt: 2 }),
    ]);
    // Another tab is showing the unfinished reply, so this one leaves it be for now.
    locks.hold(RUN_2, "other-tab");
    const computer = new FakeComputer();
    const page = openPage(computer, [RUN_3], { locks, owner: "this-tab" });
    await page.opened();
    await waitFor(() => page.notes()[1] === ELSEWHERE, "the reply to be left to the other tab");
    expect(computer.callsTo("GET", eventsPath(RUN_2))).toEqual([]);

    // That tab closes. This one checks again, and New chat is pressed while
    // the check waits on the computer, or on the run's lock.
    locks.releaseAll("other-tab");
    let proceed: (() => void) | null = null;
    if (waitingOn === "the run's lock") {
      proceed = locks.pauseGrants();
    } else {
      let answer: (() => void) | null = null;
      computer.on("GET", "/api/chat/runs", () => new Promise<FakeResponse>((resolve) => { answer = () => resolve(json(200, { runs: [] })); }));
      proceed = () => answer!();
    }
    page.w.dispatchEvent(new page.w.Event("focus"));
    await waitFor(() => (waitingOn === "the run's lock" ? locks.waiting === 1 : computer.callsTo("GET", "/api/chat/runs").length === 2), "the check to wait");
    expect(page.newChatButton().disabled).toBe(false);
    page.newChatButton().click();
    await waitFor(() => page.userMessages().length === 0, "the new chat");
    proceed();
    await sleep(100);
    expect(computer.callsTo("GET", eventsPath(RUN_2))).toEqual([]);
    expect(page.status()).toBe("ready");
    expect(page.sendButton().hidden).toBe(false);
    expect(page.stopButton().hidden).toBe(true);
    expect(page.stored()).toEqual({ v: 1, clearedAt: expect.any(Number), turns: [] });

    const live = new LiveStream();
    computer.on("POST", "/api/chat", () => live.response());
    page.send("Hello");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    expect(computer.callsTo("POST", "/api/chat")[0].body).toEqual({ message: "Hello", sessionId: null, detach: true, runId: RUN_3 });
    expect(page.errors).toEqual([]);
  });

  it("two tabs of the page keep one conversation: each shows and saves the other's turns", async () => {
    const first = new LiveStream();
    const second = new LiveStream();
    const streams = [first, second];
    const computer = new FakeComputer().on("POST", "/api/chat", () => streams.shift()!.response());
    const tabA = openPage(computer, [RUN_1]);
    const tabB = openPage(computer, [RUN_2]);
    await tabA.opened();
    await tabB.opened();

    tabA.send("First question");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the first start");
    first.push({ type: "_run", runId: RUN_1, detached: true }, ...claudeTurn("First answer."), { type: "_done", code: 0 });
    first.end();
    await waitFor(() => tabA.status() === "ready", "the first reply");
    await waitFor(() => tabB.replies()[0] === "First answer.", "the other tab to show it");

    tabB.send("Second question");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the second start");
    expect(computer.callsTo("POST", "/api/chat")[1].body).toMatchObject({ sessionId: SESSION_ID, runId: RUN_2 });
    second.push({ type: "_run", runId: RUN_2, detached: true }, delta("Second answer."), { type: "_done", code: 0 });
    second.end();
    await waitFor(() => tabB.status() === "ready", "the second reply");
    // Painted on the next frame after the other tab's save arrives.
    await waitFor(() => tabA.replies()[1] === "Second answer.", "the first tab to show it");
    expect(tabA.userMessages()).toEqual(["First question", "Second question"]);
    expect(tabA.replies()).toEqual(["First answer.", "Second answer."]);
    expect(tabA.stored().turns.map((turn: StoredTurn) => turn.runId)).toEqual([RUN_1, RUN_2]);

    // Either tab saving again keeps both turns, and a reload finds them.
    const again = tabA.reload(new FakeComputer());
    await again.opened();
    expect(again.userMessages()).toEqual(["First question", "Second question"]);

    // New chat in one tab starts over in the other too.
    tabB.newChatButton().click();
    await waitFor(() => again.userMessages().length === 0, "the other tab to start over");
    expect(again.stored().turns).toEqual([]);
    expect([...tabA.errors, ...tabB.errors, ...again.errors]).toEqual([]);
  });

  it("a reply running in one tab is shown, not followed again, by another tab, which takes it over when that tab closes", async () => {
    const locks = new FakeLocks();
    const live = new LiveStream();
    const replay = new LiveStream();
    const computer = new FakeComputer()
      .on("POST", "/api/chat", () => live.response())
      .on("GET", eventsPath(RUN_1), () => replay.response());
    const tabA = openPage(computer, [RUN_1], { locks, owner: "tab-a" });
    const tabB = openPage(computer, [], { locks, owner: "tab-b" });
    await tabA.opened();
    await tabB.opened();
    tabA.send("Migrate the database");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    expect(locks.holder(RUN_1)).toBe("tab-a");
    live.push({ type: "_run", runId: RUN_1, detached: true }, delta("Step one."));
    await waitFor(() => tabB.replies()[0] === "Step one.", "the other tab to show the reply");

    tabB.w.dispatchEvent(new tabB.w.Event("focus"));
    await waitFor(() => tabB.notes()[0] === ELSEWHERE, "the other tab to leave the reply to the first");
    expect(computer.callsTo("GET", eventsPath(RUN_1))).toEqual([]);
    // New chat there would drop a reply that is still running.
    tabB.newChatButton().click();
    await waitFor(() => tabB.status() === "a reply is running in another tab", "New chat to be refused");
    expect(tabB.userMessages()).toEqual(["Migrate the database"]);

    // The first tab closes mid-reply; the other takes it over on its next check.
    tabA.closeTab();
    tabB.w.dispatchEvent(new tabB.w.Event("focus"));
    await waitFor(() => computer.callsTo("GET", eventsPath(RUN_1)).length === 1, "the take-over");
    expect(locks.holder(RUN_1)).toBe("tab-b");
    replay.push(delta("Step one."), delta(" Step two."), { type: "_done", code: 0 });
    replay.end();
    await waitFor(() => tabB.status() === "ready", "the reply to finish");
    expect(tabB.replies()).toEqual(["Step one. Step two."]);
    expect(computer.callsTo("POST", "/api/chat")).toHaveLength(1);
    expect(locks.holder(RUN_1)).toBeUndefined();
    expect([...tabA.errors, ...tabB.errors]).toEqual([]);
  });

  it.each(["has heard of it", "has not heard of it yet"])("while a reply runs in one tab, another tab (which %s) holds its message until that reply finishes, then continues the same conversation", async (heard) => {
    const locks = new FakeLocks();
    const first = new LiveStream();
    const second = new LiveStream();
    const streams = [first, second];
    const computer = new FakeComputer().on("POST", "/api/chat", () => streams.shift()!.response());
    const tabA = openPage(computer, [RUN_1], { locks, owner: "tab-a" });
    const tabB = openPage(computer, [RUN_2], { locks, owner: "tab-b", holdStorageEvents: heard !== "has heard of it" });
    await tabA.opened();
    await tabB.opened();

    // The first message of a new chat. The agent has not reported its
    // session yet (Claude Code takes a few seconds to start).
    tabA.send("First question");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the first start");
    first.push({ type: "_run", runId: RUN_1, detached: true });
    if (heard === "has heard of it") {
      await waitFor(() => tabB.sendButton().disabled, "the other tab to stop taking messages");
      expect(tabB.userMessages()).toEqual(["First question"]);
      expect(tabB.notes()).toEqual([ELSEWHERE]);
      expect(tabB.status()).toBe(ELSEWHERE_STATUS);
    } else {
      expect(tabB.userMessages()).toEqual([]);
      expect(tabB.sendButton().disabled).toBe(false);
    }

    // Before: the other tab started a second agent conversation (no session
    // to continue yet), or, once the session was known, had its message
    // refused as busy and saved a failed turn into the shared conversation.
    tabB.input().value = "Second question";
    tabB.input().dispatchEvent(new tabB.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => tabB.status() === ELSEWHERE_STATUS && tabB.sendButton().disabled, "the other tab to hold the message");
    await sleep(50);
    expect(computer.callsTo("POST", "/api/chat")).toHaveLength(1);
    expect(tabB.input().value).toBe("Second question");
    expect(tabB.userMessages()).toEqual(["First question"]);
    expect(tabB.notes()).toEqual([ELSEWHERE]);
    tabB.deliverStorageEvents();

    // The reply finishes in the first tab: the other tab shows it with no
    // note, and its message continues the conversation that reply started.
    first.push(...claudeTurn("First answer."), { type: "_done", code: 0 });
    first.end();
    await waitFor(() => tabB.replies()[0] === "First answer." && !tabB.sendButton().disabled, "the other tab to take messages again");
    expect(tabB.notes()).toEqual([""]);
    expect(tabB.status()).toBe("ready");
    tabB.sendButton().click();
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 2, "the second start");
    expect(computer.callsTo("POST", "/api/chat")[1].body).toEqual({ message: "Second question", sessionId: SESSION_ID, detach: true, runId: RUN_2 });
    second.push({ type: "_run", runId: RUN_2, detached: true }, delta("Second answer."), { type: "_done", code: 0 });
    second.end();
    await waitFor(() => tabA.replies()[1] === "Second answer.", "the first tab to show the second reply");
    expect(tabA.stored().turns).toEqual([
      expect.objectContaining({ runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID, warnings: [] }),
      expect.objectContaining({ runId: RUN_2, done: true, outcome: "complete", resumes: SESSION_ID, warnings: [] }),
    ]);
    expect([...tabA.errors, ...tabB.errors]).toEqual([]);
  });

  it("a tab opened while another tab shows a reply drops its note about that tab once the reply finishes there", async () => {
    const locks = new FakeLocks();
    const live = new LiveStream();
    const computer = new FakeComputer().on("POST", "/api/chat", () => live.response());
    const tabA = openPage(computer, [RUN_1], { locks, owner: "tab-a" });
    await tabA.opened();
    tabA.send("Migrate the database");
    await waitFor(() => computer.callsTo("POST", "/api/chat").length === 1, "the start");
    live.push({ type: "_run", runId: RUN_1, detached: true }, delta("Step one."));
    await waitFor(() => tabA.replies()[0] === "Step one.", "the reply to stream");

    const tabB = openPage(computer, [], { locks, owner: "tab-b" });
    await waitFor(() => tabB.notes()[0] === ELSEWHERE, "the new tab to leave the reply to the first");
    expect(tabB.sendButton().disabled).toBe(true);
    expect(tabB.status()).toBe(ELSEWHERE_STATUS);

    live.push(delta(" Step two."), { type: "_done", code: 0 });
    live.end();
    await waitFor(() => tabB.replies()[0] === "Step one. Step two.", "the finished reply in the new tab");
    tabB.w.dispatchEvent(new tabB.w.Event("focus"));
    await sleep(50);
    expect(tabB.notes()).toEqual([""]);
    expect(tabB.sendButton().disabled).toBe(false);
    expect(tabB.status()).toBe("ready");
    expect(computer.callsTo("GET", eventsPath(RUN_1))).toEqual([]);
    expect([...tabA.errors, ...tabB.errors]).toEqual([]);
  });

  it("a reply the computer no longer has closes without the reconnecting note", async () => {
    seed([storedTurn({ user: "Write the report", assistant: "Part one.", runId: RUN_1, sessionId: SESSION_ID })]);
    let reads = 0;
    const computer = new FakeComputer().on("GET", eventsPath(RUN_1), () => (++reads === 1 ? json(503, { error: "busy" }) : json(404, { error: "run not found" })));
    const page = openPage(computer);
    await waitFor(() => reads === 2 && page.status() === "ready", "the reply to close", 10_000);
    expect(page.replies()).toEqual(["Part one.\n\n⚠ This reply is no longer available on the computer."]);
    expect(page.notes()).toEqual([""]);
    expect(page.stored().turns[0]).toMatchObject({ runId: RUN_1, done: true, outcome: "error" });
    expect(page.errors).toEqual([]);
  });

  it("a tab that saves before it has handled another tab's save keeps the turn that tab added", async () => {
    seed([storedTurn({ user: "First question", assistant: "First answer.", runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID })]);
    const live = new LiveStream();
    const computer = new FakeComputer().on("POST", "/api/chat", () => live.response());
    const tabA = openPage(computer, [], { holdStorageEvents: true });
    const tabB = openPage(computer, [RUN_2]);
    await tabA.opened();
    await tabB.opened();
    tabB.send("Second question");
    await waitFor(() => tabB.stored().turns.length === 2, "the other tab to save its turn");
    expect(tabA.userMessages()).toEqual(["First question"]);

    // The first tab closes, saving what it has, before it handled that save.
    tabA.closeTab();
    expect(tabB.stored().turns.map((turn: StoredTurn) => turn.runId)).toEqual([RUN_1, RUN_2]);
    const again = openPage(new FakeComputer());
    await again.opened();
    expect(again.userMessages()).toEqual(["First question", "Second question"]);
    expect([...tabA.errors, ...tabB.errors, ...again.errors]).toEqual([]);
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
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on " + tag + " — ✓." } } });
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
  // hears nothing more. `drop` cuts the open connections while the page stays.
  function browser(port: number, cookie: string) {
    const open = new Set<http.ClientRequest>();
    const requested: string[] = [];
    let gone = false;
    const transport = {
      requested,
      fetch: (input: unknown, init: Init = {}) => {
        if (gone) return new Promise<FakeResponse>(() => undefined);
        requested.push(String(input));
        return new Promise<FakeResponse>((resolve, reject) => {
          const method = (init.method || "GET").toUpperCase();
          const req = http.request({
            hostname: "127.0.0.1", port, path: String(input), method, agent: false,
            headers: { Host: HOST, Cookie: cookie, ...(method === "GET" ? {} : { Origin: ORIGIN }), ...(init.body ? { "Content-Type": "application/json" } : {}) },
          }, (res) => {
            res.once("close", () => open.delete(req));
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                const fail = () => { try { controller.error(new TypeError("network error")); } catch { /* already closed */ } };
                res.on("data", (chunk: Buffer) => { if (!gone) controller.enqueue(new Uint8Array(chunk)); });
                res.once("end", () => { if (!gone) controller.close(); });
                res.once("error", () => { if (!gone) fail(); });
                res.once("close", () => { if (!gone && !res.complete) fail(); });
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
      drop: () => {
        for (const req of open) req.destroy();
        open.clear();
      },
      detach: () => {
        gone = true;
        transport.drop();
      },
    };
    return transport;
  }

  const marker = (name: string) => fs.existsSync(path.join(home, "fake", name));

  it("keeps the agent working through a reload, rebuilds the reply, and stops a run on request", async () => {
    const port = await bootGateway();
    const cookie = await signIn(port);

    const first = openPage(browser(port, cookie), [RUN_1]);
    await first.opened();
    first.send("TAG:one WAIT:1500 research the market");
    await waitFor(() => first.replies()[0] === "Working on one — ✓.", "the reply to start", 10_000);

    // Reload mid-turn: the old page's connection is torn down with it.
    const second = first.reload(browser(port, cookie), [RUN_2]);
    await second.opened();
    expect(second.replies()[0]).toBe("Working on one — ✓.");
    await waitFor(() => second.replies()[0] === "Working on one — ✓. Finished one." && second.status() === "ready", "the resumed reply to finish", 15_000);
    expect(marker("done-one")).toBe(true);
    expect(marker("term-one")).toBe(false);
    expect(second.stored()).toMatchObject({ turns: [{ runId: RUN_1, done: true, outcome: "complete", sessionId: SESSION_ID }] });

    // The next turn resumes the same conversation; Stop really ends it.
    second.send("TAG:two WAIT:20000 crawl everything");
    await waitFor(() => second.replies()[1] === "Working on two — ✓.", "the second reply to start", 10_000);
    second.stopButton().click();
    await waitFor(() => second.status() === "ready", "the stopped reply", 15_000);
    expect(marker("term-two")).toBe(true);
    expect(marker("done-two")).toBe(false);
    expect(second.notes()[1]).toBe("Stopped.");
    expect(second.stored().turns[1]).toMatchObject({ runId: RUN_2, done: true, outcome: "stopped" });
    expect(fs.readdirSync(path.join(home, ".hivra", "chat-runs")).sort()).toEqual([RUN_1, RUN_2].sort());
    expect([...first.errors, ...second.errors]).toEqual([]);
  }, 45_000);

  it("after a dropped connection, continues from exactly the bytes of the run's log it already has", async () => {
    const port = await bootGateway();
    const cookie = await signIn(port);
    const transport = browser(port, cookie);
    const page = openPage(transport, [RUN_1]);
    await page.opened();
    page.send("TAG:three WAIT:2500 research the market");
    await waitFor(() => page.replies()[0] === "Working on three — ✓.", "the reply to start", 10_000);
    const logFile = path.join(home, ".hivra", "chat-runs", RUN_1, "events.ndjson");
    const received = fs.statSync(logFile).size;

    // The network drops; the page stays and re-attaches on its own.
    transport.drop();
    await waitFor(() => page.replies()[0] === "Working on three — ✓. Finished three." && page.status() === "ready", "the reply to finish", 15_000);
    expect(transport.requested.filter((url) => url.includes("/events"))).toEqual([`${eventsPath(RUN_1)}?offset=${received}`]);
    expect(marker("done-three")).toBe(true);
    expect(page.warnings.some((line) => line.includes("the reply stream dropped"))).toBe(true);
    expect(page.warnings.some((line) => line.includes("not JSON"))).toBe(false);
    expect(page.errors).toEqual([]);
  }, 30_000);
});
