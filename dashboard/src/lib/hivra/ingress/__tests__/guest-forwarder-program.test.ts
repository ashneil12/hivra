/** @jest-environment node */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GUEST_FORWARDER_FALLBACK_SOURCE,
  GUEST_FORWARDER_LISTEN_PORT,
  GUEST_FORWARDER_PREFIX,
  GUEST_FORWARDER_PROGRAM,
  buildGuestForwarderHostScript,
  parseGuestForwarderOutput,
} from "../guest-forwarder-program";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const hasBash = spawnSync("bash", ["--version"]).status === 0;
const py = hasPython ? describe : describe.skip;
const sh = hasBash ? describe : describe.skip;

// Documentation addresses only (RFC 5737); route files store them in host byte order.
const GW = "192.0.2.1";
const OTHER = "198.51.100.7";
const hexLE = (ip: string) => ip.split(".").map((p) => Number(p).toString(16).padStart(2, "0")).reverse().join("").toUpperCase();
const route = (...gws: string[]) => "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
  + gws.map((gw) => `eth0\t00000000\t${hexLE(gw)}\t0003\t0\t0\t100\t00000000\t0\t0\t0\n`).join("")
  + "eth0\t000200C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n";

describe("guest forwarder program text", () => {
  it("is small, has no NUL byte and nothing host-specific", () => {
    for (const text of [GUEST_FORWARDER_PROGRAM, GUEST_FORWARDER_FALLBACK_SOURCE]) {
      expect(Buffer.byteLength(text)).toBeLessThan(32 * 1024);
      expect(text.includes("\0")).toBe(false);
      expect(text).not.toMatch(/\b10\.\d+\.\d+\.\d+/);
      expect(text).not.toMatch(/\b(?:192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+/);
    }
    expect(GUEST_FORWARDER_LISTEN_PORT).toBe(18080);
    expect(GUEST_FORWARDER_PROGRAM).toContain("IPAddressDeny=any");
    expect(GUEST_FORWARDER_PROGRAM).toContain("--exit-idle-time=60s 127.0.0.1:%d");
  });
});

type Run = { status: number | null; stdout: string; out: Record<string, unknown>; calls: string[] };

py("guest forwarder program, run for real against a fixture root", () => {
  let dir: string;
  let systemdVersion: number;
  let proxyd: boolean;
  let failStart: boolean;
  let port: number;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hivra-ingress-fwd-"));
    systemdVersion = 255; proxyd = true; failStart = false;
    port = 20000 + Math.floor(Math.random() * 20000);
    writeFileSync(path.join(dir, "route"), route(GW));
    writeFileSync(path.join(dir, "tcp"), "  sl  local_address rem_address   st\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const p = (rel: string) => path.join(dir, rel);
  const program = () => {
    // A stub systemctl that logs its calls, and on start/stop of the socket
    // adds or drops a LISTEN line in the fixture /proc/net/tcp.
    const listenLine = `   0: 00000000:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1\n`;
    writeFileSync(p("systemctl"), `#!/bin/bash
echo "$*" >> ${JSON.stringify(p("calls.log"))}
TCP=${JSON.stringify(p("tcp"))}
HDR='  sl  local_address rem_address   st'
case "$*" in
  --version) echo "systemd ${systemdVersion} (test)";;
  "start hivra-ingress.socket") ${failStart ? "exit 1" : `{ echo "$HDR"; printf '%s' '${listenLine}'; } > "$TCP"; touch ${JSON.stringify(p("active"))}`};;
  "stop hivra-ingress.socket"|"disable --now hivra-ingress.socket") echo "$HDR" > "$TCP"; rm -f ${JSON.stringify(p("active"))};;
  "is-active hivra-ingress.socket") if [ -e ${JSON.stringify(p("active"))} ]; then echo active; else echo inactive; exit 3; fi;;
esac
exit 0
`);
    chmodSync(p("systemctl"), 0o755);
    mkdirSync(p("lib-systemd"), { recursive: true });
    if (proxyd) { writeFileSync(p("lib-systemd/systemd-socket-proxyd"), "#!/bin/sh\n"); chmodSync(p("lib-systemd/systemd-socket-proxyd"), 0o755); }
    return GUEST_FORWARDER_PROGRAM
      .replace('UNIT_DIR = "/etc/systemd/system"', `UNIT_DIR = ${JSON.stringify(p("units"))}`)
      .replace('STATE_DIR = "/var/lib/hivra/ingress"', `STATE_DIR = ${JSON.stringify(p("state"))}`)
      .replace('FALLBACK_DIR = "/usr/local/lib/hivra-ingress"', `FALLBACK_DIR = ${JSON.stringify(p("fallback"))}`)
      .replace('ROUTE_FILE = "/proc/net/route"', `ROUTE_FILE = ${JSON.stringify(p("route"))}`)
      .replace('TCP_FILE = "/proc/net/tcp"', `TCP_FILE = ${JSON.stringify(p("tcp"))}`)
      .replace('SYSTEMCTL = "/usr/bin/systemctl"', `SYSTEMCTL = ${JSON.stringify(p("systemctl"))}`)
      .replace('PROXYD = ("/usr/lib/systemd/systemd-socket-proxyd", "/lib/systemd/systemd-socket-proxyd")',
        `PROXYD = (${JSON.stringify(p("lib-systemd/systemd-socket-proxyd"))},)`)
      .replace(`LISTEN_PORT = ${GUEST_FORWARDER_LISTEN_PORT}`, `LISTEN_PORT = ${port}`);
  };
  const run = (...args: string[]): Run => {
    const text = program();
    rmSync(p("calls.log"), { force: true });
    const r = spawnSync("python3", ["-I", "-B", "-c", text, ...args], { encoding: "utf8", timeout: 20_000 });
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(GUEST_FORWARDER_PREFIX)).toBe(true);
    const calls = existsSync(p("calls.log")) ? readFileSync(p("calls.log"), "utf8").trim().split("\n") : [];
    return { status: r.status, stdout: r.stdout, out: JSON.parse(lines[0].slice(GUEST_FORWARDER_PREFIX.length)), calls };
  };
  const unit = (name: string) => readFileSync(p(`units/${name}`), "utf8");

  it("installs the two units, enables the socket and checks it is listening", () => {
    const r = run("install", `${OTHER},${GW}`);
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({ v: 1, op: "install", ok: true, kind: "proxyd", gateway: GW, port, systemd: 255, changed: true });
    expect(parseGuestForwarderOutput(r.stdout.replace(`"port":${port}`, `"port":${GUEST_FORWARDER_LISTEN_PORT}`)))
      .toMatchObject({ refused: false, ok: true, kind: "proxyd", gateway: GW });
    expect(r.calls).toEqual(expect.arrayContaining(["--version", "daemon-reload", "enable hivra-ingress.socket", "start hivra-ingress.socket"]));
    expect(unit("hivra-ingress.socket").replace(String(port), "PORT")).toMatchSnapshot("socket unit");
    expect(unit("hivra-ingress.service").replace(dir, "DIR")).toMatchSnapshot("service unit");
    expect(existsSync(p("fallback/forward.py"))).toBe(false);
    expect(statSync(p("state")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(p("state/forwarder.json"), "utf8")).files).toHaveProperty([p("units/hivra-ingress.socket")]);
  });

  it("is a no-op the second time: nothing written, nothing reloaded or restarted", () => {
    run("install", GW);
    const before = statSync(p("units/hivra-ingress.socket")).mtimeMs;
    const r = run("install", GW);
    expect(r.out).toMatchObject({ ok: true, changed: false });
    expect(r.calls).not.toContain("daemon-reload");
    expect(r.calls).not.toContain("stop hivra-ingress.socket");
    expect(statSync(p("units/hivra-ingress.socket")).mtimeMs).toBe(before);
  });

  it("replaces its own unit when the gateway changes", () => {
    run("install", GW);
    writeFileSync(p("route"), route(OTHER));
    const r = run("install", OTHER);
    expect(r.out).toMatchObject({ ok: true, changed: true, gateway: OTHER });
    expect(unit("hivra-ingress.socket")).toContain(`IPAddressAllow=${OTHER}/32`);
    expect(r.calls).toEqual(expect.arrayContaining(["daemon-reload", "stop hivra-ingress.service", "stop hivra-ingress.socket"]));
  });

  it("refuses to overwrite a unit Hivra did not write", () => {
    mkdirSync(p("units"), { recursive: true });
    writeFileSync(p("units/hivra-ingress.socket"), "[Socket]\nListenStream=18080\n");
    const r = run("install", GW);
    expect(r.out).toMatchObject({ ok: false, reason: "foreign_file", file: "hivra-ingress.socket" });
    expect(readFileSync(p("units/hivra-ingress.socket"), "utf8")).toBe("[Socket]\nListenStream=18080\n");
    expect(existsSync(p("units/hivra-ingress.service"))).toBe(false);
    expect(r.calls).not.toContain("start hivra-ingress.socket");
  });

  it("refuses a unit that was edited after Hivra wrote it", () => {
    run("install", GW);
    writeFileSync(p("units/hivra-ingress.service"), unit("hivra-ingress.service") + "User=root\n");
    writeFileSync(p("route"), route(OTHER));
    expect(run("install", OTHER).out).toMatchObject({ ok: false, reason: "foreign_file", file: "hivra-ingress.service" });
  });

  it.each([
    ["", "gateway_unverified"],
    ["1.2.3", "gateway_unverified"],
    ["192.0.2.1;reboot", "gateway_unverified"],
    ["999.0.2.1", "gateway_unverified"],
    [OTHER, "gateway_mismatch"],
  ])("refuses allowed gateways %j", (arg, reason) => {
    const r = run("install", arg);
    expect(r.out).toMatchObject({ ok: false, reason });
    expect(existsSync(p("units/hivra-ingress.socket"))).toBe(false);
  });

  it.each([
    ["missing", "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n", "gateway_missing"],
    ["ambiguous", route(GW, OTHER), "gateway_ambiguous"],
    ["loopback", route("127.0.0.1"), "gateway_invalid"],
    ["unspecified", route("0.0.0.0"), "gateway_invalid"],
    ["multicast", route("224.0.0.1"), "gateway_invalid"],
    ["link local", route("169.254.1.1"), "gateway_invalid"],
    ["garbage", "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t00000000\tZZZZZZZZ\t0003\t0\t0\t0\t00000000\n", "gateway_invalid"],
  ])("refuses a %s gateway", (_name, routes, reason) => {
    writeFileSync(p("route"), routes);
    expect(run("install", `${GW},127.0.0.1,0.0.0.0,224.0.0.1,169.254.1.1`).out).toMatchObject({ ok: false, reason });
  });

  it("falls back to the stdlib forwarder without systemd-socket-proxyd, or with a systemd too old for --exit-idle-time", () => {
    proxyd = false;
    let r = run("install", GW);
    expect(r.out).toMatchObject({ ok: true, kind: "python" });
    expect(readFileSync(p("fallback/forward.py"), "utf8")).toBe(GUEST_FORWARDER_FALLBACK_SOURCE);
    expect(unit("hivra-ingress.service")).toContain(`ExecStart=/usr/bin/python3 -I -B ${p("fallback/forward.py")} 127.0.0.1 8080`);
    // Back on proxyd: the fallback file it wrote is cleaned up.
    proxyd = true;
    r = run("install", GW);
    expect(r.out).toMatchObject({ ok: true, kind: "proxyd", changed: true });
    expect(existsSync(p("fallback/forward.py"))).toBe(false);
    systemdVersion = 245;
    expect(run("install", GW).out).toMatchObject({ ok: true, kind: "python" });
    systemdVersion = 234;
    expect(run("install", GW).out).toMatchObject({ ok: false, reason: "systemd_too_old" });
  });

  it("stops a new listener that failed to start", () => {
    failStart = true;
    const r = run("install", GW);
    expect(r.out).toMatchObject({ ok: false, reason: "start_failed", rolledBack: true });
    expect(r.calls).toContain("disable --now hivra-ingress.socket");
  });

  it("stops and disables the listener when its firewall is not enforced", async () => {
    // Something accepting on the port from loopback is exactly what the
    // firewall must prevent; the kernel completes the handshake from the backlog.
    const server = createNetServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    try {
      const r = run("install", GW);
      expect(r.out).toMatchObject({ ok: false, reason: "firewall_unenforced", rolledBack: true });
      expect(r.calls).toContain("disable --now hivra-ingress.socket");
    } finally { server.close(); }
  });

  it("keeps an already serving listener running after a failure that is not a security failure", () => {
    run("install", GW);
    writeFileSync(p("route"), route(OTHER));
    failStart = true;
    const r = run("install", OTHER);
    expect(r.out).toMatchObject({ ok: false, reason: "start_failed" });
    expect(r.out.rolledBack).toBeUndefined();
    expect(r.calls).not.toContain("disable --now hivra-ingress.socket");
  });

  it("removes only its own files, and refuses to remove a changed one", () => {
    run("install", GW);
    let r = run("remove");
    expect(r.out).toMatchObject({ op: "remove", ok: true, removed: true });
    expect(r.calls).toEqual(expect.arrayContaining(["disable --now hivra-ingress.socket", "stop hivra-ingress.service", "daemon-reload"]));
    expect(existsSync(p("units/hivra-ingress.socket"))).toBe(false);
    expect(existsSync(p("units/hivra-ingress.service"))).toBe(false);
    expect(existsSync(p("state/forwarder.json"))).toBe(false);
    // Removing again is fine.
    expect(run("remove").out).toMatchObject({ ok: true, removed: false });
    run("install", GW);
    writeFileSync(p("units/hivra-ingress.socket"), "edited\n");
    r = run("remove");
    expect(r.out).toMatchObject({ ok: false, reason: "foreign_file", left: ["hivra-ingress.socket"] });
    expect(readFileSync(p("units/hivra-ingress.socket"), "utf8")).toBe("edited\n");
    expect(existsSync(p("units/hivra-ingress.service"))).toBe(false);
  });

  it("refuses an unknown operation", () => {
    expect(run("start").out).toMatchObject({ ok: false, reason: "usage" });
    expect(run("install").out).toMatchObject({ ok: false, reason: "usage" });
    expect(run("remove", "x").out).toMatchObject({ ok: false, reason: "usage" });
  });
});

py("stdlib fallback forwarder", () => {
  it("forwards a socket-activated connection to the local port", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hivra-ingress-fallback-"));
    const upstream = createHttpServer((_req, res) => { res.end("ok"); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const script = path.join(dir, "forward.py");
    writeFileSync(script, GUEST_FORWARDER_FALLBACK_SOURCE);
    // Stands in for systemd: a listener on fd 3, LISTEN_FDS and LISTEN_PID, then exec.
    const launcher = `import os, socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(16)
print(s.getsockname()[1], flush=True)
if s.fileno() != 3: os.dup2(s.fileno(), 3)
os.set_inheritable(3, True)
os.environ["LISTEN_FDS"] = "1"; os.environ["LISTEN_PID"] = str(os.getpid())
os.execv(sys.executable, [sys.executable, "-I", "-B", ${JSON.stringify(script)}, "127.0.0.1", "${upstreamPort}"])
`;
    const child = spawn("python3", ["-I", "-B", "-c", launcher], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const listenPort = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (d: Buffer) => resolve(Number(d.toString().trim())));
        child.once("exit", () => reject(new Error("forwarder exited")));
      });
      const body = await new Promise<string>((resolve, reject) => {
        httpGet({ host: "127.0.0.1", port: listenPort, path: "/healthz" }, (res) => {
          let text = ""; res.on("data", (c) => { text += c; }); res.on("end", () => resolve(text));
        }).on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      child.kill("SIGKILL");
      upstream.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("guest forwarder host script", () => {
  const target = { vmid: 1234, bindingTag: "hivra-bind-test" };
  it("validates its target and operation", () => {
    expect(() => buildGuestForwarderHostScript({ vmid: 5, bindingTag: "x" }, "install")).toThrow();
    expect(() => buildGuestForwarderHostScript({ vmid: 1234, bindingTag: null }, "install")).toThrow();
    expect(() => buildGuestForwarderHostScript({ vmid: 1234, bindingTag: "a b; reboot" }, "install")).toThrow();
    expect(() => buildGuestForwarderHostScript(target, "start" as never)).toThrow();
    const script = buildGuestForwarderHostScript(target, "install");
    expect(script.includes("\0")).toBe(false);
    expect(script).toContain("set -euo pipefail");
    expect(script).toMatch(/qm\(\) \{ command timeout -k \d+ \d+ qm "\$@" <\/dev\/null; \}/);
    expect(buildGuestForwarderHostScript(target, "remove")).not.toContain("GATEWAYS");
  });
});

sh("guest forwarder host script, run against a stub host", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "hivra-ingress-host-")); mkdirSync(path.join(dir, "bin")); mkdirSync(path.join(dir, "run")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const runHost = (op: "install" | "remove", state: { tags?: string; qmp?: string; bridgeAddrs?: string; guestOut?: string; guestExit?: number } = {}) => {
    const bin = path.join(dir, "bin");
    const guestOut = state.guestOut ?? `${GUEST_FORWARDER_PREFIX}{"v":1,"op":"${op}","ok":true,"ms":5${op === "install" ? `,"kind":"proxyd","gateway":"${GW}","port":18080` : ""}}`;
    writeFileSync(path.join(bin, "qm"), `#!/bin/bash
case "$1" in
  config) echo "tags: ${state.tags ?? "hivra-bind-test"}"; echo "net0: virtio=02:00:00:00:00:01,bridge=vmbrt,firewall=0";;
  status) echo "status: running"; echo "qmpstatus: ${state.qmp ?? "running"}";;
  guest) shift; while [ "$1" != "--" ]; do shift; done; shift; printf '%s\\n' "$@" > ${JSON.stringify(path.join(dir, "argv"))}
    python3 -c 'import json,sys; print(json.dumps({"exited":1,"exitcode":int(sys.argv[2]),"out-data":sys.argv[1]}))' ${JSON.stringify(guestOut)} ${state.guestExit ?? 0};;
esac
`);
    writeFileSync(path.join(bin, "ip"), `#!/bin/bash
${state.bridgeAddrs === undefined ? `echo "5: vmbrt    inet ${GW}/24 brd 192.0.2.255 scope global vmbrt"` : state.bridgeAddrs}
`);
    chmodSync(path.join(bin, "qm"), 0o755); chmodSync(path.join(bin, "ip"), 0o755);
    const script = buildGuestForwarderHostScript({ vmid: 1234, bindingTag: "hivra-bind-test" }, op).replaceAll("/run/", `${dir}/run/`);
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, NODE_ENV: "test" }, timeout: 20_000 });
    const argv = existsSync(path.join(dir, "argv")) ? readFileSync(path.join(dir, "argv"), "utf8").split("\n").filter(Boolean) : [];
    return { ...r, argv, parsed: parseGuestForwarderOutput(r.stdout) };
  };

  it("passes the bridge's own addresses to the guest and relays its one line", () => {
    const r = runHost("install");
    if (!r.parsed) throw new Error(r.stdout + "\n---\n" + r.stderr);
    expect(r.status).toBe(0);
    expect(r.parsed).toMatchObject({ refused: false, op: "install", ok: true, gateway: GW });
    expect(r.argv.slice(0, 3)).toEqual(["/usr/bin/python3", "-I", "-B"]);
    expect(r.argv.slice(-2)).toEqual(["install", GW]);
  });

  it("passes no addresses for a remove", () => {
    const r = runHost("remove");
    expect(r.parsed).toMatchObject({ refused: false, op: "remove", ok: true });
    expect(r.argv[r.argv.length - 1]).toBe("remove");
  });

  it.each([
    [{ tags: "someone-else" }, "binding_mismatch"],
    [{ qmp: "paused" }, "asleep"],
    [{ bridgeAddrs: "" }, "bridge_address_unknown"],
    [{ bridgeAddrs: "exit 1" }, "bridge_address_unknown"],
    [{ guestExit: 3 }, "guest_failed"],
  ])("refuses %j", (state, reason) => {
    const r = runHost("install", state);
    expect(r.status).toBe(0);
    expect(r.parsed).toEqual({ refused: true, reason });
  });
});

describe("parseGuestForwarderOutput", () => {
  const ok = { v: 1, op: "install", ok: true, ms: 3, kind: "proxyd", gateway: GW, port: 18080, changed: false };
  const line = (v: unknown) => `${GUEST_FORWARDER_PREFIX}${JSON.stringify(v)}\n`;
  it("reads a well-formed result and rejects anything else", () => {
    expect(parseGuestForwarderOutput(line(ok))).toEqual({ refused: false, ...ok });
    expect(parseGuestForwarderOutput(line({ v: 1, op: "remove", ok: false, ms: 1, reason: "foreign_file", left: ["hivra-ingress.socket"] })))
      .toMatchObject({ ok: false, reason: "foreign_file" });
    for (const bad of [
      "", "noise\n", line(ok) + line(ok), line({ ...ok, v: 2 }), line({ ...ok, op: "start" }), line({ ...ok, port: 1 }),
      line({ ...ok, extra: 1 }), line({ ...ok, gateway: "x" }), line({ ...ok, kind: "socat" }), line({ v: 1, op: "install", ok: false, ms: 1 }),
      line({ ...ok, reason: "Bad Reason!" }), line({ ...ok, left: ["../x"] }), `${GUEST_FORWARDER_PREFIX}{not json\n`,
      line({ v: 1, op: "install", ok: true, ms: 1 }),
    ]) {
      expect(parseGuestForwarderOutput(bad)).toBeNull();
    }
    expect(parseGuestForwarderOutput("HIVRA_INGRESS_FWD_REFUSED asleep\n")).toEqual({ refused: true, reason: "asleep" });
    expect(parseGuestForwarderOutput("HIVRA_INGRESS_FWD_REFUSED asleep\nHIVRA_INGRESS_FWD_REFUSED x\n")).toBeNull();
  });
});
