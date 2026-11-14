/** @jest-environment node */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MATRIX_PUSH_APP_ID,
  MATRIX_PUSHER_GUEST_PROGRAM,
  MATRIX_PUSHER_PREFIX,
  MATRIX_PUSHER_REFUSED_PREFIX,
  buildMatrixPusherHostScript,
  buildMatrixPusherPayload,
  matrixPushUrl,
  matrixPushkey,
  parseMatrixPusherOutput,
  verifyMatrixPushkey,
} from "../adapters/matrix-pusher-program";
import { MATRIX_CHANNEL_SPEC, channelFpsPython } from "../registry";
import { buildSleepHostScript } from "../../agent-sleep-scripts";
import { TELEGRAM_ENV_VALUE_PY } from "../../sleep/idle-probe-program";

const SIGNING = "s".repeat(40);
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const ARM = "00000000-0000-4000-8000-0000000b0001";
const OTHER_ARM = "00000000-0000-4000-8000-0000000b0002";

describe("pushkey", () => {
  it("names the agent and the opt-in and verifies only with the right HMAC", () => {
    const key = matrixPushkey(SIGNING, AGENT, ARM);
    expect(key).toMatch(/^v1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f]{64}$/);
    expect(key.length).toBeLessThanOrEqual(512);
    expect(verifyMatrixPushkey(SIGNING, key)).toEqual({ agentId: AGENT, armId: ARM });
    expect(matrixPushkey(SIGNING, AGENT.toUpperCase(), ARM)).toBe(key);
  });

  it("refuses a forged, re-pointed, malformed or differently keyed pushkey", () => {
    const key = matrixPushkey(SIGNING, AGENT, ARM);
    const flipped = key.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
    expect(verifyMatrixPushkey(SIGNING, flipped)).toBeNull();
    // Another opt-in's id with this HMAC.
    expect(verifyMatrixPushkey(SIGNING, key.replace(ARM, OTHER_ARM))).toBeNull();
    expect(verifyMatrixPushkey("t".repeat(40), key)).toBeNull();
    expect(verifyMatrixPushkey(SIGNING, key.toUpperCase())).toBeNull();
    expect(verifyMatrixPushkey(SIGNING, `v2${key.slice(2)}`)).toBeNull();
    expect(verifyMatrixPushkey(SIGNING, `${key}x`)).toBeNull();
    expect(verifyMatrixPushkey(SIGNING, 42)).toBeNull();
    expect(verifyMatrixPushkey(SIGNING, "x".repeat(600))).toBeNull();
  });
});

describe("push gateway URL", () => {
  it("is the origin of the base address plus the fixed path", () => {
    expect(matrixPushUrl("https://wake.example.test")).toBe("https://wake.example.test/_matrix/push/v1/notify");
    expect(matrixPushUrl("https://wake.example.test/some/prefix")).toBe("https://wake.example.test/_matrix/push/v1/notify");
  });
  it("is null without a plain https base", () => {
    expect(matrixPushUrl(null)).toBeNull();
    expect(matrixPushUrl("http://wake.example.test")).toBeNull();
    expect(matrixPushUrl("https://wake.example.test:8443")).toBeNull();
    expect(matrixPushUrl("not a url")).toBeNull();
  });
});

describe("host script and payload", () => {
  const target = { vmid: 123, bindingTag: "hivra-x" };

  it("puts no request, secret or NUL in the script, and passes bash -n", () => {
    const script = buildMatrixPusherHostScript(target);
    expect(script.includes("\0")).toBe(false);
    expect(script).not.toMatch(/v1\.[0-9a-f]{8}-/);
    expect(script).toContain("run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c");
    // The exec's qm must not read /dev/null, or the request never reaches the guest.
    const tail = script.split("flock -x")[1];
    expect(tail).toMatch(/qm\(\) \{ command timeout -k 5 \d+ qm "\$@"; \}/);
    const check = spawnSync("bash", ["-n"], { input: script });
    expect(check.status).toBe(0);
  });

  it("refuses a bad target", () => {
    expect(() => buildMatrixPusherHostScript({ vmid: 5, bindingTag: "x" })).toThrow();
    expect(() => buildMatrixPusherHostScript({ vmid: 123, bindingTag: null })).toThrow();
    expect(() => buildMatrixPusherHostScript({ vmid: 123, bindingTag: "a b" })).toThrow();
  });

  it("builds the request JSON", () => {
    expect(JSON.parse(buildMatrixPusherPayload({ op: "remove" }))).toEqual({ op: "remove", appId: MATRIX_PUSH_APP_ID });
    expect(JSON.parse(buildMatrixPusherPayload({ op: "register", pushkey: "k", url: "u" })))
      .toEqual({ op: "register", appId: MATRIX_PUSH_APP_ID, pushkey: "k", url: "u" });
    expect(() => buildMatrixPusherPayload({ op: "register" })).toThrow();
  });
});

describe("answer parser", () => {
  it("reads one good line", () => {
    expect(parseMatrixPusherOutput(`${MATRIX_PUSHER_PREFIX}{"fp":"0123456789abcdef","homeserverHost":"matrix.example.test","ok":true,"removed":1}\n`))
      .toEqual({ ok: true, fp: "0123456789abcdef", homeserverHost: "matrix.example.test", removed: 1 });
    expect(parseMatrixPusherOutput(`${MATRIX_PUSHER_PREFIX}{"ok":false,"reason":"password_login"}\n`))
      .toEqual({ ok: false, reason: "password_login" });
    expect(parseMatrixPusherOutput(`${MATRIX_PUSHER_REFUSED_PREFIX}asleep\n`)).toEqual({ ok: false, reason: "asleep" });
  });
  it("refuses anything else", () => {
    const good = `${MATRIX_PUSHER_PREFIX}{"fp":"0123456789abcdef","homeserverHost":"m.example.test","ok":true,"removed":0}`;
    expect(parseMatrixPusherOutput(`${good}\n${good}\n`)).toEqual({ ok: false, reason: "no_answer" });
    expect(parseMatrixPusherOutput("")).toEqual({ ok: false, reason: "no_answer" });
    expect(parseMatrixPusherOutput(good.replace("0123456789abcdef", "nothex"))).toEqual({ ok: false, reason: "no_answer" });
    expect(parseMatrixPusherOutput(`${MATRIX_PUSHER_PREFIX}{"ok":false,"reason":"Bad Reason!"}`)).toEqual({ ok: false, reason: "no_answer" });
  });
});

describe("Matrix coverage", () => {
  const probe = (facts: unknown, fp = "0123456789abcdef") => ({
    liveChannels: ["hermes:matrix"],
    channelFps: { matrix: fp },
    channelFacts: facts as never,
  });
  const row = { enabled: true, credFp: "0123456789abcdef", blockedUntil: null };

  it("covers a token login on the same homeserver and token", () => {
    expect(MATRIX_CHANNEL_SPEC.coverageBlockers({ acts: true, row, probe: probe({ matrix: { homeserverHost: "m.example.test", passwordLogin: false } }), nowMs: 0 }))
      .toEqual([]);
  });
  it("refuses a password login, missing facts, or a changed token", () => {
    expect(MATRIX_CHANNEL_SPEC.coverageBlockers({ acts: true, row, probe: probe({ matrix: { homeserverHost: "m.example.test", passwordLogin: true } }), nowMs: 0 }))
      .toEqual(["password_login"]);
    expect(MATRIX_CHANNEL_SPEC.coverageBlockers({ acts: true, row, probe: probe(undefined), nowMs: 0 })).toEqual(["no_matrix_facts"]);
    expect(MATRIX_CHANNEL_SPEC.coverageBlockers({ acts: true, row, probe: probe({ matrix: { homeserverHost: null, passwordLogin: false } }), nowMs: 0 }))
      .toEqual(["no_homeserver"]);
    expect(MATRIX_CHANNEL_SPEC.coverageBlockers({ acts: true, row, probe: probe({ matrix: { homeserverHost: "m.example.test", passwordLogin: false } }, "fedcba9876543210"), nowMs: 0 }))
      .toEqual(["credential_changed"]);
  });
});

const hasPerl = spawnSync("which", ["perl"]).status === 0;
(hasPerl ? describe : describe.skip)("the host gate for Matrix", () => {
  const quiet = { activeRuns: 0, cliProcesses: 0, openConnections: 0, sshSessions: 0, terminalAttached: false, desktopAttached: false, errors: [] };
  const gate = (probe: Record<string, unknown>) => {
    const script = buildSleepHostScript({ vmid: 123, bindingTag: "hivra-x", tier: "nap", manual: false,
      channelCoverage: { channels: ["hermes:matrix"], fingerprints: { matrix: "0123456789abcdef" } } });
    const body = script.split("<<'HIVRA_PROBE_CHECK'\n")[1].split("\nHIVRA_PROBE_CHECK")[0];
    const run = spawnSync("perl", ["-MJSON::PP", "-", "0"], {
      input: body,
      env: { ...process.env, HIVRA_PROBE: JSON.stringify(probe), HIVRA_COVERED_CHANNELS: "hermes:matrix", HIVRA_CHANNEL_FPS: "matrix:0123456789abcdef" },
      encoding: "utf8",
    });
    return run.stdout.trim();
  };
  const live = { ...quiet, liveChannels: ["hermes:matrix"], channelFps: { matrix: "0123456789abcdef" } };

  it("lets a token-login Matrix agent sleep, and nothing else", () => {
    expect(gate({ ...live, channelFacts: { matrix: { homeserverHost: "m.example.test", passwordLogin: false } } })).toBe("ok");
    expect(gate({ ...live, channelFacts: { matrix: { homeserverHost: "m.example.test", passwordLogin: true } } })).toBe("active");
    expect(gate({ ...live, channelFacts: { matrix: { homeserverHost: null, passwordLogin: false } } })).toBe("active");
    expect(gate({ ...live })).toBe("active");
    expect(gate({ ...live, channelFps: { matrix: "fedcba9876543210" }, channelFacts: { matrix: { homeserverHost: "m.example.test", passwordLogin: false } } })).toBe("active");
  });
});

const hasPython = spawnSync("which", ["python3"]).status === 0;
(hasPython ? describe : describe.skip)("the guest program against a fake homeserver", () => {
  const TOKEN_VALUE = "syt_fake_value_for_tests";
  let server: Server;
  let port = 0;
  let pushers: Array<{ app_id: string; pushkey: string }> = [];
  let calls: Array<{ method: string; url: string; auth: string | undefined; body: unknown }> = [];
  let rejectToken = false;
  let dir = "";

  const readAll = (req: IncomingMessage) => new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const raw = await readAll(req);
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      if (rejectToken) { res.writeHead(401).end("{}"); return; }
      if (req.method === "GET" && req.url === "/_matrix/client/v3/pushers") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pushers }));
        return;
      }
      if (req.method === "POST" && req.url === "/_matrix/client/v3/pushers/set") {
        if (body.kind === null) pushers = pushers.filter((p) => !(p.app_id === body.app_id && p.pushkey === body.pushkey));
        else pushers = [...pushers.filter((p) => !(p.app_id === body.app_id && p.pushkey === body.pushkey)), { app_id: body.app_id, pushkey: body.pushkey }];
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
    dir = mkdtempSync(join(tmpdir(), "hivra-matrix-"));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => { pushers = []; calls = []; rejectToken = false; });

  const run = (envText: string, request: unknown) => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, envText);
    const program = MATRIX_PUSHER_GUEST_PROGRAM.replace("/home/bux/.hermes/.env", envPath);
    expect(program).not.toBe(MATRIX_PUSHER_GUEST_PROGRAM);
    return new Promise<string>((resolve) => {
      const child = spawn("python3", ["-I", "-B", "-c", program], { env: { ...process.env, PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
      child.on("close", () => resolve(out));
      child.stdin.end(JSON.stringify(request));
    });
  };
  const envText = () => `MATRIX_HOMESERVER=http://127.0.0.1:${port}\nMATRIX_ACCESS_TOKEN=${TOKEN_VALUE}\n`;
  const pushUrl = "https://wake.example.test/_matrix/push/v1/notify";

  it("compiles and has no NUL", () => {
    expect(MATRIX_PUSHER_GUEST_PROGRAM.includes("\0")).toBe(false);
    const check = spawnSync("python3", ["-I", "-c", "import sys; compile(sys.stdin.read(), 'p', 'exec')"], { input: MATRIX_PUSHER_GUEST_PROGRAM });
    expect(check.status).toBe(0);
  });

  it("registers the pusher, removes an older one, and prints the probe's fingerprint and never the token", async () => {
    pushers = [{ app_id: MATRIX_PUSH_APP_ID, pushkey: "old" }, { app_id: "other.app", pushkey: "phone" }];
    const key = matrixPushkey(SIGNING, AGENT, ARM);
    const out = await run(envText(), JSON.parse(buildMatrixPusherPayload({ op: "register", pushkey: key, url: pushUrl })));
    expect(out).not.toContain(TOKEN_VALUE);
    const parsed = parseMatrixPusherOutput(out);
    const hs = `http://127.0.0.1:${port}`;
    const expectedFp = createHash("sha256").update(`${hs}\n${TOKEN_VALUE}`).digest("hex").slice(0, 16);
    expect(parsed).toEqual({ ok: true, fp: expectedFp, homeserverHost: "127.0.0.1", removed: 1 });
    expect(pushers).toEqual([{ app_id: "other.app", pushkey: "phone" }, { app_id: MATRIX_PUSH_APP_ID, pushkey: key }]);
    const set = calls.find((c) => c.method === "POST" && (c.body as { kind?: unknown }).kind === "http");
    expect(set?.body).toEqual({
      kind: "http", app_id: MATRIX_PUSH_APP_ID, pushkey: key, app_display_name: "Hivra wake", device_display_name: "Hivra wake",
      lang: "en", append: false, data: { url: pushUrl, format: "event_id_only" },
    });
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN_VALUE}`)).toBe(true);

    // The idle probe's fingerprint for the same .env is the same value.
    const probe = spawnSync("python3", ["-I", "-c", ["import json, re", TELEGRAM_ENV_VALUE_PY, `env = ${JSON.stringify(envText())}`, "OUT = {}",
      channelFpsPython(["matrix"]), "print(json.dumps(OUT))"].join("\n")], { encoding: "utf8" });
    expect(JSON.parse(probe.stdout).channelFps).toEqual({ matrix: expectedFp });
  });

  it("removes every Hivra pusher and leaves others", async () => {
    pushers = [{ app_id: MATRIX_PUSH_APP_ID, pushkey: "a" }, { app_id: MATRIX_PUSH_APP_ID, pushkey: "b" }, { app_id: "other.app", pushkey: "phone" }];
    const parsed = parseMatrixPusherOutput(await run(envText(), JSON.parse(buildMatrixPusherPayload({ op: "remove" }))));
    expect(parsed).toMatchObject({ ok: true, removed: 2 });
    expect(pushers).toEqual([{ app_id: "other.app", pushkey: "phone" }]);
  });

  it("names why it could not", async () => {
    const register = JSON.parse(buildMatrixPusherPayload({ op: "register", pushkey: "k", url: pushUrl }));
    expect(parseMatrixPusherOutput(await run(`MATRIX_HOMESERVER=http://127.0.0.1:${port}\nMATRIX_PASSWORD=pw\n`, register)))
      .toEqual({ ok: false, reason: "password_login" });
    expect(parseMatrixPusherOutput(await run("OTHER=1\n", register))).toEqual({ ok: false, reason: "no_homeserver" });
    expect(parseMatrixPusherOutput(await run(envText(), { ...register, url: "https://evil.example.test/other" })))
      .toEqual({ ok: false, reason: "bad_request" });
    rejectToken = true;
    expect(parseMatrixPusherOutput(await run(envText(), register))).toEqual({ ok: false, reason: "token_rejected" });
    rejectToken = false;
    expect(parseMatrixPusherOutput(await run("MATRIX_HOMESERVER=http://127.0.0.1:1\nMATRIX_ACCESS_TOKEN=x\n", register)))
      .toEqual({ ok: false, reason: "homeserver_unreachable" });
  });
});
