/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseIdleProbeOutput } from "../../agent-sleep-scripts";
import { IDLE_PROBE_PREFIX, IDLE_PROBE_PROGRAM, IDLE_PROBE_VERSION } from "../idle-probe-program";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const run = hasPython ? describe : describe.skip;

describe("idle probe program text", () => {
  it("is small, prints one prefixed line, and keeps secrets out", () => {
    expect(IDLE_PROBE_PREFIX).toBe("HIVRA_IDLE ");
    expect(IDLE_PROBE_VERSION).toBe(1);
    expect(Buffer.byteLength(IDLE_PROBE_PROGRAM)).toBeLessThan(32 * 1024);
    // The desktop session file holds session secrets and is never read.
    expect(IDLE_PROBE_PROGRAM).not.toContain("sessions.json");
    expect(IDLE_PROBE_PROGRAM).not.toMatch(/10\.\d+\.\d+\.\d+/);
  });
});

run("idle probe program, run for real against fixture files", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "hivra-idle-probe-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const put = (rel: string, body: string) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  // The probe reads fixed guest paths; point the ones under the user's home and the crontab at the fixture.
  const probe = () => {
    const program = IDLE_PROBE_PROGRAM
      .replaceAll('HOME = "/home/bux"', `HOME = ${JSON.stringify(path.join(dir, "home"))}`)
      .replaceAll("/var/spool/cron/crontabs/bux", path.join(dir, "crontab"))
      .replaceAll("/var/spool/cron/atjobs", path.join(dir, "atjobs"))
      .replaceAll("/etc/bux/tg.env", path.join(dir, "tg.env"))
      .replaceAll("/opt/a0/usr/scheduler/tasks.json", path.join(dir, "a0-tasks.json"));
    const result = spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    const parsed = parseIdleProbeOutput(result.stdout);
    expect(parsed).not.toBeNull();
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    return parsed!;
  };
  const future = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  it("reads a quiet computer as quiet", () => {
    const p = probe();
    expect(p).toMatchObject({ activeRuns: 0, openConnections: 0, terminalAttached: false, liveChannels: [], nextJobAt: null, lastUsedAt: null });
    expect(p.cpus).toBeGreaterThan(0);
    expect(p.loadavg).toHaveLength(3);
  });

  it("counts a chat run that is starting and takes its time as use", () => {
    put("home/.hivra/chat-runs/a/status.json", JSON.stringify({ state: "starting", startedAt: "2026-11-12T10:00:00Z" }));
    put("home/.hivra/chat-runs/b/status.json", JSON.stringify({ state: "finished", finishedAt: "2026-11-12T11:00:00.500Z" }));
    put("home/.hivra/chat-runs/c/status.json", "{not json");
    const p = probe();
    expect(p.activeRuns).toBe(1);
    expect(p.lastUsedAt).toBe("2026-11-12T11:00:00Z");
  });

  it("does not count a run whose runner is gone", () => {
    put("home/.hivra/chat-runs/a/status.json", JSON.stringify({ state: "running", runnerPid: 999999, startedAt: "2026-11-12T10:00:00Z" }));
    expect(probe().activeRuns).toBe(0);
  });

  it("finds the next scheduled job and ignores paused or disabled ones", () => {
    const soon = future(3600), later = future(7200);
    put("home/.hermes/cron/jobs.json", JSON.stringify({ jobs: [
      { enabled: true, state: "scheduled", next_run_at: later },
      { enabled: true, state: "scheduled", next_run_at: soon },
      { enabled: false, state: "scheduled", next_run_at: future(60) },
      { state: "paused", next_run_at: future(60) },
    ] }));
    expect(Date.parse(probe().nextJobAt!)).toBeCloseTo(Date.parse(soon), -4);
  });

  it("counts a running scheduled job as an active run", () => {
    put("home/.hermes/cron/jobs.json", JSON.stringify({ jobs: [{ state: "running", next_run_at: future(600) }] }));
    expect(probe().activeRuns).toBe(1);
  });

  it("reads the OpenClaw next run anywhere in its file", () => {
    const at = Date.now() + 5400_000;
    put("home/.openclaw/cron/jobs-state.json", JSON.stringify({ jobs: { x: { state: { nextRunAtMs: at } } } }));
    expect(Date.parse(probe().nextJobAt!)).toBeCloseTo(at, -4);
  });

  it("treats a real crontab entry as due now but not comments or settings", () => {
    put("crontab", "# DO NOT EDIT\n# header\nMAILTO=me\nSHELL=/bin/sh\n\n");
    expect(probe().nextJobAt).toBeNull();
    put("crontab", "# header\n*/5 * * * * /usr/bin/true\n");
    expect(Date.parse(probe().nextJobAt!)).toBeLessThan(Date.now() + 5000);
  });

  it("reports connected chat channels without ever printing their tokens", () => {
    put("home/.hermes/.env", "TELEGRAM_BOT_TOKEN=secret-value\nDISCORD_BOT_TOKEN=\n");
    const result = spawnSync("python3", ["-I", "-B", "-c", IDLE_PROBE_PROGRAM.replaceAll('HOME = "/home/bux"', `HOME = ${JSON.stringify(path.join(dir, "home"))}`)], { encoding: "utf8" });
    expect(result.stdout).not.toContain("secret-value");
    const p = parseIdleProbeOutput(result.stdout)!;
    // No gateway process is running here, and the probe's own command line must not look like one.
    expect(p.liveChannels).toEqual(["hermes:telegram:down"]);
  });

  it("reads OpenClaw and Hermes configured channels", () => {
    put("home/.openclaw/openclaw.json", JSON.stringify({ channels: { whatsapp: { enabled: true }, slack: { enabled: false } } }));
    put("home/.hermes/config.yaml", "platforms:\n  discord:\n    enabled: true\n  matrix:\n    enabled: false\n");
    const channels = probe().liveChannels;
    expect(channels).toContain("openclaw:whatsapp");
    expect(channels).not.toContain("openclaw:slack");
  });

  it("prints nothing on stdout and exits non-zero when it fails", () => {
    const broken = IDLE_PROBE_PROGRAM.replace("def has_cron_jobs(text):", "def has_cron_jobs(text):\n    raise RuntimeError('boom')");
    const result = spawnSync("python3", ["-I", "-B", "-c", broken], { encoding: "utf8" });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HIVRA_IDLE_FAILURE");
  });
});
