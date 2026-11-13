/** @jest-environment node */
// The Telegram half of the idle probe, the token read and the host gate, run
// for real: python3 against fixture files and perl against probe JSON.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TELEGRAM_TOKEN_READ_PROGRAM,
  idleVerdict,
  parseIdleProbeOutput,
  parseTelegramTokenRead,
  probeCheckPerl,
  validateIdleProbe,
} from "../../agent-sleep-scripts";
import { IDLE_PROBE_PROGRAM, IDLE_PROBE_TELEGRAM_PROGRAM } from "../../sleep/idle-probe-program";
import { telegramTokenFingerprint } from "../bot-api";
import { telegramWakeCoverage } from "../coverage";

const hasTools = ["python3", "perl"].every((cmd) => spawnSync("which", [cmd]).status === 0);
const run = hasTools ? describe : describe.skip;

// Built at run time so no token-shaped literal sits in the source.
const sample = [String(7_000_000_000 + 4321), "Ab_-".repeat(9)].join(":");
const other = [String(7_000_000_000 + 9876), "Zy-_".repeat(9)].join(":");

describe("program text", () => {
  it("leaves the plain probe untouched and only adds the Telegram block to its own variant", () => {
    expect(IDLE_PROBE_PROGRAM).not.toContain("telegram\"] =");
    expect(IDLE_PROBE_PROGRAM).not.toContain("hashlib");
    expect(IDLE_PROBE_TELEGRAM_PROGRAM.startsWith(IDLE_PROBE_PROGRAM.slice(0, 200))).toBe(true);
    expect(IDLE_PROBE_TELEGRAM_PROGRAM).toContain('OUT["telegram"]');
    expect(IDLE_PROBE_TELEGRAM_PROGRAM.length).toBeGreaterThan(IDLE_PROBE_PROGRAM.length);
  });
});

run("Telegram probe and token read, run for real", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "hivra-tg-probe-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, body: string) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const home = () => path.join(dir, "home");
  const probe = () => {
    const program = IDLE_PROBE_TELEGRAM_PROGRAM
      .replaceAll('HOME = "/home/bux"', `HOME = ${JSON.stringify(home())}`)
      .replaceAll("/var/spool/cron/crontabs/bux", path.join(dir, "crontab"))
      .replaceAll("/var/spool/cron/atjobs", path.join(dir, "atjobs"))
      .replaceAll("/etc/bux/tg.env", path.join(dir, "tg.env"))
      .replaceAll("/opt/a0/usr/scheduler/tasks.json", path.join(dir, "a0-tasks.json"));
    const result = spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    return { stdout: result.stdout, parsed: parseIdleProbeOutput(result.stdout) };
  };
  const readToken = () => {
    const program = TELEGRAM_TOKEN_READ_PROGRAM.replaceAll("/home/bux/.hermes/.env", path.join(home(), ".hermes/.env"));
    const result = spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    return result.stdout;
  };

  it("reports a fingerprint of the .env token and never the token itself", () => {
    put("home/.hermes/.env", `OTHER=1\nTELEGRAM_BOT_TOKEN=${sample}\n`);
    const { stdout, parsed } = probe();
    expect(stdout).not.toContain(sample);
    expect(stdout).not.toContain(sample.split(":")[1]);
    expect(parsed?.telegram).toEqual({
      hermesFp: telegramTokenFingerprint(sample),
      hermesTokenInEnv: true,
      hermesWebhookMode: false,
      hermesConfigToken: false,
    });
    expect(parsed?.liveChannels).toEqual(["hermes:telegram:down"]);
  });

  it("reads quoted, exported and repeated assignments the way the token read does", () => {
    put("home/.hermes/.env", `TELEGRAM_BOT_TOKEN=${other}\nexport TELEGRAM_BOT_TOKEN="${sample}"\n`);
    const { parsed } = probe();
    expect(parsed?.telegram?.hermesFp).toBe(telegramTokenFingerprint(sample));
    const read = parseTelegramTokenRead(readToken());
    expect(read).toEqual({ ok: true, token: sample });
  });

  it("says when Hermes runs its own webhook, or config.yaml holds a token", () => {
    put("home/.hermes/.env", `TELEGRAM_BOT_TOKEN=${sample}\nTELEGRAM_WEBHOOK_URL=https://bot.example.test/hook\n`);
    put("home/.hermes/config.yaml", "platforms:\n  telegram:\n    enabled: true\n    token: abc\n");
    const { parsed } = probe();
    expect(parsed?.telegram).toMatchObject({ hermesWebhookMode: true, hermesConfigToken: true });
    expect(parseTelegramTokenRead(readToken())).toEqual({ ok: false, reason: "webhook_mode" });
  });

  it("reports no token when there is none, and the token read says why", () => {
    const { parsed } = probe();
    expect(parsed?.telegram).toEqual({ hermesFp: null, hermesTokenInEnv: false, hermesWebhookMode: false, hermesConfigToken: false });
    expect(parseTelegramTokenRead(readToken())).toEqual({ ok: false, reason: "no_env" });
    put("home/.hermes/.env", "OTHER=1\n");
    expect(parseTelegramTokenRead(readToken())).toEqual({ ok: false, reason: "no_token" });
    put("home/.hermes/.env", "TELEGRAM_BOT_TOKEN=not-a-token\n");
    expect(parseTelegramTokenRead(readToken())).toEqual({ ok: false, reason: "bad_shape" });
  });
});

describe("token read parser", () => {
  it("never puts the token into a failure", () => {
    const twice = `HIVRA_TG_TOKEN ${sample}\nHIVRA_TG_TOKEN ${sample}\n`;
    const result = parseTelegramTokenRead(twice);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sample);
    expect(parseTelegramTokenRead("HIVRA_IDLE_REFUSED asleep\n")).toEqual({ ok: false, reason: "asleep" });
    expect(parseTelegramTokenRead("")).toEqual({ ok: false, reason: "no_answer" });
  });
});

// ---------------------------------------------------------------------------
// The two gates agree
// ---------------------------------------------------------------------------

const FP = "0123456789abcdef";
function probeJson(over: Record<string, unknown> = {}, telegram: Record<string, unknown> | null = {}) {
  return {
    v: 1, errors: [], activeRuns: 0, cliProcesses: 0, openConnections: 0, gatewayConnections: 0,
    terminalAttached: false, terminalClients: 0, sshSessions: 0, desktopAttached: false,
    lastUsedAt: null, nextJobAt: null, liveChannels: ["hermes:telegram"], loadavg: [0, 0, 0], cpus: 2,
    uptimeS: 99999, now: "2026-11-13T10:00:00Z", ms: 5,
    ...(telegram ? { telegram: { hermesFp: FP, hermesTokenInEnv: true, hermesWebhookMode: false, hermesConfigToken: false, ...telegram } } : {}),
    ...over,
  };
}

function perlGate(probe: unknown, env: Record<string, string>, covered = true): string {
  const result = spawnSync("perl", ["-MJSON::PP", "-", "0"], {
    input: probeCheckPerl(covered),
    env: { PATH: process.env.PATH, HIVRA_PROBE: JSON.stringify(probe), ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function tsGate(probe: ReturnType<typeof probeJson>): string {
  const parsed = validateIdleProbe(probe);
  const covered = telegramWakeCoverage({
    configured: true,
    hostAllowed: true,
    row: { enabled: true, tokenFp: FP, hasToken: true, blockedUntil: null },
    probe: parsed,
    nowMs: Date.parse("2026-11-13T10:00:00Z"),
  });
  const verdict = idleVerdict(parsed, { manual: false, nowMs: Date.parse("2026-11-13T10:00:00Z"), idleWindowS: 300, horizonS: 1200, cores: 2, coveredChannels: covered });
  return verdict.idle ? "ok" : "active";
}

const gateEnv = { HIVRA_COVERED_CHANNELS: "hermes:telegram", HIVRA_TG_FP: FP };

(hasTools ? describe : describe.skip)("host gate and server gate", () => {
  it.each([
    ["covered Hermes Telegram", probeJson(), "ok"],
    ["a second live channel", probeJson({ liveChannels: ["hermes:telegram", "hermes:discord"] }), "active"],
    ["a gateway that is down", probeJson({ liveChannels: ["hermes:telegram:down"] }), "active"],
    ["the bux Telegram bot", probeJson({ liveChannels: ["telegram:bux-tg"] }), "active"],
    ["a changed token", probeJson({}, { hermesFp: "fedcba9876543210" }), "active"],
    ["no token in .env", probeJson({}, { hermesFp: null, hermesTokenInEnv: false }), "active"],
    ["Hermes in webhook mode", probeJson({}, { hermesWebhookMode: true }), "active"],
    ["a token in config.yaml", probeJson({}, { hermesConfigToken: true }), "active"],
    ["no Telegram facts", probeJson({}, null), "active"],
    ["no live channel at all", probeJson({ liveChannels: [] }), "ok"],
  ])("agree on %s", (_name, probe, expected) => {
    expect(perlGate(probe, gateEnv)).toBe(expected);
    expect(tsGate(probe)).toBe(expected);
  });

  it("refuses names that are not on the allowlist, whatever the server passes", () => {
    const probe = probeJson({ liveChannels: ["hermes:discord"] });
    expect(perlGate(probe, { HIVRA_COVERED_CHANNELS: "hermes:discord", HIVRA_TG_FP: FP })).toBe("active");
    expect(idleVerdict(validateIdleProbe(probe), {
      manual: false, nowMs: Date.parse("2026-11-13T10:00:00Z"), idleWindowS: 300, horizonS: 1200, cores: 2, coveredChannels: ["hermes:discord"],
    }).reasons).toContain("live_channels");
  });

  it("covers nothing without the server's fingerprint, or with the plain gate", () => {
    expect(perlGate(probeJson(), { HIVRA_COVERED_CHANNELS: "hermes:telegram" })).toBe("active");
    expect(perlGate(probeJson(), gateEnv, false)).toBe("active");
    expect(perlGate(probeJson({ liveChannels: [] }), {}, false)).toBe("ok");
  });
});

describe("probe validation", () => {
  it("keeps valid Telegram facts and refuses malformed ones", () => {
    expect(validateIdleProbe(probeJson())?.telegram?.hermesFp).toBe(FP);
    expect(validateIdleProbe(probeJson({}, null))?.telegram).toBeUndefined();
    expect(validateIdleProbe(probeJson({}, { hermesFp: sample }))).toBeNull();
    expect(validateIdleProbe(probeJson({}, { hermesWebhookMode: "no" }))).toBeNull();
  });
});
