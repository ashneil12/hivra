import crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// Pins the box's /api/chat stream endings that HivraChat relies on. The chat
// only treats a turn as complete when the box reports the agent process exited
// 0 (`{type:"_done", code}`, null = killed by a signal). A failed spawn is the
// one path without `_done`: the box writes `_stderr` "spawn error: …" and ends
// the stream, which the adapters map to a terminal failure. (server.js is
// pinned by the immutable provisioner release manifest, so changing that path
// needs a new provisioner release.)

const FIXTURE_TOKEN = "b".repeat(64);

type FakeChild = EventEmitter & {
  pid: number | undefined;
  stdin: EventEmitter & { write: (d: string) => void; end: () => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
};

function fakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = Object.assign(new EventEmitter(), { write: () => undefined, end: () => undefined });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe("hivra-chat /api/chat _done protocol", () => {
  let gateway: http.Server | undefined;
  let port = 0;
  const sockets = new Set<Socket>();
  const spawned: FakeChild[] = [];
  let nextPid: number | undefined = 4242;

  beforeAll(async () => {
    const serverPath = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
    const source = readFileSync(serverPath, "utf8");
    vm.runInNewContext(source, {
      require: (name: string) => {
        switch (name) {
          case "http":
            return {
              ...http,
              createServer: (handler: http.RequestListener) => {
                gateway = http.createServer(handler);
                gateway.on("connection", (s) => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
                return gateway;
              },
            };
          case "fs": return {
            readFileSync: (filename: string) => {
              if (filename === "/home/bux/.hivra/api-token") return FIXTURE_TOKEN;
              throw Object.assign(new Error("Fixture file does not exist"), { code: "ENOENT" });
            },
          };
          case "path": return path;
          case "child_process": return {
            spawn: () => { const c = fakeChild(nextPid); spawned.push(c); return c; },
            execFile: () => { throw new Error("no execFile in this fixture"); },
          };
          case "net": return net;
          case "crypto": return crypto;
          case "./llm-application.js":
          case "./guarded-files.cjs":
          case "./agent-zero-editor.cjs": return createRequire(serverPath)(name);
          default: throw new Error(`Unexpected guest dependency: ${name}`);
        }
      },
      process: { env: { HIVRA_CHAT_PORT: "0", HIVRA_AGENT_KIND: "generic", HIVRA_AGENT_CMD: "/opt/fake-agent" } },
      __dirname: path.dirname(serverPath),
      console: { log: () => undefined, warn: () => undefined, error: () => undefined },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: serverPath, timeout: 2_000 });
    if (!gateway) throw new Error("Guest did not create its HTTP server");
    if (!gateway.listening) await once(gateway, "listening");
    port = (gateway.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => gateway?.close(() => resolve()) ?? resolve());
  });

  // POST a chat turn; `drive` gets the child as soon as the box spawns it.
  function chat(drive: (child: FakeChild) => void): Promise<Record<string, unknown>[]> {
    const before = spawned.length;
    const poll = setInterval(() => {
      if (spawned.length > before) { clearInterval(poll); drive(spawned[spawned.length - 1]); }
    }, 5);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, path: "/api/chat", method: "POST", agent: false,
        headers: { Authorization: `Bearer ${FIXTURE_TOKEN}`, "Content-Type": "application/json" },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.once("end", () => resolve(body.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
        res.once("error", reject);
      });
      req.once("error", reject);
      req.setTimeout(3_000, () => req.destroy(new Error("chat request timed out")));
      req.end(JSON.stringify({ message: "hi", sessionId: null }));
    });
  }

  it("reports a signal kill as _done with a null code after the streamed output", async () => {
    nextPid = 4242;
    const events = await chat((child) => {
      child.stdout.emit("data", Buffer.from("partial"));
      child.emit("close", null);
    });
    expect(events).toEqual([{ type: "_text", text: "partial" }, { type: "_done", code: null }]);
  });

  it("ends a failed spawn with a 'spawn error:' _stderr line and no _done", async () => {
    nextPid = undefined;
    const events = await chat((child) => {
      child.emit("error", Object.assign(new Error("spawn /opt/fake-agent ENOENT"), { code: "ENOENT" }));
    });
    expect(events).toEqual([{ type: "_stderr", text: "spawn error: spawn /opt/fake-agent ENOENT" }]);
  });
});
