/** @jest-environment jsdom */
// End to end: the real chat component against the real guest chat gateway
// (provisioner/hivra-chat/server.js) and its detached runner, with a fake agent
// CLI that speaks `claude -p --output-format stream-json`. A small fetch over
// node:http stands in for the browser's, so "closing the tab" really drops the
// TCP connections the way a browser does.
import { TextDecoder, TextEncoder } from "util";

Object.assign(globalThis, {
  TextDecoder: (globalThis as { TextDecoder?: unknown }).TextDecoder ?? TextDecoder,
  TextEncoder: (globalThis as { TextEncoder?: unknown }).TextEncoder ?? TextEncoder,
});

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import timers from "node:timers";
import { Buffer as NodeBuffer } from "node:buffer";
import { URL as NodeURL, URLSearchParams as NodeURLSearchParams } from "node:url";
import { createRequire } from "node:module";

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { HivraChat } from "../HivraChat";
import { isHiddenWelcomeTitle } from "@/lib/hivra/agent-welcome";

jest.mock("posthog-js", () => ({ __esModule: true, default: { capture: jest.fn() } }));
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/components/markdown/CodeBlock", () => ({ CodeBlock: ({ value }: { value: string }) => <pre>{value}</pre> }));
jest.mock("@/lib/telemetry/posthog-client", () => ({ captureClient: jest.fn() }));
jest.mock("@/lib/client/logger", () => ({ clientLog: { warn: jest.fn() } }));

jest.setTimeout(40_000);

const TOKEN = "c".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

// The stand-in CLI: prints claude stream-json, waits `WAIT:<ms>` from the
// prompt, and leaves markers proving whether the turn finished or was killed.
const FAKE_AGENT = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const dir = process.env.FAKE_AGENT_DIR;
const prompt = (() => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } })();
const tag = (prompt.match(/TAG:([a-z0-9-]+)/) || [, "untagged"])[1];
const wait = Number((prompt.match(/WAIT:(\\d+)/) || [, "0"])[1]);
fs.appendFileSync(path.join(dir, "calls-" + tag), JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.on("SIGTERM", () => { fs.writeFileSync(path.join(dir, "term-" + tag), String(Date.now())); process.exit(143); });
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
out({ type: "system", subtype: "init", session_id: "${SESSION_ID}" });
out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Working on " + tag + "." } } });
setTimeout(() => {
  fs.writeFileSync(path.join(dir, "done-" + tag), String(Date.now()));
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " Finished " + tag + "." } } });
  out({ type: "result", subtype: "success", session_id: "${SESSION_ID}", is_error: false });
  process.exit(0);
}, wait);
`;

type Gateway = { port: number; close: () => Promise<void> };

function pollUntil<T>(probe: () => T | undefined | false | null, timeoutMs = 15_000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value: T | undefined | false | null;
      try { value = probe(); } catch { value = undefined; }
      if (value) return resolve(value as T);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      timers.setTimeout(tick, 50);
    };
    tick();
  });
}

// The subset of fetch the chat uses (ok/status/json/body.getReader), over
// node:http so an aborted signal or a closed tab tears the connection down.
function createBrowserFetch(open: Set<http.ClientRequest>): typeof fetch {
  const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  return ((input: string, init: RequestInit = {}) => new Promise((resolve, reject) => {
    const url = new NodeURL(String(input));
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: init.method || "GET", agent: false,
      headers: (init.headers || {}) as Record<string, string>,
    });
    open.add(req);
    const signal = init.signal;
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => req.destroy(abortError()));
    let responded = false;
    req.once("error", (error) => {
      open.delete(req);
      if (!responded) reject(error.name === "AbortError" ? error : Object.assign(new Error("Failed to fetch"), { name: "TypeError" }));
    });
    req.once("response", (res) => {
      responded = true;
      const queue: Uint8Array[] = [];
      let ended = false;
      let failed: Error | null = null;
      let wake: (() => void) | null = null;
      const notify = () => { const w = wake; wake = null; w?.(); };
      res.on("data", (chunk: Buffer) => { queue.push(new Uint8Array(chunk)); notify(); });
      res.once("end", () => { ended = true; open.delete(req); notify(); });
      res.once("close", () => { if (!ended) failed = abortError(); open.delete(req); notify(); });
      const read = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        while (!queue.length && !ended && !failed) await new Promise<void>((done) => { wake = done; });
        if (queue.length) return { done: false, value: queue.shift() };
        if (failed) throw failed;
        return { done: true, value: undefined };
      };
      const text = async () => {
        const parts: Uint8Array[] = [];
        for (let chunk = await read(); !chunk.done; chunk = await read()) parts.push(chunk.value!);
        return NodeBuffer.concat(parts).toString("utf8");
      };
      const status = res.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: { getReader: () => ({ read }) },
        json: async () => JSON.parse(await text()),
        text,
      } as unknown as Response);
    });
    req.end(typeof init.body === "string" ? init.body : undefined);
  })) as typeof fetch;
}

describe("HivraChat against the real guest chat gateway", () => {
  let home: string;
  let fakeDir: string;
  let fakeAgent: string;
  const gateways: Gateway[] = [];
  const open = new Set<http.ClientRequest>();

  function boot(port = 0): Promise<Gateway> {
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), "claude\n");
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
        return realRequire(name);
      },
      process: {
        env: { HOME: home, HIVRA_CHAT_PORT: String(port), CLAUDE_BIN: fakeAgent, FAKE_AGENT_DIR: fakeDir },
        once: () => undefined,
      },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer: NodeBuffer, URL: NodeURL, URLSearchParams: NodeURLSearchParams,
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setImmediate: timers.setImmediate,
      setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    return new Promise((resolve) => {
      const ready = () => {
        const gateway: Gateway = {
          port: (created.address() as net.AddressInfo).port,
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

  // What closing the tab does to a page: every open connection drops at once.
  function closeTab(unmount: () => void) {
    unmount();
    for (const req of open) req.destroy();
    open.clear();
  }

  const marker = (name: string) => path.join(fakeDir, name);
  const calls = (tag: string) => fs.existsSync(marker(`calls-${tag}`))
    ? fs.readFileSync(marker(`calls-${tag}`), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[] })
    : [];
  async function listRuns(port: number) {
    const res = await createBrowserFetch(new Set())(`http://127.0.0.1:${port}/api/chat/runs`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return ((await res.json()) as { runs: Array<{ runId: string; clientRef: string | null; state: string; title: string; agentSessionId: string | null }> }).runs;
  }

  // Real sockets settle outside React's act(); those warnings are expected here.
  const consoleError = console.error;
  beforeAll(() => {
    jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes("not wrapped in act")) return;
      consoleError(...args);
    });
  });
  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    window.localStorage.clear();
    home =fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-chat-e2e-")));
    fakeDir = path.join(home, "fake");
    fs.mkdirSync(fakeDir);
    fs.mkdirSync(path.join(home, ".hivra"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fakeAgent = path.join(home, "fake-agent");
    fs.writeFileSync(fakeAgent, FAKE_AGENT, { mode: 0o755 });
    global.fetch = createBrowserFetch(open);
  });

  afterEach(async () => {
    for (const req of open) req.destroy();
    open.clear();
    while (gateways.length) await gateways.pop()!.close();
    const runsDir = path.join(home, ".hivra", "chat-runs");
    for (const name of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
      try {
        const status = JSON.parse(fs.readFileSync(path.join(runsDir, name, "status.json"), "utf8"));
        for (const pid of [status.cliPid, status.runnerPid]) if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
      } catch { /* no status */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("keeps the first-task welcome working through a closed tab, re-attaches on reload, and lets the owner continue it", async () => {
    const gateway = await boot();
    const boxUrl = `http://127.0.0.1:${gateway.port}`;
    const chat = () => (
      <HivraChat boxUrl={boxUrl} storageKey="e2e-welcome" token={TOKEN} agentName="Atlas" agentKind="claude" goal="research" firstTask="TAG:welcome WAIT:2500 compare three CRMs" />
    );

    const first = render(chat());
    // The agent is working on the first task on its computer.
    await pollUntil(() => calls("welcome").length === 1, 15_000, "welcome turn to start");
    expect(window.localStorage.getItem("hivra:first-welcome:e2e-welcome")).toBe("1");

    // The owner closes the tab mid-task.
    closeTab(first.unmount);
    const saved = JSON.parse(window.localStorage.getItem("hivra_sessions_e2ewelcome") || "[]") as Array<{ id: string; messages: Array<{ role: string; runId?: string }> }>;
    const welcomeRunId = saved[0]?.messages.find((m) => m.role === "assistant")?.runId;
    expect(welcomeRunId).toBeTruthy();
    expect(saved[0].messages.map((m) => m.role)).toEqual(["assistant"]);

    // The task keeps going on the computer and finishes; nothing killed it.
    await pollUntil(() => fs.existsSync(marker("done-welcome")), 15_000, "welcome turn to finish");
    expect(fs.existsSync(marker("term-welcome"))).toBe(false);

    // Reopening the chat shows the finished result without asking again.
    render(chat());
    expect(await screen.findByText("Working on welcome. Finished welcome.", undefined, { timeout: 15_000 })).toBeInTheDocument();
    expect(calls("welcome")).toHaveLength(1);
    expect(screen.queryByText(/hidden Hivra first-contact/i)).not.toBeInTheDocument();
    const runs = await listRuns(gateway.port);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: welcomeRunId, clientRef: saved[0].id, state: "finished", agentSessionId: SESSION_ID });
    expect(isHiddenWelcomeTitle(runs[0].title)).toBe(true);

    // The welcome is a real conversation: the owner's reply resumes it.
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Message Atlas…"), { target: { value: "TAG:follow WAIT:0 now email me the winner" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(await screen.findByText("Working on follow. Finished follow.", undefined, { timeout: 15_000 })).toBeInTheDocument();
    expect(calls("follow")[0].argv).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
  });

  it("shows a reply another device started, live, on a device that never saw it", async () => {
    const gateway = await boot();
    const boxUrl = `http://127.0.0.1:${gateway.port}`;
    const chat = () => <HivraChat boxUrl={boxUrl} storageKey="e2e-devices" token={TOKEN} agentName="Atlas" agentKind="claude" />;
    // Both devices already had their welcome.
    window.localStorage.setItem("hivra:first-welcome:e2e-devices", "1");

    const phone = render(chat());
    fireEvent.change(await screen.findByPlaceholderText("Message Atlas…"), { target: { value: "TAG:phone WAIT:2500 draft the launch post" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await pollUntil(() => calls("phone").length === 1, 15_000, "phone turn to start");
    closeTab(phone.unmount);

    // A laptop with none of the phone's local state opens the same agent.
    window.localStorage.clear();
    window.localStorage.setItem("hivra:first-welcome:e2e-devices", "1");
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Show chats" }));
    fireEvent.click(await screen.findByText("TAG:phone WAIT:2500 draft the launch post", { selector: "span" }, { timeout: 15_000 }));
    expect(await screen.findByText("Working on phone. Finished phone.", undefined, { timeout: 15_000 })).toBeInTheDocument();
    expect(calls("phone")).toHaveLength(1);
    expect(fs.existsSync(marker("term-phone"))).toBe(false);
  });

  it("carries a reply across a gateway restart on the same address", async () => {
    const firstGateway = await boot();
    const boxUrl = `http://127.0.0.1:${firstGateway.port}`;
    window.localStorage.setItem("hivra:first-welcome:e2e-restart", "1");
    render(<HivraChat boxUrl={boxUrl} storageKey="e2e-restart" token={TOKEN} agentName="Atlas" agentKind="claude" />);
    fireEvent.change(await screen.findByPlaceholderText("Message Atlas…"), { target: { value: "TAG:restart WAIT:2500 keep going" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(await screen.findByText("Working on restart.", undefined, { timeout: 15_000 })).toBeInTheDocument();

    // A runtime update restarts the gateway; the runner keeps the turn going.
    await act(async () => {
      await firstGateway.close();
      await boot(firstGateway.port);
    });
    expect(await screen.findByText("Working on restart. Finished restart.", undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.queryByLabelText("Response failed")).not.toBeInTheDocument();
    expect(fs.existsSync(marker("term-restart"))).toBe(false);
  });
});
