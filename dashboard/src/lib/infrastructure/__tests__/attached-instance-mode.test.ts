import { once } from "node:events";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// The attached agent's own hivra-chat instance (design 5.4; spikes S3 and S4;
// threats T13, T27, T33). The complete, unmodified server.js runs in attached
// mode as the agent would: its token from the root-owned attachment folder,
// its HOME its own, new and resumed Codex sessions in its root-owned starting
// folder, and only the chat route allowlist.

const INSTALLATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTANCE_TOKEN = "a".repeat(64);
const COMPUTER_TOKEN = "e".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const WORKDIR = `/var/lib/hivra/agent-views/${INSTALLATION}`;

type Started = { bin: string; args: string[]; cwd: string };

describe("attached hivra-chat instance", () => {
  let root: string;
  let home: string;
  let started: Started[] = [];
  const servers: http.Server[] = [];

  function boot(env: Record<string, string> = {}): Promise<number> {
    let server: http.Server | undefined;
    const realRequire = createRequire(SERVER_PATH);
    const realFs = realRequire("fs") as typeof fs;
    const redirect = (p: unknown) => typeof p === "string" && p.startsWith("/etc/hivra") ? path.join(root, p.slice(1)) : p;
    const fsShim = new Proxy(realFs, { get(target, key) {
      if (key === "readFileSync") return (p: unknown, ...rest: unknown[]) => realFs.readFileSync(redirect(p) as string, ...(rest as []));
      return (target as unknown as Record<string, unknown>)[key as string];
    } });
    const chatRuns = {
      ChatRunError: class ChatRunError extends Error { status = 409; code = "x"; },
      createChatRunStore: () => ({
        start: (spec: Started) => { started.push({ bin: spec.bin, args: spec.args, cwd: spec.cwd }); return { record: { meta: { runId: "run-1", detached: false } } }; },
        stream: (_id: string, res: http.ServerResponse) => res.end(),
        list: () => [], get: () => null, stop: () => false,
      }),
    };
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") return { ...http, createServer: (handler: http.RequestListener) => {
          server = http.createServer(handler);
          // Socket activation passes fd 3; the test listens on a free port instead.
          const listen = server.listen.bind(server);
          (server as unknown as { listen: (...args: unknown[]) => http.Server }).listen = (...args: unknown[]) =>
            listen(0, "127.0.0.1", typeof args[args.length - 1] === "function" ? args[args.length - 1] as () => void : undefined);
          return server;
        } };
        if (name === "fs") return fsShim;
        if (name === "child_process") return { spawn: () => { throw new Error("no process"); }, execFile: () => { throw new Error("no process"); } };
        if (name === "./chat-runs.cjs") return chatRuns;
        if (["path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { pid: 4242, env: { HOME: home, HIVRA_AGENT_KIND: "codex", HIVRA_ATTACHED_INSTALLATION_ID: INSTALLATION,
        HIVRA_AGENT_WORKDIR: WORKDIR, HIVRA_API_TOKEN_FILE: `/etc/hivra/attachments/${INSTALLATION}/instance-token`,
        CODEX_HOME: path.join(home, ".codex"), CODEX_BIN: "/opt/hivra/agent-installations/x/codex", PATH: "/usr/bin:/bin",
        LISTEN_PID: "4242", LISTEN_FDS: "1", ...env }, once: () => undefined, getuid: () => process.getuid!() },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate, setInterval, clearInterval,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("instance did not start");
    servers.push(server);
    const created = server;
    return created.listening ? Promise.resolve((created.address() as AddressInfo).port)
      : once(created, "listening").then(() => (created.address() as AddressInfo).port);
  }

  function request(port: number, method: string, pathname: string, headers: Record<string, string>, body?: string):
    Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, agent: false, headers: { Host: "localhost", ...headers } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.once("error", reject);
      req.setTimeout(4000, () => req.destroy(new Error("timed out")));
      req.end(body);
    });
  }

  beforeEach(() => {
    // realpath: the model settings store refuses a folder reached through a link (macOS /tmp).
    root = fs.realpathSync(fs.mkdtempSync("/tmp/hvi-"));
    home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    const folder = path.join(root, "etc/hivra/attachments", INSTALLATION);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "instance-token"), INSTANCE_TOKEN);
    started = [];
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates its own CODEX_HOME, which Codex needs and a fresh home lacks (spike S4)", async () => {
    await boot();
    expect(fs.statSync(path.join(home, ".codex")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(home, ".codex")).mode & 0o777).toBe(0o700);
  });

  it("refuses to start without its root-owned token file, or with a CODEX_HOME outside its home", () => {
    fs.rmSync(path.join(root, "etc/hivra/attachments", INSTALLATION, "instance-token"));
    expect(() => boot()).toThrow(/token/i);
    fs.writeFileSync(path.join(root, "etc/hivra/attachments", INSTALLATION, "instance-token"), INSTANCE_TOKEN);
    expect(() => boot({ CODEX_HOME: "/etc/hivra" })).toThrow(/own home/);
    expect(() => boot({ HIVRA_API_TOKEN_FILE: path.join(home, "token") })).toThrow(/token/i);
    expect(() => boot({ LISTEN_PID: "1" })).toThrow(/socket systemd passes/);
  });

  it("answers only its own bearer, never the computer's (T13), and says which installation it is", async () => {
    const port = await boot();
    const meta = await request(port, "GET", "/api/meta", {});
    expect(JSON.parse(meta.body).attachment).toEqual({ installationId: INSTALLATION });
    expect((await request(port, "GET", "/api/llm", { Authorization: `Bearer ${COMPUTER_TOKEN}` })).status).toBe(401);
    expect((await request(port, "GET", "/api/llm", { Authorization: `Bearer ${INSTANCE_TOKEN}` })).status).toBe(200);
  });

  it("serves only the chat allowlist: no files, Git, terminals, browser or documents", async () => {
    const port = await boot();
    for (const [method, route] of [["GET", "/api/files"], ["GET", "/api/git/status"], ["GET", "/terminal/"], ["GET", "/box-terminal/"],
      ["POST", "/api/browser/toggle"], ["GET", "/"], ["GET", "/app.js"], ["GET", "/api/skills"]] as Array<[string, string]>) {
      const result = await request(port, method, route, { Authorization: `Bearer ${INSTANCE_TOKEN}` });
      expect([route, result.status]).toEqual([route, 404]);
    }
  });

  it("keeps model keys in the agent's own home, never in ~/Hivra (T27)", async () => {
    const port = await boot();
    const result = await request(port, "POST", "/api/llm", { Authorization: `Bearer ${INSTANCE_TOKEN}`, "Content-Type": "application/json" },
      JSON.stringify({ provider: "venice", baseUrl: "https://api.example.test/v1", apiKey: "stub-key-000000", model: "m1" }));
    expect(result.status).toBe(200);
    expect(fs.existsSync(path.join(home, ".hivra", "llm-provider.json"))).toBe(true);
  });

  it("starts new and resumed Codex sessions in its root-owned starting folder, with its instructions pinned on (spike S3, T33)", async () => {
    const port = await boot();
    const auth = { Authorization: `Bearer ${INSTANCE_TOKEN}`, "Content-Type": "application/json" };
    await request(port, "POST", "/api/chat", auth, JSON.stringify({ message: "hello" }));
    await request(port, "POST", "/api/chat", auth, JSON.stringify({ message: "again", sessionId: "01a0d394-495b-75e1-8ca8-2c2954662b9b" }));
    expect(started).toHaveLength(2);
    const [fresh, resumed] = started;
    expect(fresh.cwd).toBe(WORKDIR);
    expect(fresh.args[0]).toBe("exec");
    expect(fresh.args.slice(-3, -1)).toEqual(["-C", WORKDIR]);
    expect(fresh.args.join(" ")).toContain("-c project_doc_max_bytes=32768");
    // Resume takes its folder from -C before `resume`, never from the session file the agent can edit.
    expect(resumed.cwd).toBe(WORKDIR);
    expect(resumed.args.slice(0, 4)).toEqual(["exec", "-C", WORKDIR, "resume"]);
    expect(resumed.args.join(" ")).toContain("-c project_doc_max_bytes=32768");
  });
});
