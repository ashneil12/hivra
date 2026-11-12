/** @jest-environment node */
// Runs the host helper itself (python3 -I -B -c) against fake QMP and guest
// agent servers on unix sockets in a temp directory. The helper's paths are
// rewritten to that directory, and its few long waits are shortened, by
// editing the program text; everything else is the program as shipped.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HOST_VM_CONTROL_PREFIX, HOST_VM_CONTROL_PROGRAM, parseVmControlReceipt, type VmControlReceipt,
} from "../host-vm-control-program";

jest.setTimeout(40_000);

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const suite = hasPython ? describe : describe.skip;

const VMID = "1234";
const FIXUP = /^date -s @(\d{10})\.(\d{9}) >\/dev\/null; systemctl kill -s SIGKILL hivra-cf-tunnel; systemctl restart hivra-cf-tunnel$/;

let dir: string;
let bin: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "hivra-vmctl-"));
  bin = path.join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(dir, "lock"));
  const put = (name: string, body: string) => { writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755); };
  put("timeout", `#!/usr/bin/env bash
[ "$1" = "-k" ] && shift 2
echo "timeout $1" >> "$STUB_DIR/calls.log"
shift
exec "$@"
`);
  put("qm", `#!/usr/bin/env bash
echo "qm $*" >> "$STUB_DIR/calls.log"
case "\${QM_MODE:-ok}" in
  ok) echo '{"exited":1,"exitcode":0,"out-data":""}' ;;
  nonzero) echo '{"exited":1,"exitcode":1,"out-data":""}' ;;
  garbage) echo 'not json' ;;
  fail) exit 1 ;;
esac
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function program(edits: Array<[string, string]> = []): string {
  let text = HOST_VM_CONTROL_PROGRAM.replaceAll("/var/run/qemu-server", dir).replaceAll("/run/lock", path.join(dir, "lock"));
  for (const [from, to] of edits) {
    if (!text.includes(from)) throw new Error(`test edit not found: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}

interface Ran { code: number | null; stdout: string; receipt: VmControlReceipt; ms: number; calls: string[] }

function runHelper(args: string[], options: { edits?: Array<[string, string]>; qm?: string } = {}): Promise<Ran> {
  writeFileSync(path.join(dir, "calls.log"), "");
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", "-B", "-c", program(options.edits), ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C", STUB_DIR: dir, QM_MODE: options.qm ?? "ok" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      const receipt = parseVmControlReceipt(stdout);
      if (!receipt) return reject(new Error(`no valid receipt: ${JSON.stringify(stdout)}`));
      resolve({
        code, stdout, receipt, ms: Date.now() - started,
        calls: readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
      });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- fake servers ----------------------------------------------------------

interface Fake {
  server: net.Server;
  opened: () => number;
  closed: () => number;
  close: () => Promise<void>;
}

function listen(file: string, onConnection: (socket: net.Socket, index: number) => void): Promise<Fake> {
  let opened = 0;
  let closed = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    const index = opened++;
    sockets.add(socket);
    socket.on("close", () => { closed += 1; sockets.delete(socket); });
    socket.on("error", () => undefined);
    onConnection(socket, index);
  });
  rmSync(file, { force: true });
  return new Promise((resolve) => {
    server.listen(file, () => resolve({
      server,
      opened: () => opened,
      closed: () => closed,
      close: () => new Promise<void>((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
    }));
  });
}

/** Calls onLine with each complete line the client sends. */
function lines(socket: net.Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      onLine(line);
    }
  });
}

interface QmpOptions {
  status?: string;
  stop?: "ok" | "error" | "noop";
  cont?: "ok" | "error" | "noop";
  /** Async events ahead of every reply, as QEMU sends them. */
  events?: boolean;
  /** Each reply arrives in two writes with a pause between. */
  split?: boolean;
  /** Never sends the greeting. */
  mute?: boolean;
  garbage?: boolean;
  stray?: boolean;
  /** A reply with someone else's id comes before the real one. */
  staleId?: boolean;
}

async function qmpServer(options: QmpOptions = {}) {
  const log: string[] = [];
  const state = { status: options.status ?? "running" };
  const fake = await listen(path.join(dir, `${VMID}.qmp`), (socket) => {
    if (options.mute) return;
    socket.write('{"QMP": {"version": {"qemu": {"major": 9}}, "capabilities": ["oob"]}}\n');
    lines(socket, (line) => {
      const req = JSON.parse(line) as { execute: string; id?: string };
      log.push(req.execute);
      const send = async (obj: Record<string, unknown>) => {
        const text = JSON.stringify({ ...obj, ...(req.id ? { id: req.id } : {}) }) + "\n";
        if (options.events) socket.write('{"timestamp": {"seconds": 1, "microseconds": 1}, "event": "RESUME"}\n');
        if (options.staleId) socket.write('{"return": {}, "id": "someone-else"}\n');
        if (options.garbage) { socket.write("this is not json\n"); return; }
        if (options.stray) { socket.write('{"surprise": 1}\n'); return; }
        if (options.split) { socket.write(text.slice(0, 7)); await sleep(30); socket.write(text.slice(7)); return; }
        socket.write(text);
      };
      if (req.execute === "query-status") {
        void send({ return: { status: state.status, running: state.status === "running", singlestep: false } });
      } else if (req.execute === "stop" || req.execute === "cont") {
        const mode = (req.execute === "stop" ? options.stop : options.cont) ?? "ok";
        if (mode === "error") void send({ error: { class: "GenericError", desc: "refused" } });
        else {
          if (mode === "ok") state.status = req.execute === "stop" ? "paused" : "running";
          void send({ return: {} });
        }
      } else void send({ return: {} });
    });
  });
  return { ...fake, log, state };
}

interface QgaOptions {
  /** The first N connections are closed at once, as a socket with no guest behind it does. */
  closeFirst?: number;
  /** The first N connections are accepted and never answered, as a booting guest does. */
  silentFirst?: number;
  /** The sync answer is held this long. */
  syncDelayMs?: number;
  /** Stale bytes ahead of the sync answer, from an earlier session. */
  stale?: boolean;
  polls?: number;
  exitcode?: number;
  /** guest-exec answers with a QGA error. */
  execError?: boolean;
  /** guest-exec-status never reports exited. */
  neverExits?: boolean;
}

async function qgaServer(options: QgaOptions = {}) {
  const execs: Array<{ path: string; arg: string[]; captureOutput: unknown }> = [];
  const fake = await listen(path.join(dir, `${VMID}.qga`), (socket, index) => {
    if (index < (options.closeFirst ?? 0)) { socket.destroy(); return; }
    if (index < (options.closeFirst ?? 0) + (options.silentFirst ?? 0)) { socket.on("data", () => undefined); return; }
    let polls = 0;
    const out = (obj: unknown) => socket.write(Buffer.concat([Buffer.from([0xff]), Buffer.from(JSON.stringify(obj) + "\n")]));
    lines(socket, (line) => {
      const req = JSON.parse(line) as { execute: string; arguments?: { id: number; path: string; arg: string[]; "capture-output": unknown } };
      if (req.execute === "guest-sync-delimited") {
        const reply = () => {
          if (options.stale) {
            socket.write("garbage from before\n");
            socket.write(Buffer.concat([Buffer.from([0xff]), Buffer.from('{"return": 7}\n')]));
          }
          out({ return: req.arguments!.id });
        };
        if (options.syncDelayMs) setTimeout(reply, options.syncDelayMs); else reply();
      } else if (req.execute === "guest-exec") {
        execs.push({ path: req.arguments!.path, arg: req.arguments!.arg, captureOutput: req.arguments!["capture-output"] });
        if (options.execError) out({ error: { class: "GenericError", desc: "denied" } });
        else out({ return: { pid: 99 } });
      } else if (req.execute === "guest-exec-status") {
        polls += 1;
        if (options.neverExits || polls < (options.polls ?? 1)) out({ return: { exited: false } });
        else out({ return: { exited: true, exitcode: options.exitcode ?? 0 } });
      } else out({ error: { class: "CommandNotFound", desc: "no" } });
    });
  });
  return { ...fake, execs };
}

const settle = () => sleep(150);

// ---- tests -----------------------------------------------------------------

suite("host helper: program shape", () => {
  it("compiles, and is one stdlib-only program", () => {
    const check = spawnSync("python3", ["-I", "-B", "-c", "import sys; compile(sys.stdin.read(), 'p', 'exec')"], { input: HOST_VM_CONTROL_PROGRAM });
    expect(check.status).toBe(0);
    const imports = [...HOST_VM_CONTROL_PROGRAM.matchAll(/^import (.+)$/gm)].flatMap((m) => m[1].split(",").map((n) => n.trim()));
    expect(imports.sort()).toEqual(["errno", "fcntl", "json", "os", "random", "re", "socket", "subprocess", "sys", "time"]);
  });

  it("closes every socket in a finally and bounds every wait", () => {
    expect(HOST_VM_CONTROL_PROGRAM.match(/finally:/g)?.length).toBeGreaterThanOrEqual(4);
    expect(HOST_VM_CONTROL_PROGRAM).toContain("s.close()");
    expect(HOST_VM_CONTROL_PROGRAM).not.toMatch(/makefile\(/);
  });
});

suite("host helper: QMP", () => {
  it.each([
    ["stop", "running", "paused"],
    ["cont", "paused", "running"],
  ])("%s: capabilities, the command, then query-status to confirm", async (action, from, to) => {
    const qmp = await qmpServer({ status: from });
    try {
      const r = await runHelper(["qmp", VMID, action]);
      expect(r.code).toBe(0);
      expect(r.receipt).toMatchObject({ op: "qmp", ok: true, reason: "ok", status: to });
      expect(qmp.log).toEqual(["qmp_capabilities", action, "query-status"]);
      expect(Object.keys(r.receipt.steps)).toEqual(expect.arrayContaining(["connect", "command", "query"]));
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
      expect(r.stdout.startsWith(HOST_VM_CONTROL_PREFIX)).toBe(true);
      expect(r.ms).toBeLessThan(2000);
    } finally { await qmp.close(); }
  });

  it("status only reads: no stop, no cont", async () => {
    const qmp = await qmpServer({ status: "prelaunch" });
    try {
      const r = await runHelper(["qmp", VMID, "status"]);
      expect(r.receipt).toMatchObject({ ok: true, status: "prelaunch" });
      expect(qmp.log).toEqual(["qmp_capabilities", "query-status"]);
    } finally { await qmp.close(); }
  });

  it("skips async events by name, however many come before a reply", async () => {
    const qmp = await qmpServer({ status: "running", events: true });
    try {
      const r = await runHelper(["qmp", VMID, "stop"]);
      expect(r.receipt).toMatchObject({ ok: true, status: "paused" });
    } finally { await qmp.close(); }
  });

  it("ignores a reply that belongs to another command", async () => {
    const qmp = await qmpServer({ status: "running", staleId: true });
    try {
      expect(await runHelper(["qmp", VMID, "stop"])).toMatchObject({ receipt: { ok: true, status: "paused" } });
    } finally { await qmp.close(); }
  });

  it("reads a reply that arrives in pieces", async () => {
    const qmp = await qmpServer({ status: "running", split: true });
    try {
      expect(await runHelper(["qmp", VMID, "stop"])).toMatchObject({ receipt: { ok: true, status: "paused" } });
    } finally { await qmp.close(); }
  });

  it("says unconfirmed when the computer does not end where the command should leave it", async () => {
    const qmp = await qmpServer({ status: "running", stop: "noop" });
    try {
      const r = await runHelper(["qmp", VMID, "stop"]);
      expect(r.receipt).toMatchObject({ ok: false, reason: "unconfirmed", status: "running" });
    } finally { await qmp.close(); }
    const qmp2 = await qmpServer({ status: "paused", cont: "noop" });
    try {
      expect((await runHelper(["qmp", VMID, "cont"])).receipt).toMatchObject({ ok: false, reason: "unconfirmed", status: "paused" });
    } finally { await qmp2.close(); }
  });

  it("reports a command QEMU refuses", async () => {
    const qmp = await qmpServer({ stop: "error" });
    try {
      const r = await runHelper(["qmp", VMID, "stop"]);
      expect(r.receipt).toMatchObject({ ok: false, reason: "qmp_error" });
      expect(qmp.log).toEqual(["qmp_capabilities", "stop"]);
    } finally { await qmp.close(); }
  });

  it.each([
    ["not JSON", { garbage: true }, "protocol"],
    ["an object that is neither a reply nor an event", { stray: true }, "protocol"],
  ])("fails on %s instead of guessing", async (_name, options, reason) => {
    const qmp = await qmpServer(options as QmpOptions);
    try {
      expect((await runHelper(["qmp", VMID, "status"])).receipt).toMatchObject({ ok: false, reason });
    } finally { await qmp.close(); }
  });

  it("gives up at its deadline when QEMU never greets", async () => {
    const qmp = await qmpServer({ mute: true });
    try {
      const r = await runHelper(["qmp", VMID, "stop", "0.6"]);
      expect(r.receipt).toMatchObject({ ok: false, reason: "timeout" });
      expect(r.ms).toBeGreaterThanOrEqual(500);
      expect(r.ms).toBeLessThan(3000);
      await settle();
      expect(qmp.closed()).toBe(qmp.opened());
    } finally { await qmp.close(); }
  });

  it("fails fast when there is no socket, and never retries a missing one", async () => {
    rmSync(path.join(dir, `${VMID}.qmp`), { force: true });
    const r = await runHelper(["qmp", VMID, "stop", "5"]);
    expect(r.receipt).toMatchObject({ ok: false, reason: "socket_missing" });
    expect(r.ms).toBeLessThan(1500);
  });

  it("retries a refused connection for a stop or cont, not for a status read", async () => {
    const file = path.join(dir, `${VMID}.qmp`);
    rmSync(file, { force: true });
    // A socket file with nothing listening refuses connections.
    spawnSync("python3", ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])", file]);
    expect(existsSync(file)).toBe(true);
    const status = await runHelper(["qmp", VMID, "status", "5"]);
    expect(status.receipt).toMatchObject({ ok: false, reason: "socket_error" });
    expect(status.ms).toBeLessThan(1500);

    const pending = runHelper(["qmp", VMID, "cont", "5"]);
    await sleep(400);
    const qmp = await qmpServer({ status: "paused" });
    try {
      const r = await pending;
      expect(r.receipt).toMatchObject({ ok: true, status: "running" });
    } finally { await qmp.close(); }
  });

  it("closes its socket on success and on failure", async () => {
    for (const options of [{}, { stop: "error" }, { garbage: true }] as QmpOptions[]) {
      const qmp = await qmpServer(options);
      try {
        await runHelper(["qmp", VMID, "stop"]);
        await settle();
        expect(qmp.opened()).toBe(1);
        expect(qmp.closed()).toBe(1);
      } finally { await qmp.close(); }
    }
  });

  it.each([
    [["qmp"]],
    [["qmp", "12", "stop"]],
    [["qmp", "1234; reboot", "stop"]],
    [["qmp", VMID, "quit"]],
    [["qmp", VMID, "stop", "0"]],
    [["qmp", VMID, "stop", "soon"]],
    [["fixup", VMID]],
    [["fixup", VMID, "9999"]],
    [["rm", VMID]],
    [[]],
  ])("refuses bad arguments %j with a usage receipt", async (args) => {
    const r = await runHelper(args);
    expect(r.code).toBe(0);
    expect(r.receipt).toMatchObject({ ok: false, reason: "usage" });
  });
});

suite("host helper: guest fixup", () => {
  it("syncs, then runs ONE guest exec of /bin/sh -c with the host clock, and reads its exit", async () => {
    const qga = await qgaServer({ polls: 3 });
    try {
      const before = Date.now();
      const r = await runHelper(["fixup", VMID, "5"]);
      const after = Date.now();
      expect(r.receipt).toMatchObject({ op: "fixup", ok: true, reason: "ok", via: "socket", tries: 1, exitcode: 0 });
      expect(Object.keys(r.receipt.steps)).toEqual(expect.arrayContaining(["lock", "agent", "exec"]));
      expect(qga.execs).toHaveLength(1);
      expect(qga.execs[0].path).toBe("/bin/sh");
      expect(qga.execs[0].captureOutput).toBe(false);
      expect(qga.execs[0].arg[0]).toBe("-c");
      const m = FIXUP.exec(qga.execs[0].arg[1]);
      expect(m).not.toBeNull();
      const epochMs = Number(m![1]) * 1000 + Number(m![2]) / 1e6;
      expect(epochMs).toBeGreaterThanOrEqual(before - 5);
      expect(epochMs).toBeLessThanOrEqual(after + 5);
      expect(r.calls).toEqual([]);
    } finally { await qga.close(); }
  });

  it("takes the host epoch right before the exec, after the sync", async () => {
    const qga = await qgaServer({ syncDelayMs: 500 });
    try {
      const started = Date.now();
      await runHelper(["fixup", VMID, "5"]);
      const m = FIXUP.exec(qga.execs[0].arg[1])!;
      // Not when the program started: after the half second the sync took.
      expect(Number(m[1]) * 1000 + Number(m[2]) / 1e6).toBeGreaterThanOrEqual(started + 450);
    } finally { await qga.close(); }
  });

  it("discards stale bytes before the sync answer", async () => {
    const qga = await qgaServer({ stale: true });
    try {
      expect((await runHelper(["fixup", VMID, "5"])).receipt).toMatchObject({ ok: true, via: "socket", tries: 1 });
    } finally { await qga.close(); }
  });

  it("retries until the agent answers, after a restore", async () => {
    const qga = await qgaServer({ closeFirst: 3 });
    try {
      const r = await runHelper(["fixup", VMID, "5"]);
      expect(r.receipt).toMatchObject({ ok: true, via: "socket", tries: 4 });
      expect(qga.execs).toHaveLength(1);
      await settle();
      expect(qga.closed()).toBe(qga.opened());
    } finally { await qga.close(); }
  });

  it("closes the sockets of attempts the agent never answered (no leak in the retry loop)", async () => {
    const qga = await qgaServer({ silentFirst: 2 });
    try {
      const r = await runHelper(["fixup", VMID, "6"]);
      expect(r.receipt).toMatchObject({ ok: true, tries: 3 });
      await settle();
      expect(qga.opened()).toBe(3);
      expect(qga.closed()).toBe(3);
    } finally { await qga.close(); }
  });

  it("falls back to a timeout-wrapped qm guest exec when the socket never works", async () => {
    const qga = await qgaServer({ closeFirst: 1000 });
    try {
      const r = await runHelper(["fixup", VMID, "1"]);
      expect(r.receipt).toMatchObject({ ok: true, via: "qm" });
      expect(r.receipt.tries).toBeGreaterThan(1);
      expect(r.calls[0]).toMatch(/^timeout \d+$/);
      const call = r.calls.find((c) => c.startsWith("qm "))!;
      expect(call).toMatch(new RegExp(`^qm guest exec ${VMID} --timeout 12 -- /bin/sh -c date -s @\\d{10}\\.\\d{9} `));
      expect(call).toContain("systemctl kill -s SIGKILL hivra-cf-tunnel; systemctl restart hivra-cf-tunnel");
      expect(Object.keys(r.receipt.steps)).toContain("fallback");
    } finally { await qga.close(); }
  });

  it("falls back when there is no socket at all", async () => {
    rmSync(path.join(dir, `${VMID}.qga`), { force: true });
    const r = await runHelper(["fixup", VMID, "1"]);
    expect(r.receipt).toMatchObject({ ok: true, via: "qm" });
  });

  it("says agent_timeout when neither path reaches the guest agent", async () => {
    const qga = await qgaServer({ closeFirst: 1000 });
    try {
      for (const qm of ["fail", "garbage", "nonzero"]) {
        const r = await runHelper(["fixup", VMID, "1"], { qm });
        // A non-zero guest exit through the CLI is still a result, so it reads as the tunnel failing.
        expect(r.receipt).toMatchObject(qm === "nonzero"
          ? { ok: false, reason: "tunnel_failed", via: "qm", exitcode: 1 }
          : { ok: false, reason: "agent_timeout", via: "none" });
        expect(r.ms).toBeLessThan(6000);
      }
    } finally { await qga.close(); }
  });

  it("says fixup_failed when the agent answered but every exec was refused", async () => {
    const qga = await qgaServer({ execError: true });
    try {
      const r = await runHelper(["fixup", VMID, "1"], { qm: "fail" });
      expect(r.receipt).toMatchObject({ ok: false, reason: "fixup_failed" });
    } finally { await qga.close(); }
  });

  it("reports a failing command as tunnel_failed without running it again", async () => {
    const qga = await qgaServer({ exitcode: 3 });
    try {
      const r = await runHelper(["fixup", VMID, "5"]);
      expect(r.receipt).toMatchObject({ ok: false, reason: "tunnel_failed", via: "socket", tries: 1, exitcode: 3 });
      expect(qga.execs).toHaveLength(1);
      expect(r.calls).toEqual([]);
    } finally { await qga.close(); }
  });

  it("gives up on a command that never exits, and does not run it a second time through the CLI", async () => {
    const qga = await qgaServer({ neverExits: true });
    try {
      const r = await runHelper(["fixup", VMID, "5"], { edits: [["EXEC_TIMEOUT = 12.0", "EXEC_TIMEOUT = 0.5"]] });
      expect(r.receipt).toMatchObject({ ok: false, reason: "exec_timeout" });
      expect(qga.execs).toHaveLength(1);
      expect(r.calls).toEqual([]);
      await settle();
      expect(qga.closed()).toBe(qga.opened());
    } finally { await qga.close(); }
  });

  describe("per-VM lock", () => {
    const lockFile = () => path.join(dir, "lock", `hivra-qga-${VMID}.lock`);
    /** Holds the flock for a while, as another guest agent user would. */
    function holdLock(seconds: number): Promise<{ stop: () => void }> {
      return new Promise((resolve) => {
        const child = spawn("python3", ["-c", `
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print("held", flush=True)
time.sleep(float(sys.argv[2]))
`, lockFile(), String(seconds)], { stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.once("data", () => resolve({ stop: () => child.kill("SIGKILL") }));
      });
    }

    it("waits for another holder, then runs", async () => {
      const qga = await qgaServer();
      const holder = await holdLock(0.8);
      try {
        const r = await runHelper(["fixup", VMID, "5"]);
        expect(r.receipt).toMatchObject({ ok: true, via: "socket" });
        expect(r.receipt.steps.lock).toBeGreaterThanOrEqual(500);
      } finally { holder.stop(); await qga.close(); }
    });

    it("does not touch the socket when the lock stays busy", async () => {
      const qga = await qgaServer();
      const holder = await holdLock(5);
      try {
        const r = await runHelper(["fixup", VMID, "5"], { edits: [["LOCK_WAIT = 5.0", "LOCK_WAIT = 0.4"]] });
        expect(r.receipt).toMatchObject({ ok: false, reason: "qga_lock_busy", via: "none", tries: 0 });
        expect(qga.opened()).toBe(0);
        expect(r.calls).toEqual([]);
      } finally { holder.stop(); await qga.close(); }
    });

    it("releases the lock when it is done, whatever the outcome", async () => {
      for (const options of [{}, { exitcode: 1 }] as QgaOptions[]) {
        const qga = await qgaServer(options);
        try {
          await runHelper(["fixup", VMID, "5"]);
          const probe = spawnSync("python3", ["-c", `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
`, lockFile()]);
          expect(probe.status).toBe(0);
        } finally { await qga.close(); }
      }
    });
  });
});

describe("parseVmControlReceipt", () => {
  const line = (row: unknown) => `${HOST_VM_CONTROL_PREFIX}${JSON.stringify(row)}\n`;
  const good = { op: "fixup", ok: true, reason: "ok", ms: 120, steps: { lock: 1, agent: 40 }, via: "socket", tries: 2, exitcode: 0 };

  it("reads a good receipt, with noise around it", () => {
    expect(parseVmControlReceipt(`noise\n${line(good)}`)).toMatchObject({ ok: true, via: "socket", tries: 2, steps: { agent: 40 } });
    expect(parseVmControlReceipt(line({ op: "qmp", ok: true, reason: "ok", ms: 3, steps: {}, status: "paused" }))).toMatchObject({ status: "paused", via: null });
  });

  it.each([
    ["nothing", ""],
    ["two lines", line(good) + line(good)],
    ["not JSON", `${HOST_VM_CONTROL_PREFIX}{oops`],
    ["an array", `${HOST_VM_CONTROL_PREFIX}[]`],
    ["ok as a string", line({ ...good, ok: "true" })],
    ["a loud reason", line({ ...good, reason: "Not OK" })],
    ["a negative time", line({ ...good, ms: -1 })],
    ["a bad step name", line({ ...good, steps: { "Agent!": 1 } })],
    ["a string step", line({ ...good, steps: { agent: "1" } })],
    ["a bad via", line({ ...good, via: "ssh" })],
    ["a bad status", line({ ...good, status: "Running Now" })],
    ["a bad exit code", line({ ...good, exitcode: 999 })],
  ])("rejects %s", (_name, stdout) => {
    expect(parseVmControlReceipt(stdout)).toBeNull();
  });
});
