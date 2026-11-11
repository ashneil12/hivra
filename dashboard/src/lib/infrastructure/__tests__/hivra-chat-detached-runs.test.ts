
import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";

// Behaviour of the guest chat gateway (provisioner/hivra-chat/server.js) with
// detached chat runs. The complete, unmodified gateway module is evaluated with
// a real filesystem rooted in a throwaway HOME and real process creation, so
// every run goes through the actual detached runner (chat-runs.cjs) and a fake
// agent CLI that behaves like `claude -p --output-format stream-json`.

const TOKEN = "c".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

// A stand-in for the official CLI. It records its argv/prompt, prints the
// claude stream-json shape, waits `WAIT:<ms>` from the prompt, then writes a
// marker proving the turn really finished. SIGTERM is recorded, not ignored.
const FAKE_AGENT = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_AGENT_DIR;
if (process.argv[2] === "--version") { process.stdout.write((process.env.FAKE_AGENT_VERSION || "") + "\\n"); process.exit(0); }
const readStdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
const prompt = process.env.FAKE_AGENT_PROMPT_VIA_ARG === "1" ? process.argv[process.argv.length - 1] : readStdin();
const tag = (prompt.match(/TAG:([a-z0-9-]+)/) || [, "untagged"])[1];
const wait = Number((prompt.match(/WAIT:(\\d+)/) || [, "0"])[1]);
fs.writeFileSync(path.join(dir, "argv-" + tag + ".json"), JSON.stringify({ argv: process.argv.slice(2), prompt, pgid: process.pid, modelKey: process.env.HIVRA_LLM_API_KEY || null }));
process.on("SIGTERM", () => { fs.writeFileSync(path.join(dir, "term-" + tag), String(Date.now())); process.exit(143); });
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
out({ type: "system", subtype: "init", session_id: "${SESSION_ID}" });
process.stderr.write("fake-agent: working on " + tag + "\\n");
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on " + tag + "." } } });
setTimeout(() => {
  fs.writeFileSync(path.join(dir, "done-" + tag), String(Date.now()));
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " Finished " + tag + "." } } });
  out({ type: "result", subtype: "success", session_id: "${SESSION_ID}", is_error: false });
  process.exit(0);
}, wait);
`;

type Gateway = { port: number; server: http.Server; close: () => Promise<void> };

function waitFor<T>(probe: () => T | undefined | false | null, timeoutMs = 10_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value: T | undefined | false | null;
      try { value = probe(); } catch { value = undefined; }
      if (value) return resolve(value as T);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

jest.setTimeout(30_000);

describe("detached chat runs in the Hivra guest gateway", () => {
  let home: string;
  let fakeDir: string;
  let fakeAgent: string;
  const gateways: Gateway[] = [];

  function boot(kind: "claude" | "codex" | "generic", extraEnv: Record<string, string> = {}): Promise<Gateway> {
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), kind + "\n");
    let server: http.Server | undefined;
    const sockets = new Set<net.Socket>();
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
        if (["fs", "path", "child_process", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) {
          return realRequire(name);
        }
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: {
        env: {
          HOME: home,
          HIVRA_CHAT_PORT: "0",
          CLAUDE_BIN: fakeAgent,
          CODEX_BIN: fakeAgent,
          FAKE_AGENT_DIR: fakeDir,
          ...extraEnv,
        },
        once: () => undefined,
      },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    return new Promise((resolve) => {
      const ready = () => {
        const gateway: Gateway = {
          port: (created.address() as net.AddressInfo).port,
          server: created,
          close: async () => {
            for (const socket of sockets) socket.destroy();
            if (created.listening) await new Promise<void>((done) => created.close(() => done()));
          },
        };
        gateways.push(gateway);
        resolve(gateway);
      };
      if (created.listening) ready(); else created.once("listening", ready);
    });
  }

  function request(gateway: Gateway, method: string, pathname: string, body?: unknown, auth = true) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port: gateway.port, path: pathname, method, agent: false,
        headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.once("error", reject);
      req.setTimeout(15_000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  // Start a chat turn and return once the first `lines` NDJSON lines arrived,
  // keeping the response open so the caller can drop it like a closed tab.
  function startChat(gateway: Gateway, body: Record<string, unknown>, lines = 2) {
    return new Promise<{ res: IncomingMessage; req: http.ClientRequest; events: Record<string, unknown>[]; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port: gateway.port, path: "/api/chat", method: "POST", agent: false,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      }, (res) => {
        if (res.statusCode !== 200) {
          let text = "";
          res.on("data", (chunk) => { text += chunk; });
          res.once("end", () => reject(new Error(`chat start failed: ${res.statusCode} ${text}`)));
          return;
        }
        const events: Record<string, unknown>[] = [];
        let buffer = "";
        let settled = false;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
            if (line.trim()) events.push(JSON.parse(line));
          }
          if (!settled && events.length >= lines) { settled = true; resolve({ res, req, events, headers: res.headers }); }
        });
        res.on("error", () => undefined);
      });
      req.once("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
      req.end(JSON.stringify(body));
    });
  }

  async function finishedRun(gateway: Gateway, id: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = JSON.parse((await request(gateway, "GET", `/api/chat/runs/${id}`)).body).run;
      if (run.state === "finished" || Date.now() > deadline) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const ndjson = (text: string) => text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
  const runId = () => crypto.randomUUID();
  const marker = (name: string) => path.join(fakeDir, name);
  const argvOf = (tag: string) => JSON.parse(fs.readFileSync(marker(`argv-${tag}.json`), "utf8")) as { argv: string[]; prompt: string; modelKey: string | null };

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-chat-runs-")));
    fakeDir = path.join(home, "fake");
    fs.mkdirSync(fakeDir);
    fs.mkdirSync(path.join(home, ".hivra"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fakeAgent = path.join(home, "fake-agent");
    fs.writeFileSync(fakeAgent, FAKE_AGENT, { mode: 0o755 });
  });

  afterEach(async () => {
    while (gateways.length) await gateways.pop()!.close();
    // Never leave a runner behind if an assertion failed mid-run.
    const runsDir = path.join(home, ".hivra", "chat-runs");
    for (const name of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
      try {
        const status = JSON.parse(fs.readFileSync(path.join(runsDir, name, "status.json"), "utf8"));
        for (const pid of [status.cliPid, status.runnerPid]) if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
      } catch { /* no status */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("keeps a detached turn working after the browser disconnects, and lets a new request replay it", async () => {
    const gateway = await boot("claude");
    const id = runId();
    const chat = await startChat(gateway, { message: "TAG:detached WAIT:1200 do the task", detach: true, runId: id, clientRef: "local-session-1" });

    // The user closes the tab / laptop mid-turn.
    const disconnectedAt = Date.now();
    chat.req.destroy();
    chat.res.destroy();

    // Regression: the gateway used to SIGTERM the CLI here, so the turn never finished.
    const finishedAt = Number(await waitFor(() => fs.existsSync(marker("done-detached")) && fs.readFileSync(marker("done-detached"), "utf8"), 10_000, "turn completion"));
    expect(finishedAt).toBeGreaterThan(disconnectedAt);
    expect(fs.existsSync(marker("term-detached"))).toBe(false);

    expect(chat.headers["x-hivra-run-id"]).toBe(id);
    expect(chat.headers["access-control-expose-headers"]).toContain("X-Hivra-Run-Id");
    expect(chat.events[0]).toEqual({ type: "_run", runId: id, detached: true });
    expect(chat.events[1]).toMatchObject({ type: "system", subtype: "init", session_id: SESSION_ID });

    const run = await finishedRun(gateway, id);
    expect(run).toMatchObject({ runId: id, clientRef: "local-session-1", state: "finished", code: 0, stopped: null, interrupted: false, detached: true, agentSessionId: SESSION_ID });

    // A reconnecting client replays the whole turn, ending with _done.
    const replay = await request(gateway, "GET", `/api/chat/runs/${id}/events`);
    expect(replay.status).toBe(200);
    expect(replay.headers["x-hivra-run-state"]).toBe("finished");
    const events = ndjson(replay.body);
    // stdout and stderr are separate pipes, so only stdout order is defined.
    expect(events.filter((event) => event.type !== "_stderr").map((event) => event.type)).toEqual(["system", "stream_event", "stream_event", "result", "_done"]);
    expect(events).toContainEqual({ type: "_stderr", text: "fake-agent: working on detached\n" });
    expect(events[events.length - 1]).toEqual({ type: "_done", code: 0 });

    const list = JSON.parse((await request(gateway, "GET", "/api/chat/runs")).body).runs;
    expect(list.map((entry: { runId: string }) => entry.runId)).toEqual([id]);
  });

  it("attaches a late viewer to an in-flight run and streams it live to the end", async () => {
    const gateway = await boot("claude");
    const id = runId();
    const chat = await startChat(gateway, { message: "TAG:live WAIT:1500 go", detach: true, runId: id });
    chat.req.destroy(); chat.res.destroy();

    const view = await request(gateway, "GET", `/api/chat/runs/${id}/events`);
    expect(view.headers["x-hivra-run-state"]).toBe("running");
    const events = ndjson(view.body);
    expect(events[0]).toMatchObject({ type: "system", session_id: SESSION_ID });
    expect(events.filter((event) => event.type === "stream_event")).toHaveLength(2);
    expect(events[events.length - 1]).toEqual({ type: "_done", code: 0 });
    expect(fs.existsSync(marker("done-live"))).toBe(true);
  });

  it("stops a detached run only on an explicit Stop, ending the whole CLI", async () => {
    const gateway = await boot("claude");
    const id = runId();
    const chat = await startChat(gateway, { message: "TAG:stopme WAIT:8000 long task", detach: true, runId: id });
    const stopped = await request(gateway, "POST", `/api/chat/runs/${id}/stop`);
    expect(stopped.status).toBe(200);

    const rest = await new Promise<string>((resolve) => {
      let text = "";
      chat.res.on("data", (chunk: string) => { text += chunk; });
      chat.res.once("end", () => resolve(text));
    });
    const events = ndjson(rest);
    expect(events[events.length - 1]).toMatchObject({ type: "_done", code: 143, stopped: "user" });
    expect(fs.existsSync(marker("term-stopme"))).toBe(true);
    expect(fs.existsSync(marker("done-stopme"))).toBe(false);
    const run = JSON.parse((await request(gateway, "GET", `/api/chat/runs/${id}`)).body).run;
    expect(run).toMatchObject({ state: "finished", stopped: "user" });
  });

  it("keeps the historical contract for callers that did not ask for a detached run", async () => {
    // Older dashboards abort the fetch as their Stop; that must still stop.
    const gateway = await boot("claude");
    const chat = await startChat(gateway, { message: "TAG:legacy WAIT:8000 task" });
    const id = chat.events[0].runId as string;
    expect(chat.events[0]).toMatchObject({ type: "_run", detached: false });
    chat.req.destroy(); chat.res.destroy();

    await waitFor(() => fs.existsSync(marker("term-legacy")), 10_000, "legacy disconnect stop");
    const run = await finishedRun(gateway, id);
    expect(run).toMatchObject({ state: "finished", stopped: "disconnect" });
    expect(fs.existsSync(marker("done-legacy"))).toBe(false);
  });

  it("passes the unchanged claude permission flags for every restrict preset", async () => {
    const gateway = await boot("claude");
    const expected: Record<string, string[]> = {
      "": ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"],
      limited: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions", "--disallowedTools", "Bash"],
      readonly: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    };
    for (const [preset, argv] of Object.entries(expected)) {
      const restrictFile = path.join(home, ".hivra", "agent-restrict");
      if (preset) fs.writeFileSync(restrictFile, preset + "\n"); else fs.rmSync(restrictFile, { force: true });
      const tag = `restrict-${preset || "full"}`;
      const done = await request(gateway, "POST", "/api/chat", { message: `TAG:${tag} WAIT:0 hi`, detach: true, runId: runId() });
      expect(ndjson(done.body).pop()).toEqual({ type: "_done", code: 0 });
      expect(argvOf(tag)).toEqual({ argv, prompt: `TAG:${tag} WAIT:0 hi`, pgid: expect.any(Number), modelKey: null });
    }
    // A resumed turn adds only --resume <id>, exactly as before.
    const resumed = await request(gateway, "POST", "/api/chat", { message: "TAG:resume WAIT:0 again", sessionId: SESSION_ID, detach: true, runId: runId() });
    expect(ndjson(resumed.body).pop()).toEqual({ type: "_done", code: 0 });
    expect(argvOf("resume").argv).toEqual([...expected.readonly, "--resume", SESSION_ID]);
  });

  it("passes the unchanged codex sandbox flags and prompt argument", async () => {
    const gateway = await boot("codex", { FAKE_AGENT_PROMPT_VIA_ARG: "1" });
    const cases: Array<[string, string[]]> = [
      ["", ["--dangerously-bypass-approvals-and-sandbox"]],
      ["limited", ["--sandbox", "workspace-write"]],
      ["readonly", ["--sandbox", "read-only"]],
    ];
    for (const [preset, sandbox] of cases) {
      const restrictFile = path.join(home, ".hivra", "agent-restrict");
      if (preset) fs.writeFileSync(restrictFile, preset + "\n"); else fs.rmSync(restrictFile, { force: true });
      const tag = `codex-${preset || "full"}`;
      const message = `TAG:${tag} WAIT:0 hi`;
      const done = await request(gateway, "POST", "/api/chat", { message, detach: true, runId: runId() });
      expect(ndjson(done.body).pop()).toEqual({ type: "_done", code: 0 });
      expect(argvOf(tag).argv).toEqual(["exec", "--json", "--skip-git-repo-check", ...sandbox, "-C", home, message]);
    }
  });

  it("hands a configured model key to the CLI only through its environment", async () => {
    const key = "fixture-private-model-key";
    const gateway = await boot("codex", { FAKE_AGENT_PROMPT_VIA_ARG: "1" });
    const configured = await request(gateway, "POST", "/api/llm", { provider: "venice", baseUrl: "https://api.venice.ai/api/v1", apiKey: key, model: "fixture-model" });
    expect(configured.status).toBe(200);
    const id = runId();
    const done = await request(gateway, "POST", "/api/chat", { message: "TAG:keyed WAIT:0 hi", detach: true, runId: id });
    expect(ndjson(done.body).pop()).toEqual({ type: "_done", code: 0 });
    const seen = argvOf("keyed");
    expect(seen.modelKey).toBe(key);
    expect(seen.argv).toEqual(expect.arrayContaining(['model_providers.venice.env_key="HIVRA_LLM_API_KEY"', 'model_provider="venice"']));
    expect(JSON.stringify(seen.argv)).not.toContain(key);
    const runDir = path.join(home, ".hivra", "chat-runs", id);
    for (const name of fs.readdirSync(runDir)) expect(fs.readFileSync(path.join(runDir, name), "utf8")).not.toContain(key);
    expect(done.body).not.toContain(key);
  });

  // Chat effort: POST /api/chat takes an optional `effort`; the gateway passes it to
  // the two CLI agents when the installed CLI is known to accept it, and says so
  // on GET /api/meta as `chatEffort`.
  const CLAUDE_BASE = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"];
  async function advertised(gateway: Gateway) {
    const meta = JSON.parse((await request(gateway, "GET", "/api/meta")).body) as { chatEffort?: string[] };
    return meta.chatEffort;
  }
  // The gateway probes `<cli> --version` once after it starts; wait for that.
  async function probed(gateway: Gateway) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const meta = JSON.parse((await request(gateway, "GET", "/api/meta")).body) as { agentCli?: { version: string | null } };
      if (meta.agentCli || Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async function chat(gateway: Gateway, tag: string, extra: Record<string, unknown> = {}) {
    const done = await request(gateway, "POST", "/api/chat", { message: `TAG:${tag} WAIT:0 hi`, detach: true, runId: runId(), ...extra });
    expect(ndjson(done.body).pop()).toEqual({ type: "_done", code: 0 });
    return argvOf(tag).argv;
  }

  it("passes a validated effort to claude as --effort and advertises the levels", async () => {
    const gateway = await boot("claude", { FAKE_AGENT_VERSION: "2.1.292 (Claude Code)" });
    await probed(gateway);
    expect(await advertised(gateway)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(await chat(gateway, "cl-none")).toEqual(CLAUDE_BASE);
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(await chat(gateway, `cl-${level}`, { effort: level })).toEqual([...CLAUDE_BASE, "--effort", level]);
    }
    // A resumed turn keeps the effort and adds only --resume <id>.
    expect(await chat(gateway, "cl-resume", { effort: "high", sessionId: SESSION_ID })).toEqual([...CLAUDE_BASE, "--effort", "high", "--resume", SESSION_ID]);
    // The restrict presets are unchanged next to it.
    fs.writeFileSync(path.join(home, ".hivra", "agent-restrict"), "limited\n");
    expect(await chat(gateway, "cl-limited", { effort: "low" })).toEqual([...CLAUDE_BASE, "--disallowedTools", "Bash", "--effort", "low"]);
  });

  it("ignores an effort that is not exactly one of the five levels", async () => {
    const claude = await boot("claude", { FAKE_AGENT_VERSION: "2.1.292 (Claude Code)" });
    await probed(claude);
    const bad: unknown[] = ["ultra", "HIGH", "High", " high", "high ", "", "none", "minimal", "--effort", 3, true, null, ["high"], { level: "high" }];
    for (const [index, value] of bad.entries()) {
      expect(await chat(claude, `bad-${index}`, { effort: value })).toEqual(CLAUDE_BASE);
    }
    // The legacy dashboard flag does nothing either.
    expect(await chat(claude, "legacy-reasoning", { reasoning: true })).toEqual(CLAUDE_BASE);
    await claude.close();
    gateways.splice(gateways.indexOf(claude), 1);
    const codex = await boot("codex", { FAKE_AGENT_PROMPT_VIA_ARG: "1", FAKE_AGENT_VERSION: "codex-cli 0.149.1" });
    await probed(codex);
    for (const [index, value] of ["ultra", "HIGH", "", 3, null].entries()) {
      const argv = await chat(codex, `bad-codex-${index}`, { effort: value });
      expect(argv.join(" ")).not.toContain("model_reasoning_effort");
    }
  });

  it("passes effort to codex as a model_reasoning_effort override on fresh and resumed turns", async () => {
    const gateway = await boot("codex", { FAKE_AGENT_PROMPT_VIA_ARG: "1", FAKE_AGENT_VERSION: "codex-cli 0.149.1" });
    await probed(gateway);
    // Codex stops at xhigh: max is passed as the highest level it is asked for.
    expect(await advertised(gateway)).toEqual(["low", "medium", "high", "xhigh"]);
    const fixed = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
    const none = await chat(gateway, "cx-none");
    expect(none).toEqual(["exec", ...fixed, "-C", home, "TAG:cx-none WAIT:0 hi"]);
    const cases: Array<[string, string]> = [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "xhigh"]];
    for (const [level, passed] of cases) {
      expect(await chat(gateway, `cx-${level}`, { effort: level })).toEqual(
        ["exec", ...fixed, "-c", `model_reasoning_effort="${passed}"`, "-C", home, `TAG:cx-${level} WAIT:0 hi`]);
    }
    const resumed = await chat(gateway, "cx-resume", { effort: "medium", sessionId: SESSION_ID });
    expect(resumed).toEqual(["exec", "resume", ...fixed, "-c", 'model_reasoning_effort="medium"', SESSION_ID, "TAG:cx-resume WAIT:0 hi"]);
    expect(resumed).not.toContain("-C");
  });

  it("keeps the effort override next to the Venice provider overrides", async () => {
    const gateway = await boot("codex", { FAKE_AGENT_PROMPT_VIA_ARG: "1", FAKE_AGENT_VERSION: "codex-cli 0.149.1" });
    await probed(gateway);
    const configured = await request(gateway, "POST", "/api/llm", { provider: "venice", baseUrl: "https://api.venice.ai/api/v1", apiKey: "fixture-private-model-key", model: "fixture-model" });
    expect(configured.status).toBe(200);
    for (const sessionId of [undefined, SESSION_ID]) {
      const tag = sessionId ? "vn-resume" : "vn-fresh";
      const argv = await chat(gateway, tag, { effort: "max", ...(sessionId ? { sessionId } : {}) });
      expect(argv).toEqual(expect.arrayContaining(['model_provider="venice"', 'model_providers.venice.env_key="HIVRA_LLM_API_KEY"', "-m", "fixture-model", 'model_reasoning_effort="xhigh"']));
      expect(argv.filter((arg) => arg.startsWith("model_reasoning_effort"))).toHaveLength(1);
      expect(argv.indexOf('model_reasoning_effort="xhigh"')).toBeGreaterThan(argv.indexOf('model_provider="venice"'));
      expect(argv.indexOf("-c", argv.indexOf('model_provider="venice"') + 1)).toBe(argv.indexOf('model_reasoning_effort="xhigh"') - 1);
      expect(JSON.stringify(argv)).not.toContain("fixture-private-model-key");
    }
  });

  it("advertises chatEffort only for a CLI that accepts it", async () => {
    // Claude Code and Codex at or above the checked versions.
    const claude = await boot("claude", { FAKE_AGENT_VERSION: "2.1.117 (Claude Code)" });
    await probed(claude);
    expect(await advertised(claude)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    await claude.close(); gateways.splice(gateways.indexOf(claude), 1);
    // An older CLI is not asked for effort: its flag list stops before xhigh and a value outside it ends the turn.
    const oldClaude = await boot("claude", { FAKE_AGENT_VERSION: "2.1.100 (Claude Code)" });
    await probed(oldClaude);
    expect(await advertised(oldClaude)).toBeUndefined();
    expect(await chat(oldClaude, "old-claude", { effort: "high" })).toEqual(CLAUDE_BASE);
    await oldClaude.close(); gateways.splice(gateways.indexOf(oldClaude), 1);
    // A CLI whose version could not be read is treated the same way.
    const unknown = await boot("claude");
    await probed(unknown);
    expect(await advertised(unknown)).toBeUndefined();
    expect(await chat(unknown, "unknown-claude", { effort: "high" })).toEqual(CLAUDE_BASE);
    await unknown.close(); gateways.splice(gateways.indexOf(unknown), 1);
    const oldCodex = await boot("codex", { FAKE_AGENT_PROMPT_VIA_ARG: "1", FAKE_AGENT_VERSION: "codex-cli 0.148.0" });
    await probed(oldCodex);
    expect(await advertised(oldCodex)).toBeUndefined();
    expect((await chat(oldCodex, "old-codex", { effort: "high" })).join(" ")).not.toContain("model_reasoning_effort");
    await oldCodex.close(); gateways.splice(gateways.indexOf(oldCodex), 1);
    // Generic agents ignore it entirely.
    fs.writeFileSync(path.join(home, ".hivra", "agent-cmd.json"), JSON.stringify({ bin: fakeAgent, args: ["--flag"], promptVia: "arg" }));
    const generic = await boot("generic", { FAKE_AGENT_PROMPT_VIA_ARG: "1", FAKE_AGENT_VERSION: "9.9.9" });
    expect(await advertised(generic)).toBeUndefined();
    expect(await chat(generic, "generic-effort", { effort: "high" })).toEqual(["--flag", "TAG:generic-effort WAIT:0 hi"]);
  });

  it("refuses a second turn on a conversation that is still running, and guards the run API", async () => {
    const gateway = await boot("claude");
    const first = await startChat(gateway, { message: "TAG:busy WAIT:2000 first", sessionId: SESSION_ID, detach: true, runId: runId() });
    const second = await request(gateway, "POST", "/api/chat", { message: "TAG:busy2 WAIT:0 second", sessionId: SESSION_ID, detach: true, runId: runId() });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({ code: "conversation_busy" });
    expect(fs.existsSync(marker("argv-busy2.json"))).toBe(false);

    expect((await request(gateway, "GET", "/api/chat/runs", undefined, false)).status).toBe(401);
    expect((await request(gateway, "POST", `/api/chat/runs/${first.events[0].runId}/stop`, undefined, false)).status).toBe(401);
    expect((await request(gateway, "GET", "/api/chat/runs/not-a-run/events")).status).toBe(404);
    expect((await request(gateway, "POST", "/api/chat", { message: "x", runId: "../../etc", detach: true })).status).toBe(400);
    first.req.destroy(); first.res.destroy();
  });

  it("survives a gateway restart: the new gateway still streams the in-flight run to the end", async () => {
    // With KillMode=process a restart (runtime update, crash) leaves runners alone.
    const first = await boot("claude");
    const id = runId();
    const chat = await startChat(first, { message: "TAG:restart WAIT:1500 go", detach: true, runId: id });
    chat.req.destroy(); chat.res.destroy();
    await first.close();
    gateways.splice(gateways.indexOf(first), 1);

    const second = await boot("claude");
    const view = await request(second, "GET", `/api/chat/runs/${id}/events`);
    const events = ndjson(view.body);
    expect(events[events.length - 1]).toEqual({ type: "_done", code: 0 });
    expect(fs.existsSync(marker("done-restart"))).toBe(true);
  });

  it("closes out a run whose runner died without a result instead of showing it running forever", async () => {
    const gateway = await boot("claude");
    const id = runId();
    const chat = await startChat(gateway, { message: "TAG:killed WAIT:8000 go", detach: true, runId: id });
    chat.req.destroy(); chat.res.destroy();
    const statusFile = path.join(home, ".hivra", "chat-runs", id, "status.json");
    const status = await waitFor(() => {
      const parsed = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      return parsed.cliPid ? parsed : undefined;
    }, 5000, "runner status");
    // What a service restart without KillMode=process did: kill everything.
    process.kill(-status.cliPid, "SIGKILL");
    process.kill(-status.runnerPid, "SIGKILL");
    await waitFor(() => { try { process.kill(status.runnerPid, 0); return false; } catch { return true; } }, 5000, "runner exit");

    const run = JSON.parse((await request(gateway, "GET", `/api/chat/runs/${id}`)).body).run;
    expect(run).toMatchObject({ state: "finished", interrupted: true, code: null });
    const events = ndjson((await request(gateway, "GET", `/api/chat/runs/${id}/events`)).body);
    expect(events[events.length - 1]).toEqual({ type: "_done", code: null, interrupted: true });
  });

  it("records a service-manager SIGTERM as an interrupted run, not a user stop", async () => {
    // Without the KillMode=process drop-in, stopping the unit signals every
    // process in its cgroup. The runner has no stop marker, so it is shutdown.
    const gateway = await boot("claude");
    const id = runId();
    const chat = await startChat(gateway, { message: "TAG:shutdown WAIT:8000 go", detach: true, runId: id });
    chat.req.destroy(); chat.res.destroy();
    const statusFile = path.join(home, ".hivra", "chat-runs", id, "status.json");
    const status = await waitFor(() => {
      const parsed = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      return parsed.cliPid ? parsed : undefined;
    }, 5000, "runner status");
    process.kill(status.runnerPid, "SIGTERM");
    const run = await finishedRun(gateway, id);
    expect(run).toMatchObject({ state: "finished", stopped: null, interrupted: true });
    const events = ndjson((await request(gateway, "GET", `/api/chat/runs/${id}/events`)).body);
    expect(events[events.length - 1]).toMatchObject({ type: "_done", interrupted: true });
    expect(fs.existsSync(marker("term-shutdown"))).toBe(true);
  });

  it("wraps a generic CLI's plain output as _text through the detached runner", async () => {
    const script = path.join(home, "plain-agent");
    fs.writeFileSync(script, `#!${process.execPath}\nconst fs=require("fs");const p=fs.readFileSync(0,"utf8");process.stdout.write("echo: "+p);process.stderr.write("warn\\n");\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(home, ".hivra", "agent-cmd.json"), JSON.stringify({ bin: script, args: [], promptVia: "stdin" }));
    const gateway = await boot("generic");
    const done = await request(gateway, "POST", "/api/chat", { message: "héllo ✓", detach: true, runId: runId() });
    const events = ndjson(done.body);
    expect(events[0]).toMatchObject({ type: "_run", detached: true });
    expect(events.filter((event) => event.type === "_text").map((event) => event.text).join("")).toBe("echo: héllo ✓");
    expect(events).toContainEqual({ type: "_stderr", text: "warn\n" });
    expect(events[events.length - 1]).toEqual({ type: "_done", code: 0 });
  });
});
