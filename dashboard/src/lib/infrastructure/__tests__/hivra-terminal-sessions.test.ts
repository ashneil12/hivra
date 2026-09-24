import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// The guest gateway's persistent-terminal session API (list + close), evaluated
// from the unmodified server.js with a stubbed tmux so no real process runs.

const TOKEN = "d".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");

type TmuxCall = { args: string[] };

describe("persistent terminal sessions on the guest gateway", () => {
  let home: string;
  let server: http.Server | undefined;
  let port = 0;
  const calls: TmuxCall[] = [];
  let tmuxReply: { error: (Error & { code?: number }) | null; stdout: string; stderr: string } = { error: null, stdout: "", stderr: "" };

  beforeAll(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-terminal-sessions-")));
    fs.mkdirSync(path.join(home, ".hivra"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), "claude\n");
    const realRequire = createRequire(SERVER_PATH);
    vm.runInNewContext(fs.readFileSync(SERVER_PATH, "utf8"), {
      require: (name: string) => {
        if (name === "http") return { ...http, createServer: (handler: http.RequestListener) => (server = http.createServer(handler)) };
        if (name === "child_process") {
          return {
            spawn: () => { throw new Error("no agent process in this test"); },
            execFile: (bin: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
              if (bin !== "tmux") throw new Error(`unexpected command ${bin}`);
              calls.push({ args });
              setImmediate(() => callback(tmuxReply.error, tmuxReply.stdout, tmuxReply.stderr));
            },
          };
        }
        if (["fs", "path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs", "./chat-runs.cjs"].includes(name)) return realRequire(name);
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: { HOME: home, HIVRA_CHAT_PORT: "0" }, once: () => undefined },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server!.listening) await once(server!, "listening");
    port = (server!.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => { calls.length = 0; tmuxReply = { error: null, stdout: "", stderr: "" }; });

  function request(method: string, route: string, body?: unknown, auth = true) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: route, method, agent: false,
        headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), "Content-Type": "application/json" } }, (res) => {
        let text = ""; res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  it("lists the live sessions of one terminal, ignoring anything that is not one of its tabs", async () => {
    tmuxReply = { error: null, stderr: "", stdout: "box-3 0 1790000000\nbox-1 1 1790000100\nbox-9 0 1\nbox-12 0 1\nagent-2 0 1\nnotes 0 1\n" };
    const result = await request("GET", "/api/terminal/sessions?surface=box");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ surface: "box", sessions: [
      { slot: 1, attached: true, createdAt: new Date(1790000100 * 1000).toISOString() },
      { slot: 3, attached: false, createdAt: new Date(1790000000 * 1000).toISOString() },
    ] });
    expect(calls).toEqual([{ args: ["-L", "hivra-box", "list-sessions", "-F", "#{session_name} #{session_attached} #{session_created}"] }]);
  });

  it("reports no sessions when the terminal's tmux server is not running", async () => {
    tmuxReply = { error: Object.assign(new Error("Command failed"), { code: 1 }), stdout: "", stderr: "no server running on /tmp/tmux-1000/hivra-agent\n" };
    const result = await request("GET", "/api/terminal/sessions?surface=agent");
    expect(JSON.parse(result.body)).toEqual({ surface: "agent", sessions: [] });
    expect(calls[0].args.slice(0, 2)).toEqual(["-L", "hivra-agent"]);
  });

  it("closes exactly the named tab's session", async () => {
    const result = await request("POST", "/api/terminal/sessions/close", { surface: "agent", slot: 4 });
    expect(JSON.parse(result.body)).toEqual({ ok: true, closed: true });
    // "=" pins an exact session name so "agent-4" can never match "agent-40".
    expect(calls).toEqual([{ args: ["-L", "hivra-agent", "kill-session", "-t", "=agent-4"] }]);
  });

  it.each([
    [{ surface: "box", slot: 9 }], [{ surface: "box", slot: "1;id" }], [{ surface: "root", slot: 1 }], [{ slot: 1 }],
  ])("rejects a session the dashboard cannot address: %j", async (body) => {
    const result = await request("POST", "/api/terminal/sessions/close", body);
    expect(result.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("requires the computer's credentials", async () => {
    expect((await request("GET", "/api/terminal/sessions?surface=box", undefined, false)).status).toBe(401);
    expect((await request("POST", "/api/terminal/sessions/close", { surface: "box", slot: 1 }, false)).status).toBe(401);
    expect((await request("GET", "/api/terminal/sessions?surface=../x")).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

