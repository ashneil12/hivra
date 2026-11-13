/** @jest-environment node */
// The profile probe against the old fixed probe, run for real on the same
// fixture computers: for every agent type the old probe knew, the answer is
// the same. Then what only the profile probe does: other types, the chat
// safety net and the CPU safety net.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { idleProbeProgramFor, parseIdleProbeOutput } from "../../agent-sleep-scripts";
import { IDLE_PROBE_PREFIX, IDLE_PROBE_PROGRAM, IDLE_PROBE_TELEGRAM_PROGRAM } from "../../sleep/idle-probe-program";
import { buildProfileProbeProgram, PROFILE_PROBE_BODY } from "../../sleep/profile-probe-program";
import { probeProfileFor, probeProfileJson, type ProbeProfile } from "..";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const run = hasPython ? describe : describe.skip;

run("profile probe vs the fixed probe, on the same fixture computer", () => {
  let dir: string;
  let gateway: ChildProcess | null = null;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "hivra-profile-probe-")); });
  afterEach(() => {
    gateway?.kill("SIGKILL");
    gateway = null;
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (rel: string, body: string) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const ABSOLUTE = ["/var/spool/cron/crontabs/bux", "/var/spool/cron/atjobs", "/etc/bux/tg.env", "/opt/a0/usr/scheduler/tasks.json", "/opt/a0/usr/chats"];
  const home = () => JSON.stringify(path.join(dir, "home"));
  /** The old program, pointed at the fixture: the same paths the tests of the old probe redirect. */
  const legacy = (program: string) => {
    let out = program.replaceAll('HOME = "/home/bux"', `HOME = ${home()}`);
    for (const p of ABSOLUTE) out = out.replaceAll(p, path.join(dir, "root", p));
    return out;
  };
  /** The profile program, pointed at the same fixture by its two roots. */
  const fromProfile = (program: string) => program
    .replace('HOME = "/home/bux"', `HOME = ${home()}`)
    .replace('ROOT = ""', `ROOT = ${JSON.stringify(path.join(dir, "root"))}`);
  const exec = (program: string) => {
    const r = spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(parseIdleProbeOutput(r.stdout)).not.toBeNull();
    return JSON.parse(r.stdout.slice(IDLE_PROBE_PREFIX.length)) as Record<string, unknown>;
  };
  /** Drops what differs between any two runs (clock, load, timing) and what only the profile probe adds. */
  const comparable = (json: Record<string, unknown>): Record<string, unknown> => {
    const rest: Record<string, unknown> = { ...json, errors: [...(json.errors as string[])].sort() };
    for (const key of ["ms", "now", "loadavg", "uptimeS", "profile", "cpuBusy"]) delete rest[key];
    return rest;
  };
  const noNets = (type: string): ProbeProfile => probeProfileFor(type, { cpu: null });
  const profileRun = (type: string, ask: { telegram?: boolean; channels?: ("email" | "discord" | "matrix")[] } = {}) =>
    exec(fromProfile(idleProbeProgramFor({ ...ask, profile: noNets(type) })));
  const startGateway = async () => {
    // A process whose command line reads like the Hermes gateway's, so both probes see it running.
    gateway = spawn("python3", ["-c", "import time; time.sleep(120)", "hermes", "gateway"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  const future = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  /** Everything the old probe read, for every agent at once. */
  const kitchenSink = () => {
    put("home/.hivra/chat-runs/a/status.json", JSON.stringify({ state: "starting", startedAt: "2026-11-12T10:00:00Z" }));
    put("home/.hivra/chat-runs/b/status.json", JSON.stringify({ state: "finished", finishedAt: "2026-11-12T11:00:00Z" }));
    put("home/.hivra/chat-runs/c/status.json", "{not json");
    put("home/.claude/projects/p/s.jsonl", "{}");
    utimesSync(path.join(dir, "home/.claude/projects/p/s.jsonl"), 1_700_000_000, 1_700_000_000);
    put("home/.codex/sessions/2026/x.jsonl", "{}");
    utimesSync(path.join(dir, "home/.codex/sessions/2026/x.jsonl"), 1_700_000_100, 1_700_000_100);
    put("home/.hermes/cron/jobs.json", JSON.stringify({ jobs: [
      { enabled: true, state: "scheduled", next_run_at: future(7200) },
      { state: "running", next_run_at: future(600) },
      { enabled: false, next_run_at: future(60) },
    ] }));
    put("home/.hermes/profiles/ops/cron/jobs.json", JSON.stringify({ jobs: [{ next_run_at: future(5400) }] }));
    put("home/.hermes/.env", "TELEGRAM_BOT_TOKEN=1:x\nDISCORD_BOT_TOKEN=d\nDISCORD_MISSED_MESSAGE_BACKFILL=true\nEMAIL_ADDRESS=a@example.test\nEMAIL_PASSWORD=p\nEMAIL_IMAP_HOST=imap.example.test\nSIGNAL_ACCOUNT=+15550000000\nMATRIX_HOMESERVER=https://matrix.example.test\nMATRIX_ACCESS_TOKEN=m\n");
    put("home/.hermes/config.yaml", "platforms:\n  slack:\n    enabled: true\n  irc:\n    enabled: false\n  telegram:\n    token: abc\n");
    put("home/.hermes/gateway_state.json", JSON.stringify({ platforms: { feishu: { state: "connected" }, api_server: { state: "connected" } } }));
    put("home/.hermes/profiles/ops/gateway_state.json", JSON.stringify({ platforms: { line: { state: "fatal" } } }));
    put("home/.openclaw/cron/jobs-state.json", JSON.stringify({ jobs: { x: { state: { nextRunAtMs: Date.now() + 3_000_000 } } } }));
    put("home/.openclaw/cron/jobs.json", "{broken");
    put("home/.openclaw/openclaw.json", JSON.stringify({ channels: { whatsapp: { enabled: true }, slack: { enabled: false }, "tele gram": {} } }));
    // Empty, so nothing is "due now" on each run's own clock (the next test compares a due task to the second).
    put("root/opt/a0/usr/scheduler/tasks.json", JSON.stringify({ tasks: [] }));
    put("root/var/spool/cron/crontabs/bux", "# header\nMAILTO=x\n");
    put("root/var/spool/cron/atjobs/.SEQ", "1");
    put("root/etc/bux/tg.env", "TG_BOT_TOKEN=\n");
  };

  it("gives the old answer on a computer with every agent's files, with no profile (the union)", async () => {
    kitchenSink();
    expect(comparable(profileRun("not-a-type"))).toEqual(comparable(exec(legacy(IDLE_PROBE_PROGRAM))));
    await startGateway();
    const old = exec(legacy(IDLE_PROBE_PROGRAM));
    expect(old.liveChannels).toContain("hermes:feishu");
    expect(comparable(profileRun("not-a-type"))).toEqual(comparable(old));
  });

  it("gives the old answer for a known type on a computer that holds other agents' files", async () => {
    // A desktop, terminal, Claude Code or Codex computer where the user installed Hermes and OpenClaw:
    // their cron jobs and channels still keep it awake, exactly as the fixed probe saw them.
    kitchenSink();
    put("home/.openclaw/openclaw.json", JSON.stringify({ channels: { slack: { enabled: true } } }));
    const check = () => {
      const old = comparable(exec(legacy(IDLE_PROBE_PROGRAM)));
      expect(old.nextJobAt).not.toBeNull();
      expect(old.liveChannels).toEqual(expect.arrayContaining(["hermes:discord", "openclaw:slack"].map((t) => expect.stringContaining(t))));
      for (const type of ["claude-code", "codex", "linux-desktop", "linux-terminal", "hermes", "openclaw", "agent-zero"]) {
        expect([type, comparable(profileRun(type))]).toEqual([type, old]);
      }
    };
    check();
    await startGateway();
    check();
  });

  it("gives the old answer for Hermes, with and without its gateway, Telegram facts and fingerprints included", async () => {
    kitchenSink();
    rmSync(path.join(dir, "home/.openclaw"), { recursive: true });
    rmSync(path.join(dir, "root/opt"), { recursive: true });
    const check = () => {
      expect(comparable(profileRun("hermes"))).toEqual(comparable(exec(legacy(IDLE_PROBE_PROGRAM))));
      expect(comparable(profileRun("hermes", { telegram: true }))).toEqual(comparable(exec(legacy(IDLE_PROBE_TELEGRAM_PROGRAM))));
      const channels = ["email", "discord", "matrix"] as const;
      expect(comparable(profileRun("hermes", { telegram: true, channels: [...channels] })))
        .toEqual(comparable(exec(legacy(idleProbeProgramFor({ telegram: true, channels: [...channels] })))));
    };
    check();
    await startGateway();
    check();
    put("home/.hermes/.env", "TELEGRAM_BOT_TOKEN=1:y\nTELEGRAM_WEBHOOK_URL=https://bot.example.test/h\n");
    put("home/.hermes/config.yaml", "x: 1\n");
    check();
  });

  it("gives the old answer for OpenClaw, Claude Code, Codex and Agent Zero on their own computers", () => {
    put("home/.openclaw/cron/jobs-state.json", JSON.stringify({ jobs: { x: { state: { nextRunAtMs: Date.now() + 3_000_000 } } } }));
    put("home/.openclaw/openclaw.json", JSON.stringify({ channels: { telegram: { botToken: "1:z" }, discord: { enabled: false } } }));
    // A crontab entry is "due now" on each run's own clock, so it is compared in the union test's computer instead.
    put("root/var/spool/cron/crontabs/bux", "# none\n");
    expect(comparable(profileRun("openclaw"))).toEqual(comparable(exec(legacy(IDLE_PROBE_PROGRAM))));
    rmSync(path.join(dir, "home/.openclaw"), { recursive: true });
    put("home/.claude/projects/p/s.jsonl", "{}");
    put("home/.codex/sessions/x.jsonl", "{}");
    utimesSync(path.join(dir, "home/.claude/projects/p/s.jsonl"), 1_700_000_000, 1_700_000_000);
    utimesSync(path.join(dir, "home/.codex/sessions/x.jsonl"), 1_700_000_000, 1_700_000_000);
    for (const type of ["claude-code", "codex"]) {
      expect(comparable(profileRun(type))).toEqual(comparable(exec(legacy(IDLE_PROBE_PROGRAM))));
    }
    put("root/opt/a0/usr/scheduler/tasks.json", JSON.stringify({ tasks: { a: 1 } }));
    // A task is "due now" on each run's own clock: compared to the second.
    const [a0, old] = [comparable(profileRun("agent-zero")), comparable(exec(legacy(IDLE_PROBE_PROGRAM)))];
    expect(Math.abs(Date.parse(a0.nextJobAt as string) - Date.parse(old.nextJobAt as string))).toBeLessThanOrEqual(2000);
    expect({ ...a0, nextJobAt: null }).toEqual({ ...old, nextJobAt: null });
  });

  it("names the profile it evaluated", () => {
    expect(profileRun("nuphos").profile).toBe("nuphos");
    expect(profileRun("not-a-type").profile).toBe("unknown");
  });

  it("reads OpenClaw's Telegram token from where its profile says, as a fingerprint only", () => {
    const token = ["123456", "A".repeat(35)].join(":");
    put("home/.openclaw/openclaw.json", JSON.stringify({ channels: { telegram: { botToken: token } } }));
    const r = spawnSync("python3", ["-I", "-B", "-c", fromProfile(idleProbeProgramFor({ telegram: true, profile: noNets("openclaw") }))], { encoding: "utf8" });
    expect(r.stdout).not.toContain(token);
    const json = JSON.parse(r.stdout.slice(IDLE_PROBE_PREFIX.length));
    expect(json.liveChannels).toEqual(["openclaw:telegram"]);
    expect(json.telegram).toEqual({ hermesFp: expect.stringMatching(/^[0-9a-f]{16}$/), hermesTokenInEnv: true, hermesWebhookMode: false, hermesConfigToken: false });
    put("home/.openclaw/openclaw.json", JSON.stringify({ channels: { telegram: { botToken: token, webhookUrl: "https://bot.example.test/h", accounts: { b: {} } } } }));
    expect(profileRun("openclaw", { telegram: true }).telegram).toMatchObject({ hermesWebhookMode: true, hermesConfigToken: true });
    // A type with no Telegram source: facts that say no token, so Telegram is never covered.
    expect(profileRun("codex", { telegram: true }).telegram).toEqual({ hermesFp: null, hermesTokenInEnv: false, hermesWebhookMode: false, hermesConfigToken: false });
  });

  it("adds a type's own signals the fixed probe never read: Agent Zero's chats", () => {
    put("root/opt/a0/usr/chats/c1/log.json", "{}");
    utimesSync(path.join(dir, "root/opt/a0/usr/chats/c1/log.json"), 1_700_000_000, 1_700_000_000);
    expect(profileRun("agent-zero").lastUsedAt).toBe("2023-11-14T22:13:20Z");
    expect(exec(legacy(IDLE_PROBE_PROGRAM)).lastUsedAt).toBeNull();
  });

  describe("the chat safety net", () => {
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    // 192.0.2.10 (documentation range) on port 443, as /proc/net/tcp prints it.
    const REMOTE = "0A0200C0:01BB";
    const row = (inode: string, remote = REMOTE, state = "01") =>
      `   0: 0100007F:9C40 ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0 20 4 30 10 -1\n`;
    const withNet = (profile: ProbeProfile, table: string) => {
      put("tcp", header + table);
      return exec(fromProfile(idleProbeProgramFor({ profile })).replaceAll('"/proc/net/tcp"', JSON.stringify(path.join(dir, "tcp"))));
    };
    const tgEndpoints = [{ p: "telegram", ports: [443], a: ["0A0200C0"] }];

    it("reports a chat connection nothing declared holds as an unknown channel, for any type", () => {
      for (const type of ["codex", "deepseek-harness", "not-a-type"]) {
        const json = withNet(probeProfileFor(type, { cpu: null, endpoints: tgEndpoints }), row("424242"));
        expect(json.liveChannels).toEqual(["unknown:telegram"]);
      }
    });

    it("ignores other addresses, other ports and connections that are not established", () => {
      const profile = probeProfileFor("codex", { cpu: null, endpoints: tgEndpoints });
      expect(withNet(profile, row("1", "0B0200C0:01BB") + row("2", "0A0200C0:0050") + row("3", REMOTE, "06")).liveChannels).toEqual([]);
      expect(withNet(probeProfileFor("codex", { cpu: null }), row("4")).liveChannels).toEqual([]);
    });

    it("leaves a connection the Hermes gateway holds to its own declared channel", async () => {
      put("home/.hermes/.env", "TELEGRAM_BOT_TOKEN=1:x\n");
      gateway = spawn("python3", ["-c", "import socket, time; s = socket.socket(); time.sleep(120)", "hermes", "gateway"], { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const pid = gateway.pid!;
      const inode = spawnSync("sh", ["-c", `ls -l /proc/${pid}/fd | sed -n 's/.*socket:\\[\\([0-9]*\\)\\].*/\\1/p' | head -1`], { encoding: "utf8" }).stdout.trim();
      expect(inode).toMatch(/^\d+$/);
      const profile = probeProfileFor("hermes", { cpu: null, endpoints: tgEndpoints });
      expect(withNet(profile, row(inode)).liveChannels).toEqual(["hermes:telegram"]);
      // Every type detects with every profile: on an OpenClaw computer it is Hermes's live (uncovered) channel.
      expect(withNet(probeProfileFor("openclaw", { cpu: null, endpoints: tgEndpoints }), row(inode)).liveChannels).toEqual(["hermes:telegram"]);
    });

    it("counts a connection held by a process started under the gateway, or by a look-alike, as unknown", async () => {
      put("home/.hermes/.env", "TELEGRAM_BOT_TOKEN=1:x\n");
      // The gateway starts a second bot (say, from its terminal tool) that holds its own connection.
      const child = "import socket, time; s = socket.socket(); time.sleep(120)";
      gateway = spawn("python3", ["-c", `import subprocess, sys, time; subprocess.Popen([sys.executable, "-c", ${JSON.stringify(child)}, "other-bot"]); time.sleep(120)`, "hermes", "gateway"], { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const kid = readdirSync("/proc").find((p) => /^\d+$/.test(p) && (() => {
        try { return readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1] === String(gateway!.pid); } catch { return false; }
      })()) ?? "";
      expect(kid).toMatch(/^\d+$/);
      const inode = spawnSync("sh", ["-c", `ls -l /proc/${kid}/fd | sed -n 's/.*socket:\\[\\([0-9]*\\)\\].*/\\1/p' | head -1`], { encoding: "utf8" }).stdout.trim();
      expect(inode).toMatch(/^\d+$/);
      try {
        const json = withNet(probeProfileFor("hermes", { cpu: null, endpoints: tgEndpoints }), row(inode));
        expect(json.liveChannels).toEqual(["hermes:telegram", "unknown:telegram"]);
      } finally {
        process.kill(Number(kid), "SIGKILL");
      }
      // "hermes" and " gateway" in a command line are not enough: the program must be hermes and gateway an argument.
      gateway.kill("SIGKILL");
      gateway = spawn("python3", ["-c", "import socket, time; s = socket.socket(); time.sleep(120)", "--name=hermes", "x gateway"], { stdio: "ignore" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const inode2 = spawnSync("sh", ["-c", `ls -l /proc/${gateway.pid}/fd | sed -n 's/.*socket:\\[\\([0-9]*\\)\\].*/\\1/p' | head -1`], { encoding: "utf8" }).stdout.trim();
      expect(withNet(probeProfileFor("hermes", { cpu: null, endpoints: tgEndpoints }), row(inode2)).liveChannels).toContain("unknown:telegram");
    });

    it("resolves the services' names on the guest too, and merges them with the server's addresses", () => {
      // localhost resolves without a network: 127.0.0.1 on 443 is what /proc/net/tcp prints as 0100007F:01BB.
      // (The server only ever sends public names; the program itself takes any name it is handed.)
      const input = JSON.parse(probeProfileJson(probeProfileFor("codex", { cpu: null })));
      const program = (endpoints: unknown[]) =>
        fromProfile(buildProfileProbeProgram(JSON.stringify({ ...input, endpoints }))).replaceAll('"/proc/net/tcp"', JSON.stringify(path.join(dir, "tcp")));
      put("tcp", header + row("5151", "0100007F:01BB"));
      expect(exec(program([{ p: "telegram", ports: [443], h: ["localhost"], a: [] }])).liveChannels).toEqual(["unknown:telegram"]);
      expect(exec(program([{ p: "telegram", ports: [443], a: [] }])).liveChannels).toEqual([]);
      // A name that does not resolve adds nothing; the server's addresses still count.
      expect(exec(program([{ p: "telegram", ports: [443], h: ["nothing.invalid"], a: ["0100007F"] }])).liveChannels).toEqual(["unknown:telegram"]);
    });
  });

  it("the CPU safety net counts an agent process working hard as busy", async () => {
    const spinner = spawn("python3", ["-c", "import time\nend = time.time() + 30\nwhile time.time() < end: pass", "hivra-test-spinner"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const base = probeProfileFor("codex", { cpu: { pct: 50, ms: 400 } });
      const profile: ProbeProfile = { ...base, profile: { ...base.profile, agentProcesses: [{ cmd: "hivra-test-spinner" }] } };
      const json = exec(fromProfile(idleProbeProgramFor({ profile })));
      expect(json.cpuBusy).toBeGreaterThanOrEqual(1);
      expect(json.cliProcesses).toBeGreaterThanOrEqual(1);
    } finally {
      spinner.kill("SIGKILL");
    }
  });

  it("keeps the program small, with no NUL byte and no secret", () => {
    const program = idleProbeProgramFor({ telegram: true, channels: ["email", "discord", "matrix"], profile: probeProfileFor("hermes") });
    expect(program.includes("\0")).toBe(false);
    expect(Buffer.byteLength(program)).toBeLessThan(40 * 1024);
    expect(PROFILE_PROBE_BODY).not.toContain("sessions.json");
  });
});
