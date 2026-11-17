/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseIdleProbeOutput } from "../../agent-sleep-scripts";
import { IDLE_PROBE_PREFIX, IDLE_PROBE_PROGRAM, IDLE_PROBE_VERSION, parseChannelProbeFacts } from "../idle-probe-program";

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
  const GW_LINE = 'hermes_gw = any("hermes" in v[2] and " gateway" in v[2] for v in procs.values())';
  // gatewayRunning pretends a Hermes gateway process is up; without it none is.
  const probe = (opts: { gatewayRunning?: boolean } = {}) => {
    const raw = probeRaw(opts);
    expect(raw.status).toBe(0);
    const parsed = parseIdleProbeOutput(raw.stdout);
    expect(parsed).not.toBeNull();
    expect(raw.stdout.trim().split("\n")).toHaveLength(1);
    return parsed!;
  };
  const probeRaw = (opts: { gatewayRunning?: boolean } = {}) => {
    expect(IDLE_PROBE_PROGRAM).toContain(GW_LINE);
    const program = IDLE_PROBE_PROGRAM
      .replace(GW_LINE, opts.gatewayRunning ? "hermes_gw = True" : "hermes_gw = False")
      .replaceAll('HOME = "/home/bux"', `HOME = ${JSON.stringify(path.join(dir, "home"))}`)
      .replaceAll("/var/spool/cron/crontabs/bux", path.join(dir, "crontab"))
      .replaceAll("/var/spool/cron/atjobs", path.join(dir, "atjobs"))
      .replaceAll("/etc/bux/tg.env", path.join(dir, "tg.env"))
      .replaceAll("/opt/a0/usr/scheduler/tasks.json", path.join(dir, "a0-tasks.json"));
    return spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8", timeout: 20_000 });
  };
  /** The raw JSON object, with the fields the strict parser does not carry. */
  const probeJson = (opts: { gatewayRunning?: boolean } = {}) => {
    const raw = probeRaw(opts);
    expect(raw.status).toBe(0);
    return { stdout: raw.stdout, json: JSON.parse(raw.stdout.slice(IDLE_PROBE_PREFIX.length)) as Record<string, unknown> };
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

  it("calls a scheduler file that is there but unreadable an error, never an empty schedule", () => {
    put("home/.hermes/cron/jobs.json", '{"jobs": [{"enabled": true, "next_run_at": "20');
    const truncated = probe();
    expect(truncated.errors).toContain("json");
    expect(truncated.nextJobAt).toBeNull();
    put("home/.hermes/cron/jobs.json", "");
    expect(probe().errors).toContain("json");
    // A file that is not there at all is just no schedule.
    rmSync(path.join(dir, "home/.hermes/cron/jobs.json"));
    expect(probe().errors).toEqual([]);
  });

  it("reads a connection table longer than one 4 KB read", () => {
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    const row = (n: number, port: string, state: string) =>
      `   ${n}: 0100007F:${port} 0100007F:C350 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${n}\n`;
    let table = header;
    for (let i = 0; i < 80; i++) table += row(i, "1F90", "0A");
    table += row(81, "0016", "01");
    expect(Buffer.byteLength(table)).toBeGreaterThan(4096 * 1.5);
    put("tcp", table);
    const program = IDLE_PROBE_PROGRAM.replaceAll('"/proc/net/tcp"', JSON.stringify(path.join(dir, "tcp")))
      .replaceAll('HOME = "/home/bux"', `HOME = ${JSON.stringify(path.join(dir, "home"))}`);
    const result = spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8", timeout: 20_000 });
    expect(parseIdleProbeOutput(result.stdout)?.sshSessions).toBe(1);
  });

  it("reads every /proc table to its end and lets the alarm through every handler", () => {
    expect(IDLE_PROBE_PROGRAM).toContain("while total < n:");
    expect(IDLE_PROBE_PROGRAM).toContain("class _Timeout(BaseException)");
    expect(IDLE_PROBE_PROGRAM).not.toContain("raise TimeoutError");
  });

  it("records an error when systemctl cannot answer, so a channel is never dropped silently", () => {
    put("tg.env", "TG_BOT_TOKEN=abc\n");
    const broken = IDLE_PROBE_PROGRAM.replace('["systemctl", "is-active", "--quiet", unit]', '["/nonexistent/systemctl", "is-active", "--quiet", unit]')
      .replace("/etc/bux/tg.env", path.join(dir, "tg.env"))
      .replaceAll('HOME = "/home/bux"', `HOME = ${JSON.stringify(path.join(dir, "home"))}`);
    const result = spawnSync("python3", ["-I", "-B", "-c", broken], { encoding: "utf8", timeout: 20_000 });
    expect(parseIdleProbeOutput(result.stdout)?.errors).toContain("systemctl");
  });

  it("prints nothing on stdout and exits non-zero when it fails", () => {
    const broken = IDLE_PROBE_PROGRAM.replace("def has_cron_jobs(text):", "def has_cron_jobs(text):\n    raise RuntimeError('boom')");
    const result = spawnSync("python3", ["-I", "-B", "-c", broken], { encoding: "utf8" });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HIVRA_IDLE_FAILURE");
  });
  describe("Hermes channels", () => {
    it("reports a password-only Matrix login, which the token check alone missed", () => {
      const pw = ["pw", "Q".repeat(12), String(4242)].join("-");
      put("home/.hermes/.env", `MATRIX_HOMESERVER=https://Matrix.Example.test:8448/\nMATRIX_USER_ID=@bot:example.test\nMATRIX_PASSWORD=${pw}\n`);
      const { stdout, json } = probeJson();
      expect(stdout).not.toContain(pw);
      expect(json.liveChannels).toEqual(["hermes:matrix:down"]);
      expect(json.channelFacts).toEqual({ matrix: { homeserverHost: "matrix.example.test", passwordLogin: true } });
      expect(parseChannelProbeFacts(json.channelFacts)).toEqual(json.channelFacts);
    });

    it("reports an sms setup made through .env only", () => {
      put("home/.hermes/.env", "TWILIO_ACCOUNT_SID=AC" + "0".repeat(10) + "\nTWILIO_PHONE_NUMBER=+15550000000\n");
      expect(probe().liveChannels).toEqual(["hermes:sms:down"]);
    });

    it("tells Baileys WhatsApp from the Cloud API and dedupes it against config.yaml", () => {
      put("home/.hermes/.env", "WHATSAPP_CLOUD_PHONE_NUMBER_ID=1\nWHATSAPP_CLOUD_ACCESS_TOKEN=x\n");
      put("home/.hermes/config.yaml", "platforms:\n  whatsapp_cloud:\n    enabled: true\n");
      expect(probe().liveChannels).toEqual(["hermes:whatsapp_cloud:down"]);
      put("home/.hermes/.env", "WHATSAPP_ENABLED=true\n");
      expect(probe().liveChannels).toEqual(["hermes:whatsapp:down", "hermes:whatsapp_cloud:down"]);
      rmSync(path.join(dir, "home/.hermes/config.yaml"));
      expect(probe().liveChannels).toEqual(["hermes:whatsapp:down"]);
    });

    it("reports every platform in a running gateway's record, but not its chat API, the CLI or a disabled one", () => {
      put("home/.hermes/gateway_state.json", JSON.stringify({ gateway_state: "running", platforms: {
        api_server: { state: "connected" }, local: { state: "connected" },
        feishu: { state: "connected" }, irc: { state: "retrying" }, "ops:Line": { state: "fatal" },
        teams: { state: "disabled" }, "bad name!": { state: "connected" },
      } }));
      const p = probe({ gatewayRunning: true });
      expect(p.liveChannels).toEqual(["hermes:badname", "hermes:feishu", "hermes:irc", "hermes:line"]);
      expect(p.errors).toEqual([]);
    });

    it("reads profile gateway records too", () => {
      put("home/.hermes/gateway_state.json", JSON.stringify({ platforms: {} }));
      put("home/.hermes/profiles/ops/gateway_state.json", JSON.stringify({ platforms: { signal: { state: "connected" } } }));
      expect(probe({ gatewayRunning: true }).liveChannels).toEqual(["hermes:signal"]);
    });

    it("calls a missing or corrupt record an error while the gateway runs, so the agent stays awake", () => {
      expect(probe({ gatewayRunning: true }).errors).toContain("gateway_state");
      put("home/.hermes/gateway_state.json", '{"platforms": {"matrix"');
      expect(probe({ gatewayRunning: true }).errors).toContain("gateway_state");
      put("home/.hermes/gateway_state.json", JSON.stringify({ platforms: ["matrix"] }));
      expect(probe({ gatewayRunning: true }).errors).toContain("gateway_state");
      // With no gateway running, a missing or stale record is no error, and a readable one still names its channels.
      expect(probe().errors).toEqual([]);
      put("home/.hermes/gateway_state.json", JSON.stringify({ platforms: { matrix: { state: "connected" } } }));
      expect(probe()).toMatchObject({ errors: [], liveChannels: ["hermes:matrix:down"] });
    });

    it("reports Discord backfill from .env, with config.yaml winning, and never a token", () => {
      const tok = ["dc", "Z".repeat(16), String(31337)].join(".");
      put("home/.hermes/.env", `DISCORD_BOT_TOKEN=${tok}\nDISCORD_MISSED_MESSAGE_BACKFILL=true\nDISCORD_MISSED_MESSAGE_BACKFILL_CHANNELS=111111111111,222222222222\n`);
      let out = probeJson();
      expect(out.stdout).not.toContain(tok);
      expect(out.json.channelFacts).toEqual({ discord: { backfill: true, backfillChannels: 2, backfillAllChannels: false, dmsAllowed: true } });
      put("home/.hermes/config.yaml", "discord:\n  require_mention: true\n  missed_message_backfill:\n    enabled: false\n    channels:\n      - '333333333333'\n  reactions: true\n");
      out = probeJson();
      expect(out.json.channelFacts).toEqual({ discord: { backfill: false, backfillChannels: 1, backfillAllChannels: false, dmsAllowed: true } });
      put("home/.hermes/config.yaml", "discord:\n  missed_message_backfill:\n    enabled: true\n    channels: \"*\"\n");
      expect(probeJson().json.channelFacts).toMatchObject({ discord: { backfill: true, backfillAllChannels: true } });
    });

    it("reports the IMAP host, Telegram webhook mode and Slack Socket Mode, and no secret", () => {
      const pw = ["mail", "P".repeat(12), String(2718)].join("-");
      const app = ["xapp", "1", "A".repeat(10) + "9"].join("-");
      put("home/.hermes/.env", [
        "EMAIL_ADDRESS=bot@example.test", `EMAIL_PASSWORD=${pw}`, "EMAIL_IMAP_HOST=imap.example.test", "EMAIL_SMTP_HOST=smtp.example.test",
        "TELEGRAM_BOT_TOKEN=1:x", "TELEGRAM_WEBHOOK_URL=https://bot.example.test/hook",
        "SLACK_BOT_TOKEN=x", `SLACK_APP_TOKEN=${app}`, "",
      ].join("\n"));
      const { stdout, json } = probeJson();
      for (const secret of [pw, app, "1:x"]) expect(stdout).not.toContain(secret);
      expect(json.channelFacts).toEqual({
        email: { imapHost: "imap.example.test" },
        telegram: { webhookMode: true },
        slack: { socketMode: true },
      });
      expect(parseChannelProbeFacts(json.channelFacts)).toEqual(json.channelFacts);
    });

    it("sends no channel facts when there is no Hermes channel", () => {
      expect(probeJson().json.channelFacts).toBeUndefined();
    });
  });
});

describe("channel facts parser", () => {
  it("accepts what the probe sends and refuses anything else", () => {
    expect(parseChannelProbeFacts(undefined)).toBeUndefined();
    expect(parseChannelProbeFacts({})).toEqual({});
    expect(parseChannelProbeFacts({ matrix: { homeserverHost: null, passwordLogin: false } })).toEqual({ matrix: { homeserverHost: null, passwordLogin: false } });
    expect(parseChannelProbeFacts(null)).toBeNull();
    expect(parseChannelProbeFacts([])).toBeNull();
    expect(parseChannelProbeFacts({ irc: {} })).toBeNull();
    expect(parseChannelProbeFacts({ matrix: { homeserverHost: "has space", passwordLogin: false } })).toBeNull();
    expect(parseChannelProbeFacts({ email: { imapHost: 5 } })).toBeNull();
    expect(parseChannelProbeFacts({ discord: { backfill: true, backfillChannels: -1, backfillAllChannels: false, dmsAllowed: true } })).toBeNull();
    expect(parseChannelProbeFacts({ slack: { socketMode: "yes" } })).toBeNull();
    expect(parseChannelProbeFacts({ telegram: {} })).toBeNull();
  });
});
