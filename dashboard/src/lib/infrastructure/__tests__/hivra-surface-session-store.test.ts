/** @jest-environment node */

// Surface sign-ins across a real gateway restart. Every case runs the
// unmodified guest gateway (provisioner/hivra-chat/server.js) as its own node
// process with a throwaway HOME, stops it the way systemd or a crash does, and
// starts it again on the same HOME. Child processes are refused so no agent CLI
// or shell ever starts on the test machine.

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const TOKEN = "c".repeat(64);
const ROTATED_TOKEN = "d".repeat(64);
const BOX_HOST = "box.hivra.test";
const AUTH_COOKIE = "__Host-hivra_auth";
const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 1024;
const sourcePath = path.resolve("provisioner/hivra-chat/server.js");

type Gateway = { child: ChildProcess; port: number; stderr: () => string };
type StoreEntry = { h: string; e: number };

const digest = (secret: string) => crypto.createHash("sha256").update(secret).digest("hex");
const binding = (token: string) => crypto.createHmac("sha256", token).update("hivra-surface-sessions-v1").digest("hex");
const secretFor = (n: number) => crypto.createHash("sha256").update(`fixture-session-${n}`).digest("hex");

describe("Hivra surface sign-ins across a gateway restart", () => {
  let upstream: http.Server;
  let upstreamPort = 0;
  let root = "";
  let home = "";
  const running = new Set<ChildProcess>();

  const hivraDir = () => path.join(home, ".hivra");
  const storePath = () => path.join(hivraDir(), "surface-sessions.json");
  const readStore = () => JSON.parse(fs.readFileSync(storePath(), "utf8"));
  function writeStore(doc: unknown, file = storePath()) {
    fs.writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  const craftedStore = (epoch: string, sessions: StoreEntry[], token = TOKEN) => ({ v: 1, binding: binding(token), epoch, sessions });

  async function start(): Promise<Gateway> {
    const launcher = `
      const http = require("node:http");
      const create = http.createServer;
      http.createServer = (...args) => {
        const server = create(...args);
        server.once("listening", () => process.send({ port: server.address().port }));
        return server;
      };
      const processes = require("node:child_process");
      processes.spawn = processes.execFile = () => { throw new Error("gateway fixture must not start processes"); };
      require(${JSON.stringify(sourcePath)});
    `;
    const child = spawn(process.execPath, ["-e", launcher], {
      env: {
        NODE_ENV: "test",
        HOME: home,
        HIVRA_CHAT_PORT: "0",
        HIVRA_AGENT_KIND: "generic",
        AEON_DASHBOARD_PORT: String(upstreamPort),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    running.add(child);
    child.once("exit", () => running.delete(child));
    let errors = "";
    child.stderr?.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-4096); });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway did not start: ${errors}`)), 5_000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`gateway exited: ${errors}`)); });
      child.on("message", (message: { port?: number }) => {
        if (message.port) { clearTimeout(timer); resolve(message.port); }
      });
    });
    return { child, port, stderr: () => errors };
  }

  async function stop(gateway: Gateway, signal: NodeJS.Signals = "SIGKILL") {
    if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) return;
    const exited = once(gateway.child, "exit");
    gateway.child.kill(signal);
    await exited;
  }

  function request(port: number, pathname: string, options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, path: pathname, method: options.method ?? "GET", agent: false,
        headers: { Host: BOX_HOST, ...options.headers },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.once("error", reject);
      });
      req.once("error", reject);
      req.setTimeout(3_000, () => req.destroy(new Error("gateway request timed out")));
      req.end(options.body);
    });
  }

  const bootId = async (gateway: Gateway) => JSON.parse((await request(gateway.port, "/api/meta")).body).bootId as string;
  const surfaceStatus = async (gateway: Gateway, secret: string) =>
    (await request(gateway.port, "/aeon/", { headers: { Cookie: `${AUTH_COOKIE}=${secret}` } })).status;

  async function signIn(gateway: Gateway, token = TOKEN): Promise<string> {
    const result = await request(gateway.port, "/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, destination: "/aeon/" }).toString(),
    });
    expect(result.status).toBe(303);
    const match = /^__Host-hivra_auth=([a-f0-9]{64});/.exec(result.headers["set-cookie"]?.[0] ?? "");
    expect(match).not.toBeNull();
    return match![1];
  }

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fixture surface reached");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    upstreamPort = (upstream.address() as AddressInfo).port;
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "hivra-surface-sessions-"));
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(root, "home-"));
    fs.mkdirSync(hivraDir(), { mode: 0o755 });
    fs.chmodSync(hivraDir(), 0o755);
    fs.writeFileSync(path.join(hivraDir(), "api-token"), TOKEN, { mode: 0o600 });
  });

  afterEach(async () => {
    for (const child of running) child.kill("SIGKILL");
    await Promise.all([...running].map((child) => once(child, "exit")));
    try { fs.chmodSync(hivraDir(), 0o755); } catch { /* removed below either way */ }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the same cookie valid and the same bootId across a crash and an ordinary restart", async () => {
    let gateway = await start();
    const epoch = await bootId(gateway);
    expect(epoch).toMatch(/^[a-f0-9]{32}$/);
    const secret = await signIn(gateway);
    expect(await surfaceStatus(gateway, secret)).toBe(200);

    await stop(gateway, "SIGKILL");
    gateway = await start();
    expect(await bootId(gateway)).toBe(epoch);
    expect(await surfaceStatus(gateway, secret)).toBe(200);

    await stop(gateway, "SIGTERM");
    gateway = await start();
    expect(await bootId(gateway)).toBe(epoch);
    expect(await surfaceStatus(gateway, secret)).toBe(200);
    // Still one authority: an unknown or malformed cookie is not a sign-in.
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(401);
    expect(await surfaceStatus(gateway, TOKEN)).toBe(401);
  });

  it("saves only digests and expiry, owner-only, never a cookie or the API token", async () => {
    const gateway = await start();
    const secret = await signIn(gateway);
    const stat = fs.lstatSync(storePath());
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(storePath(), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(TOKEN);
    const doc = JSON.parse(raw);
    expect(doc).toEqual({ v: 1, binding: binding(TOKEN), epoch: await bootId(gateway), sessions: [{ h: digest(secret), e: expect.any(Number) }] });
    expect(doc.sessions[0].e).toBeGreaterThan(Date.now() + TTL_MS - 60_000);
    expect(doc.sessions[0].e).toBeLessThanOrEqual(Date.now() + TTL_MS);
    // Atomic replacement leaves no temp file behind.
    expect(fs.readdirSync(hivraDir()).sort()).toEqual(["api-token", "surface-sessions.json"]);
  });

  it("never accepts a value read from the store as a sign-in cookie, before or after a restart", async () => {
    let gateway = await start();
    const secret = await signIn(gateway);
    const doc = readStore();
    const [saved] = doc.sessions as StoreEntry[];
    expect(saved.h).toBe(digest(secret));
    // Everything the file holds, used as the cookie: the digest, the binding
    // and the epoch. Only the secret the file does not hold signs a surface in.
    const readable = [saved.h, doc.binding as string, doc.epoch as string];

    for (const value of readable) expect(await surfaceStatus(gateway, value)).toBe(401);
    expect(await surfaceStatus(gateway, secret)).toBe(200);

    await stop(gateway);
    gateway = await start();
    expect(await surfaceStatus(gateway, secret)).toBe(200);
    for (const value of readable) expect(await surfaceStatus(gateway, value)).toBe(401);
  });

  it("signs every surface out and starts a new bootId when the API token changes", async () => {
    let gateway = await start();
    const epoch = await bootId(gateway);
    const secret = await signIn(gateway);
    await stop(gateway);

    fs.writeFileSync(path.join(hivraDir(), "api-token"), ROTATED_TOKEN, { mode: 0o600 });
    gateway = await start();
    const rotated = await bootId(gateway);
    expect(rotated).toMatch(/^[a-f0-9]{32}$/);
    expect(rotated).not.toBe(epoch);
    expect(await surfaceStatus(gateway, secret)).toBe(401);
    expect(readStore()).toEqual({ v: 1, binding: binding(ROTATED_TOKEN), epoch: rotated, sessions: [] });
    const renewed = await signIn(gateway, ROTATED_TOKEN);
    expect(await surfaceStatus(gateway, renewed)).toBe(200);
  });

  it.each([
    ["truncated JSON", '{"v":1,"binding":'],
    ["an unknown version", (epoch: string) => ({ ...craftedStore(epoch, []), v: 2 })],
    ["a malformed digest", (epoch: string) => craftedStore(epoch, [{ h: "not-a-digest", e: Date.now() + 60_000 }])],
    ["a duplicated entry", (epoch: string) => craftedStore(epoch, [
      { h: digest(secretFor(1)), e: Date.now() + 60_000 }, { h: digest(secretFor(1)), e: Date.now() + 60_000 }])],
    ["an expiry longer than a fresh sign-in", (epoch: string) => craftedStore(epoch, [{ h: digest(secretFor(1)), e: Date.now() + TTL_MS + 60 * 60 * 1000 }])],
    ["too many entries", (epoch: string) => craftedStore(epoch, Array.from({ length: MAX_SESSIONS + 1 }, (_, n) => ({ h: digest(secretFor(n)), e: Date.now() + 60_000 })))],
  ])("starts a fresh epoch instead of trusting a store with %s", async (_label, content) => {
    const epoch = "e".repeat(32);
    writeStore(typeof content === "string" ? content : content(epoch));
    const gateway = await start();
    const fresh = await bootId(gateway);
    expect(fresh).toMatch(/^[a-f0-9]{32}$/);
    expect(fresh).not.toBe(epoch);
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(401);
    // The untrusted file was replaced by a valid, empty store for the new epoch.
    expect(readStore()).toEqual({ v: 1, binding: binding(TOKEN), epoch: fresh, sessions: [] });
    expect(fs.statSync(storePath()).mode & 0o777).toBe(0o600);
  });

  it("ignores a store another user could have written", async () => {
    const epoch = "e".repeat(32);
    writeStore(craftedStore(epoch, [{ h: digest(secretFor(1)), e: Date.now() + 60_000 }]));
    fs.chmodSync(storePath(), 0o666);
    const gateway = await start();
    expect(await bootId(gateway)).not.toBe(epoch);
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(401);
  });

  it.each([
    ["group-writable", 0o775],
    ["world-writable", 0o777],
  ])("neither loads nor writes a store in a %s ~/.hivra", async (_label, mode) => {
    const epoch = "e".repeat(32);
    // A private, valid store for this token: only the directory is wrong.
    const planted = JSON.stringify(craftedStore(epoch, [{ h: digest(secretFor(1)), e: Date.now() + 60 * 60 * 1000 }]));
    writeStore(planted);
    fs.chmodSync(hivraDir(), mode);
    let gateway = await start();
    const first = await bootId(gateway);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(first).not.toBe(epoch);
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(401);
    // A sign-in works for this process, but nothing is saved into that directory.
    const secret = await signIn(gateway);
    expect(await surfaceStatus(gateway, secret)).toBe(200);
    expect(fs.readFileSync(storePath(), "utf8")).toBe(planted);
    expect(fs.readdirSync(hivraDir()).sort()).toEqual(["api-token", "surface-sessions.json"]);
    expect(gateway.stderr()).toContain("cannot keep sign-ins");

    await stop(gateway);
    gateway = await start();
    // Sign-ins were lost, and the new bootId says so.
    const second = await bootId(gateway);
    expect(second).not.toBe(first);
    expect(second).not.toBe(epoch);
    expect(await surfaceStatus(gateway, secret)).toBe(401);
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(401);
    expect(fs.readFileSync(storePath(), "utf8")).toBe(planted);
  });

  it("honours each sign-in's expiry across a restart and prunes it from the store", async () => {
    const epoch = "e".repeat(32);
    const [expiring, lasting, expired] = [secretFor(1), secretFor(2), secretFor(3)];
    writeStore(craftedStore(epoch, [
      { h: digest(expired), e: Date.now() - 1_000 },
      { h: digest(expiring), e: Date.now() + 1_500 },
      { h: digest(lasting), e: Date.now() + 60 * 60 * 1000 },
    ]));
    let gateway = await start();
    expect(await bootId(gateway)).toBe(epoch);
    expect(await surfaceStatus(gateway, expired)).toBe(401);
    expect(await surfaceStatus(gateway, expiring)).toBe(200);
    expect(await surfaceStatus(gateway, lasting)).toBe(200);
    expect(readStore().sessions.map((entry: StoreEntry) => entry.h)).toEqual([digest(expiring), digest(lasting)]);

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(await surfaceStatus(gateway, expiring)).toBe(401);
    await stop(gateway);
    gateway = await start();
    expect(await bootId(gateway)).toBe(epoch);
    expect(await surfaceStatus(gateway, expiring)).toBe(401);
    expect(await surfaceStatus(gateway, lasting)).toBe(200);
    expect(readStore().sessions.map((entry: StoreEntry) => entry.h)).toEqual([digest(lasting)]);
  });

  it("keeps a sign-in revoked at the bound revoked after a restart", async () => {
    const epoch = "e".repeat(32);
    // A full store; the entry closest to expiry is the one a new sign-in revokes.
    const sessions = Array.from({ length: MAX_SESSIONS }, (_, n) => ({ h: digest(secretFor(n)), e: Date.now() + 60 * 60 * 1000 + n * 1_000 }));
    writeStore(craftedStore(epoch, sessions));
    let gateway = await start();
    expect(await surfaceStatus(gateway, secretFor(0))).toBe(200);
    const fresh = await signIn(gateway);
    expect(await surfaceStatus(gateway, secretFor(0))).toBe(401);
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(200);

    await stop(gateway);
    gateway = await start();
    expect(await bootId(gateway)).toBe(epoch);
    expect(await surfaceStatus(gateway, secretFor(0))).toBe(401);
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(200);
    expect(await surfaceStatus(gateway, fresh)).toBe(200);
    const stored = readStore().sessions as StoreEntry[];
    expect(stored).toHaveLength(MAX_SESSIONS);
    expect(stored.some((entry) => entry.h === digest(secretFor(0)))).toBe(false);
  });

  it("refuses a symlinked store: never reads or writes through it and replaces the link", async () => {
    const epoch = "e".repeat(32);
    const target = path.join(home, "elsewhere.json");
    const planted = JSON.stringify(craftedStore(epoch, [{ h: digest(secretFor(1)), e: Date.now() + 60_000 }]));
    writeStore(planted, target);
    fs.symlinkSync(target, storePath());
    const gateway = await start();
    const fresh = await bootId(gateway);
    expect(fresh).not.toBe(epoch);
    expect(await surfaceStatus(gateway, secretFor(1))).toBe(401);
    const secret = await signIn(gateway);
    expect(fs.readFileSync(target, "utf8")).toBe(planted);
    expect(fs.lstatSync(storePath()).isSymbolicLink()).toBe(false);
    expect(readStore().sessions).toEqual([{ h: digest(secret), e: expect.any(Number) }]);
  });

  it("refuses a symlinked store directory and keeps sign-ins for this process only", async () => {
    const real = path.join(home, "real-hivra");
    fs.renameSync(hivraDir(), real);
    fs.symlinkSync(real, hivraDir());
    let gateway = await start();
    const first = await bootId(gateway);
    const secret = await signIn(gateway);
    expect(await surfaceStatus(gateway, secret)).toBe(200);
    expect(fs.existsSync(path.join(real, "surface-sessions.json"))).toBe(false);
    await stop(gateway);
    gateway = await start();
    // Sign-ins were lost, and the new bootId says so.
    expect(await bootId(gateway)).not.toBe(first);
    expect(await surfaceStatus(gateway, secret)).toBe(401);
  });

  (process.getuid?.() === 0 ? it.skip : it)(
    "moves to a new bootId once when a sign-in cannot be saved while running",
    async () => {
      let gateway = await start();
      const epoch = await bootId(gateway);
      const saved = await signIn(gateway);
      fs.chmodSync(hivraDir(), 0o555);
      const unsaved = await signIn(gateway);
      // The file still lists only `saved` under `epoch`: the live gateway leaves
      // that epoch so the dashboard signs its frames in again.
      const moved = await bootId(gateway);
      expect(moved).not.toBe(epoch);
      expect(await surfaceStatus(gateway, unsaved)).toBe(200);
      // Once: a further unsaved sign-in does not move it again (no reload loop).
      await signIn(gateway);
      expect(await bootId(gateway)).toBe(moved);
      await stop(gateway);

      gateway = await start();
      expect(await bootId(gateway)).not.toBe(moved);
      expect(await surfaceStatus(gateway, saved)).toBe(200);
      expect(await surfaceStatus(gateway, unsaved)).toBe(401);
    },
  );

  (process.getuid?.() === 0 ? it.skip : it)(
    "changes bootId on every restart while the store directory cannot be written",
    async () => {
      let gateway = await start();
      const epoch = await bootId(gateway);
      const secret = await signIn(gateway);
      await stop(gateway);

      fs.chmodSync(hivraDir(), 0o555);
      gateway = await start();
      // The saved sign-in still loads, but nothing new can be saved: this
      // process must not keep an epoch that a later process would find with
      // an older list of sign-ins.
      const readOnly = await bootId(gateway);
      expect(readOnly).not.toBe(epoch);
      expect(await surfaceStatus(gateway, secret)).toBe(200);
      const unsaved = await signIn(gateway);
      expect(await surfaceStatus(gateway, unsaved)).toBe(200);
      await stop(gateway);

      gateway = await start();
      const after = await bootId(gateway);
      expect(after).not.toBe(readOnly);
      expect(await surfaceStatus(gateway, unsaved)).toBe(401);
      expect(gateway.stderr()).toContain("surface sign-in store");
    },
  );
});

describe("Hivra file browser and the saved surface sign-ins", () => {
  it("keeps the store and its temp files out of the file browser", () => {
    const { protectedPath } = createRequire(sourcePath)("./guarded-files.cjs") as { protectedPath: (filename: string) => boolean };
    expect(protectedPath("/home/bux/.hivra/surface-sessions.json")).toBe(true);
    expect(protectedPath("/home/bux/.hivra/.surface-sessions.0011223344556677.tmp")).toBe(true);
    expect(protectedPath("/home/bux/.hivra/agent-kind")).toBe(false);
    expect(protectedPath("/home/bux/notes/surface-sessions.json")).toBe(false);
  });
});
