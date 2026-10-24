/** @jest-environment node */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readAgentIdleEvidence, readAgentSoftwareFromBox } from "../agent-cli-meta";
import { agentSoftwareSubject, type AgentSoftwareSubject } from "../agent-cli-status";

const HOST = "box-7f3a.hivra.example";
const ORIGIN = `https://${HOST}`;
const TOKEN = "a".repeat(64);
const codex = agentSoftwareSubject({ type: "codex" }) as AgentSoftwareSubject;
const aeon = agentSoftwareSubject({ type: "aeon" }) as AgentSoftwareSubject;
const target = (subject = codex, extra: Record<string, unknown> = {}) => ({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: TOKEN, subject, ...extra });

const CURRENT_META = { agentKind: "codex", model: null, surfaceAuth: "post-cookie-v1", bootId: "95cd11d8e6b99c5b1d212a07568d2d73" };
function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, ...init });
}
function fakeBox(publicMeta: unknown, privateMeta: unknown = publicMeta) {
  return jest.fn(async (_url: string, init?: RequestInit) => {
    const authorized = new Headers(init?.headers).get("authorization") === `Bearer ${TOKEN}`;
    return json(authorized ? privateMeta : publicMeta);
  });
}
const sentBearer = (fetcher: jest.Mock) => fetcher.mock.calls.some(([, init]) => new Headers((init as RequestInit)?.headers).has("authorization"));

describe("readAgentSoftwareFromBox", () => {
  it("reads the version with the bearer only after the public reply proves a current connection service of this kind", async () => {
    const fetcher = fakeBox(CURRENT_META, { ...CURRENT_META, agentCli: { name: "codex", version: "0.149.0", update: { state: "waiting", target: "0.149.1", updatedAt: "2026-09-25T00:30:00Z" } } });
    const reading = await readAgentSoftwareFromBox(target(), fetcher);
    expect(reading).toEqual({ observation: "reported", report: { name: "codex", version: "0.149.0", update: { state: "waiting", target: "0.149.1", updatedAt: "2026-09-25T00:30:00Z", reason: null } } });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${ORIGIN}/api/meta`, `${ORIGIN}/api/meta`]);
    const [first, second] = fetcher.mock.calls.map(([, init]) => init as RequestInit);
    expect(new Headers(first.headers).has("authorization")).toBe(false);
    expect(new Headers(second.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    for (const init of [first, second]) expect(init).toMatchObject({ redirect: "manual", credentials: "omit", cache: "no-store" });
    // The bearer never comes back to the caller.
    expect(JSON.stringify(reading)).not.toContain(TOKEN);
  });

  it.each([
    ["no bootId (older than the release that reports versions)", { agentKind: "codex", surfaceAuth: "post-cookie-v1" }],
    ["no cookie sign-in yet", { agentKind: "codex" }],
    ["a malformed bootId", { ...CURRENT_META, bootId: "not-an-epoch" }],
  ])("treats a connection service with %s as older, without sending the bearer", async (_case, meta) => {
    const fetcher = fakeBox(meta);
    expect(await readAgentSoftwareFromBox(target(), fetcher)).toEqual({ observation: "older_connection_service" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sentBearer(fetcher)).toBe(false);
  });

  it("never sends the bearer to a connection service of another kind", async () => {
    const fetcher = fakeBox({ ...CURRENT_META, agentKind: "claude" });
    expect(await readAgentSoftwareFromBox(target(), fetcher)).toEqual({ observation: "unreachable" });
    expect(sentBearer(fetcher)).toBe(false);
  });

  it("reads an app agent's version from agentApp with the bearer", async () => {
    const commit = "8".repeat(40);
    const fetcher = fakeBox({ ...CURRENT_META, agentKind: "aeon" }, { ...CURRENT_META, agentKind: "aeon", agentApp: { name: "aeon", version: commit, activity: { lastUsedAt: "2026-10-20T10:00:00.000Z", openConnections: 0 } } });
    expect(await readAgentSoftwareFromBox(target(aeon), fetcher)).toEqual({ observation: "reported", report: { name: "aeon", version: commit, update: null } });
    expect(sentBearer(fetcher)).toBe(true);
    expect(await readAgentSoftwareFromBox(target(aeon), fakeBox({ agentKind: "aeon" }))).toEqual({ observation: "older_connection_service" });
  });

  it("says not reported when an app agent's connection service predates app versions, and checking while OpenClaw is first asked", async () => {
    expect(await readAgentSoftwareFromBox(target(aeon), fakeBox({ ...CURRENT_META, agentKind: "aeon" }))).toEqual({ observation: "not_reported" });
    const openclaw = agentSoftwareSubject({ type: "openclaw" }) as AgentSoftwareSubject;
    const meta = { ...CURRENT_META, agentKind: "openclaw" };
    expect(await readAgentSoftwareFromBox(target(openclaw), fakeBox(meta, { ...meta, agentApp: { name: "openclaw", checking: true, activity: {} } }))).toEqual({ observation: "checking" });
    expect(await readAgentSoftwareFromBox(target(openclaw), fakeBox(meta, { ...meta, agentApp: { name: "openclaw", version: "latest" } }))).toEqual({ observation: "version_unreadable" });
  });

  it("is still checking until the connection service has read its version once", async () => {
    expect(await readAgentSoftwareFromBox(target(), fakeBox(CURRENT_META))).toEqual({ observation: "checking" });
  });

  it("passes on an unreadable version and refuses a malformed report", async () => {
    expect(await readAgentSoftwareFromBox(target(), fakeBox(CURRENT_META, { ...CURRENT_META, agentCli: { name: "codex", version: null } })))
      .toEqual({ observation: "reported", report: { name: "codex", version: null, update: null } });
    expect(await readAgentSoftwareFromBox(target(), fakeBox(CURRENT_META, { ...CURRENT_META, agentCli: { name: "codex", version: "latest" } })))
      .toEqual({ observation: "version_unreadable" });
  });

  it.each([
    ["an http origin", { chatUrl: `http://${HOST}` }],
    ["an origin that isn't the named tunnel", { chatUrl: "https://elsewhere.hivra.example" }],
    ["an origin with a path", { chatUrl: `${ORIGIN}/api` }],
    ["a quick tunnel that isn't one", { chatUrl: "https://example.com", cfHostname: null }],
    ["no origin", { chatUrl: null }],
  ])("refuses %s without any request", async (_case, extra) => {
    const fetcher = fakeBox(CURRENT_META);
    expect(await readAgentSoftwareFromBox(target(codex, extra), fetcher)).toEqual({ observation: "unreachable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never sends a malformed bearer", async () => {
    const fetcher = fakeBox(CURRENT_META, { ...CURRENT_META, agentCli: { name: "codex", version: "0.149.1" } });
    expect(await readAgentSoftwareFromBox(target(codex, { apiToken: "box-token" }), fetcher)).toEqual({ observation: "unreachable" });
    expect(sentBearer(fetcher)).toBe(false);
  });

  it.each([
    ["a redirect", () => new Response(null, { status: 302, headers: { Location: "https://evil.example/api/meta" } })],
    ["an error status", () => json({ error: "nope" }, { status: 500 })],
    ["a reply that isn't JSON", () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["an oversized reply", () => json({ ...CURRENT_META, padding: "x".repeat(20_000) })],
    ["a network failure", () => { throw new TypeError("fetch failed"); }],
  ])("reads %s as unreachable", async (_case, reply) => {
    const fetcher = jest.fn(async () => reply());
    expect(await readAgentSoftwareFromBox(target(), fetcher)).toEqual({ observation: "unreachable" });
    expect(sentBearer(fetcher)).toBe(false);
  });

  it("gives up after its deadline", async () => {
    jest.useFakeTimers();
    try {
      const fetcher = jest.fn(() => new Promise<Response>(() => undefined));
      const reading = readAgentSoftwareFromBox(target(), fetcher);
      await jest.advanceTimersByTimeAsync(8_000);
      expect(await reading).toEqual({ observation: "unreachable" });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("readAgentIdleEvidence", () => {
  const idleTarget = { chatUrl: ORIGIN, cfHostname: HOST, apiToken: TOKEN };
  function box(runs: unknown, sessions: unknown) {
    return jest.fn(async (url: string) => json(url.endsWith("/api/chat/runs") ? { runs } : { surface: "agent", sessions }));
  }

  it("counts replies in flight, the newest reply activity and attached agent terminals", async () => {
    const fetcher = box([
      { state: "running", createdAt: "2026-09-25T11:00:00.000Z", startedAt: "2026-09-25T11:00:01.000Z", finishedAt: null },
      { state: "finished", createdAt: "2026-09-25T10:00:00.000Z", finishedAt: "2026-09-25T11:30:00.000Z" },
    ], [{ slot: 1, attached: false }, { slot: 2, attached: true }]);
    expect(await readAgentIdleEvidence(idleTarget, fetcher)).toEqual({
      runningReplies: 1,
      lastReplyActivityAt: Date.parse("2026-09-25T11:30:00.000Z"),
      terminalAttached: true,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${ORIGIN}/api/chat/runs`, `${ORIGIN}/api/terminal/sessions?surface=agent`]);
  });

  it("reports an agent with no replies and no terminals as idle", async () => {
    expect(await readAgentIdleEvidence(idleTarget, box([], []))).toEqual({ runningReplies: 0, lastReplyActivityAt: null, terminalAttached: false });
  });

  it.each([
    ["an unreadable run list", jest.fn(async () => json({ error: "unauthorized" }, { status: 401 }))],
    ["a malformed run list", jest.fn(async (url: string) => json(url.endsWith("/runs") ? { runs: "none" } : { sessions: [] }))],
    ["a failure", jest.fn(async () => { throw new TypeError("fetch failed"); })],
  ])("returns null (busy) for %s", async (_case, fetcher) => {
    expect(await readAgentIdleEvidence(idleTarget, fetcher)).toBeNull();
  });

  it("never asks without a valid bearer and origin", async () => {
    const fetcher = box([], []);
    expect(await readAgentIdleEvidence({ ...idleTarget, apiToken: null }, fetcher)).toBeNull();
    expect(await readAgentIdleEvidence({ ...idleTarget, chatUrl: `http://${HOST}` }, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// The real connection service (provisioner/hivra-chat/server.js) on this
// machine, with a stand-in Codex binary, its update status file and its lock:
// the same replies a computer gives, read through the same reader.
describe("against the real connection service", () => {
  let work: string;
  let gateway: ChildProcess | null = null;
  let port = 0;
  const token = randomBytes(32).toString("hex");
  const localFetch = ((url: string, init?: RequestInit) => fetch(url.replace(ORIGIN, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  const read = () => readAgentSoftwareFromBox({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: token, subject: codex }, localFetch);
  const writeCodex = (version: string, delaySeconds = 0) => {
    const staged = path.join(work, "bin", "codex.next");
    writeFileSync(staged, `#!/bin/sh\n${delaySeconds ? `sleep ${delaySeconds}\n` : ""}echo "codex-cli ${version}"\n`);
    chmodSync(staged, 0o755);
    renameSync(staged, path.join(work, "bin", "codex"));
  };
  const writeStatus = (doc: Record<string, unknown>) => writeFileSync(path.join(work, "state", "agent-cli-update.json"), JSON.stringify(doc));

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), "hivra-agent-cli-meta-"));
    for (const dir of ["home/.hivra", "bin", "state"]) mkdirSync(path.join(work, dir), { recursive: true });
    writeFileSync(path.join(work, "home/.hivra/agent-kind"), "codex\n");
    writeFileSync(path.join(work, "home/.hivra/api-token"), `${token}\n`);
    writeCodex("0.149.0");
    port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    gateway = spawn(process.execPath, [path.join(process.cwd(), "provisioner/hivra-chat/server.js")], {
      env: {
        NODE_ENV: "test", PATH: process.env.PATH, HOME: path.join(work, "home"), HIVRA_CHAT_PORT: String(port),
        CODEX_BIN: path.join(work, "bin", "codex"),
        HIVRA_AGENT_CLI_STATUS: path.join(work, "state", "agent-cli-update.json"),
        HIVRA_AGENT_CLI_LOCK: path.join(work, "state", "agent-cli-update.lock"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the connection service did not start")), 15_000);
      gateway!.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening")) { clearTimeout(timer); resolve(); }
      });
      gateway!.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the connection service exited with ${code}`)); });
    });
  }, 20_000);

  afterAll(() => {
    gateway?.kill();
    rmSync(work, { recursive: true, force: true });
  });

  async function until(predicate: (value: Awaited<ReturnType<typeof read>>) => boolean) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const value = await read();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return read();
  }

  it("reports the installed version once read, and every update state the helper writes", async () => {
    expect(await until((value) => value.observation === "reported")).toEqual({ observation: "reported", report: { name: "codex", version: "0.149.0", update: null } });
    for (const state of ["downloading", "waiting", "installing"]) {
      writeStatus({ name: "codex", state, from: "0.149.0", to: "0.149.1", updatedAt: "2026-09-25T00:30:00Z" });
      expect(await read()).toEqual({ observation: "reported", report: { name: "codex", version: "0.149.0", update: { state, target: "0.149.1", updatedAt: "2026-09-25T00:30:00Z", reason: null } } });
    }
    writeStatus({ name: "codex", state: "rolled_back", from: "0.149.0", to: "0.149.1", updatedAt: "2026-09-25T00:30:00Z", reason: "install_failed" });
    expect(await read()).toMatchObject({ report: { update: { state: "rolled_back", reason: "install_failed" } } });
  }, 20_000);

  it("shows the finished swap with the old version first, then the new one", async () => {
    writeCodex("0.149.1", 1);
    writeStatus({ name: "codex", state: "done", from: "0.149.0", to: "0.149.1", updatedAt: "2026-09-25T00:31:00Z" });
    expect(await read()).toMatchObject({ report: { version: "0.149.0", update: { state: "done", target: "0.149.1" } } });
    expect(await until((value) => value.observation === "reported" && value.report.version === "0.149.1"))
      .toMatchObject({ report: { version: "0.149.1", update: { state: "done", target: "0.149.1" } } });
  }, 20_000);

  it("reads replies and agent terminals for the idle check", async () => {
    expect(await readAgentIdleEvidence({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: token }, localFetch))
      .toEqual({ runningReplies: 0, lastReplyActivityAt: null, terminalAttached: false });
    // Without the bearer the connection service answers 401, which counts as busy.
    expect(await readAgentIdleEvidence({ chatUrl: ORIGIN, cfHostname: HOST, apiToken: "b".repeat(64) }, localFetch)).toBeNull();
  });
});
