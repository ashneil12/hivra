/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_WAKE_PROFILES,
  COMPUTER_PROFILE,
  agentProfilesEnabled,
  assertAgentWakeProfile,
  effectiveWakeProfile,
  probeProfileFor,
  probeProfileJson,
  telegramWakeKinds,
  telegramWakeSource,
  wakeSourceFor,
} from "..";
import { probeEndpoints, procNetAddresses } from "../endpoints";
import {
  buildIdleProbeHostScript,
  buildSleepHostScript,
  buildTelegramTokenReadHostScript,
  buildTelegramTokenReadProgram,
  idleVerdict,
  parseTelegramTokenRead,
  probeCheckPerl,
} from "../../agent-sleep-scripts";
import { IDLE_PROBE_PROGRAM } from "../../sleep/idle-probe-program";
import { channelGatePerl, coverableProbeTags, DISCORD_CHANNEL_SPEC, EMAIL_CHANNEL_SPEC, MATRIX_CHANNEL_SPEC, TELEGRAM_CHANNEL_SPEC } from "../../channel-wake/registry";
import { telegramCoverageBlockers } from "../../telegram-wake/coverage";
import { shellQuote } from "../../proxmox-target";

const ON = { HIVRA_AGENT_PROFILES: "on" };

describe("the registry", () => {
  it("has a profile for every agent type in the catalog, and nothing else", () => {
    const catalog = readFileSync(path.join(__dirname, "../../agent-catalog.ts"), "utf8");
    const ids = [...catalog.matchAll(/^\s{4}id: "([a-z-]+)",$/gm)].map((m) => m[1]).sort();
    expect(ids.length).toBeGreaterThanOrEqual(11);
    expect(AGENT_WAKE_PROFILES.map((p) => p.type).sort()).toEqual(ids);
  });

  it("holds only well formed profiles", () => {
    for (const profile of [COMPUTER_PROFILE, ...AGENT_WAKE_PROFILES]) expect(() => assertAgentWakeProfile(profile)).not.toThrow();
    expect(() => assertAgentWakeProfile({ ...COMPUTER_PROFILE, activity: [{ path: "~/../etc", depth: 1, budget: 1 }] })).toThrow();
    expect(() => assertAgentWakeProfile({ ...COMPUTER_PROFILE, busy: [{}] })).toThrow();
    expect(() => assertAgentWakeProfile({ ...COMPUTER_PROFILE, wake: { telegram: { tag: "x:discord", credential: [{ kind: "env", path: "~/.env", key: "A" }], catchUp: { kind: "none" } } } })).toThrow();
    expect(() => assertAgentWakeProfile({ ...COMPUTER_PROFILE, appPorts: [70000] })).toThrow();
  });

  it("names Hermes's credentials exactly where the channel wake adapters fingerprint them", () => {
    const hermes = AGENT_WAKE_PROFILES.find((p) => p.type === "hermes")!;
    const keys = (platform: "telegram" | "matrix" | "email" | "discord") =>
      hermes.wake[platform]!.credential.map((l) => (l.kind === "env" ? `${l.path}#${l.key}` : "?"));
    expect(keys("telegram")).toEqual(TELEGRAM_CHANNEL_SPEC.credKeys.map((k) => `~/.hermes/.env#${k}`));
    for (const spec of [MATRIX_CHANNEL_SPEC, EMAIL_CHANNEL_SPEC, DISCORD_CHANNEL_SPEC]) {
      expect(keys(spec.channel as "matrix" | "email" | "discord")).toEqual(spec.credKeys.map((k) => `~/.hermes/.env#${k}`));
      expect(hermes.wake[spec.channel as "matrix"]!.tag).toBe(spec.probeTag);
    }
  });

  it("detects with every profile for every type; the type's own only chooses its wake and CPU processes", () => {
    const unknown = effectiveWakeProfile("future-agent");
    expect(unknown.type).toBe("unknown");
    expect(unknown.wake).toEqual({});
    expect(unknown.appPorts).toEqual(expect.arrayContaining([3080, 3102]));
    const detection = (p: ReturnType<typeof effectiveWakeProfile>) => ({
      busy: p.busy, activity: p.activity, schedules: p.schedules, channels: p.channels, ports: p.appPorts, facts: p.hermesFacts,
    });
    const sorted = (p: ReturnType<typeof effectiveWakeProfile>) => {
      const d = detection(p);
      const by = (xs: readonly unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
      return { ...d, busy: by(d.busy), activity: by(d.activity), schedules: by(d.schedules), channels: by(d.channels) };
    };
    for (const profile of AGENT_WAKE_PROFILES) {
      const own = effectiveWakeProfile(profile.type);
      expect(own.type).toBe(profile.type);
      expect(own.wake).toEqual(profile.wake);
      expect(own.agentProcesses).toEqual(profile.agentProcesses);
      // A desktop or Claude Code computer with Hermes or OpenClaw installed still sees their jobs and channels.
      expect(sorted(own)).toEqual(sorted(unknown));
    }
    const codex = effectiveWakeProfile("codex");
    expect(codex.schedules.map((s) => s.kind)).toEqual(expect.arrayContaining(["hermes-jobs", "json-next-run", "json-nonempty", "crontab", "dir-nonempty"]));
    expect(codex.channels[0].kind).toBe("systemd-env");
    // The type's own entries come first, the computer's schedules last.
    expect(effectiveWakeProfile("openclaw").schedules[0].kind).toBe("json-next-run");
    expect(codex.schedules.at(-1)!.kind).toBe("dir-nonempty");
  });

  it("declares catch-up honestly: Telegram on Hermes and OpenClaw; nothing on agents without chat", () => {
    expect(wakeSourceFor("openclaw", "telegram")?.tag).toBe("openclaw:telegram");
    expect(wakeSourceFor("openclaw", "discord")).toBeNull();
    for (const type of ["claude-code", "codex", "agent-zero", "openbot", "nuphos", "deepseek-harness", "linux-desktop"]) {
      expect(AGENT_WAKE_PROFILES.find((p) => p.type === type)!.wake).toEqual({});
    }
    expect(wakeSourceFor("hermes", "discord")?.catchUp.kind).toBe("backfill-setting");
  });
});

describe("the switch", () => {
  it("is off unless set to on", () => {
    expect(agentProfilesEnabled({})).toBe(false);
    expect(agentProfilesEnabled({ HIVRA_AGENT_PROFILES: "canary" })).toBe(false);
    expect(agentProfilesEnabled(ON)).toBe(true);
    expect(telegramWakeKinds({})).toEqual(["hermes"]);
    expect(telegramWakeKinds(ON)).toEqual(["hermes", "openclaw"]);
    expect(telegramWakeSource("openclaw", {})).toBeNull();
    expect(telegramWakeSource("openclaw", ON)?.tag).toBe("openclaw:telegram");
    expect(telegramWakeSource("future-agent", ON)).toBeNull();
  });

  it("off, every probe and sleep script is the one sent before", () => {
    const target = { vmid: 123, bindingTag: "hivra-x" };
    expect(buildIdleProbeHostScript(target)).toContain(shellQuote(IDLE_PROBE_PROGRAM));
    expect(buildIdleProbeHostScript(target, { profile: null })).toBe(buildIdleProbeHostScript(target));
    expect(buildTelegramTokenReadHostScript(target, null)).toBe(buildTelegramTokenReadHostScript(target));
    const on = buildIdleProbeHostScript(target, { profile: probeProfileFor("codex") });
    expect(on).not.toContain(shellQuote(IDLE_PROBE_PROGRAM));
    expect(on).toContain("PROFILE_B64");
    const sleep = buildSleepHostScript({ ...target, tier: "nap", manual: false, profile: probeProfileFor("openclaw"),
      telegramCoverage: { channels: ["openclaw:telegram"], fingerprint: "0123456789abcdef", tag: "openclaw:telegram" } });
    expect(sleep).toContain("PROFILE_B64");
    expect(sleep).toContain(`my %allowed = map { $_ => 1 } ("openclaw:telegram");`);
    expect(sleep.includes("\0")).toBe(false);
  });
});

describe("the chat endpoints", () => {
  it("writes addresses the way /proc/net/tcp prints them", () => {
    expect(procNetAddresses("192.0.2.10")).toEqual(["0A0200C0", "0000000000000000FFFF00000A0200C0"]);
    expect(procNetAddresses("2001:db8::1")).toEqual(["B80D0120000000000000000001000000"]);
    expect(procNetAddresses("::ffff:192.0.2.10")).toEqual(["0000000000000000FFFF00000A0200C0"]);
    expect(procNetAddresses("not.an.address")).toBeNull();
    expect(procNetAddresses("1:2:3")).toBeNull();
    const endpoints = probeEndpoints({ telegram: ["192.0.2.10"], nope: ["198.51.100.1"] });
    expect(endpoints[0]).toEqual(
      { p: "telegram", ports: [443, 80, 88, 8443], h: ["api.telegram.org"], a: ["0000000000000000FFFF00000A0200C0", "0A0200C0"] },
    );
    // Every service goes to the probe with its names, which the probe resolves on the guest too.
    expect(endpoints.map((e) => e.p)).toEqual(["telegram", "discord", "slack", "whatsapp", "matrix", "signal"]);
    expect(endpoints.slice(1).every((e) => e.a.length === 0 && e.h!.length > 0)).toBe(true);
    expect(() => probeProfileJson(probeProfileFor("codex", { endpoints }))).not.toThrow();
  });

  it("refuses anything but addresses in the probe input", () => {
    expect(() => probeProfileJson(probeProfileFor("codex", { endpoints: [{ p: "telegram", ports: [443], a: ["192.0.2.10"] }] }))).toThrow();
    const json = JSON.parse(probeProfileJson(probeProfileFor("codex", { endpoints: [{ p: "telegram", ports: [443], a: ["0A0200C0"] }] })));
    expect(json.endpoints).toEqual([{ p: "telegram", ports: [443], a: ["0A0200C0"] }]);
    expect(json.cpu).toEqual({ pct: 25, ms: 500 });
    for (const h of [["bad host"], ["x\"y.example.test"], ["a.example.test", "b.example.test", "c.example.test", "d.example.test", "e.example.test"], ["nodot"]]) {
      expect(() => probeProfileJson(probeProfileFor("codex", { endpoints: [{ p: "telegram", ports: [443], h, a: [] }] }))).toThrow();
    }
  });
});

describe("Telegram covered through a profile's channel", () => {
  const facts = { hermesFp: "0123456789abcdef", hermesTokenInEnv: true, hermesWebhookMode: false, hermesConfigToken: false };
  const row = { enabled: true, tokenFp: "0123456789abcdef", hasToken: true, blockedUntil: null };
  const input = (liveChannels: string[], tag?: string) => ({
    configured: true, hostAllowed: true, row, nowMs: 0, probe: { liveChannels, telegram: facts }, ...(tag ? { tag } : {}),
  });

  it("covers the profile's tag only, and never an unknown chat connection", () => {
    expect(telegramCoverageBlockers(input(["openclaw:telegram"], "openclaw:telegram"))).toEqual([]);
    expect(telegramCoverageBlockers(input(["openclaw:telegram"]))).toEqual(["other_channel"]);
    expect(telegramCoverageBlockers(input(["openclaw:telegram", "unknown:telegram"], "openclaw:telegram"))).toEqual(["other_channel"]);
    expect(telegramCoverageBlockers(input(["hermes:telegram"]))).toEqual([]);
  });

  it("lets the verdict and both host gates allow the same tag", () => {
    expect(coverableProbeTags([], "openclaw:telegram")).toEqual(["openclaw:telegram"]);
    expect(channelGatePerl(undefined, "openclaw:telegram")).toContain(`$ok{"openclaw:telegram"}`);
    expect(() => channelGatePerl(undefined, "openclaw:discord")).toThrow();
    const probe = {
      v: 1, errors: [], activeRuns: 0, cliProcesses: 0, openConnections: 0, gatewayConnections: 0, terminalAttached: false,
      terminalClients: 0, sshSessions: 0, desktopAttached: false, lastUsedAt: null, nextJobAt: null, liveChannels: ["openclaw:telegram"],
      loadavg: [0, 0, 0], cpus: 2, uptimeS: 99999, now: "2026-11-13T00:00:00Z", ms: 5,
    };
    const options = { manual: false, nowMs: 0, idleWindowS: 60, horizonS: 60, cores: 2, coveredChannels: ["openclaw:telegram"] };
    expect(idleVerdict(probe, options).reasons).toContain("live_channels");
    expect(idleVerdict(probe, { ...options, telegramTag: "openclaw:telegram" }).idle).toBe(true);
    expect(idleVerdict({ ...probe, liveChannels: ["openclaw:telegram", "unknown:telegram"] }, { ...options, telegramTag: "openclaw:telegram" }).idle).toBe(false);
  });

  const perl = spawnSync("which", ["perl"]).status === 0 ? it : it.skip;
  perl("runs the host gate: the profile's tag passes, an unknown channel stays awake", () => {
    const gate = (liveChannels: string[], tag: string) => spawnSync("perl", ["-MJSON::PP", "-", "0"], {
      input: probeCheckPerl(true, tag),
      encoding: "utf8",
      env: {
        ...process.env,
        HIVRA_COVERED_CHANNELS: tag,
        HIVRA_TG_FP: "0123456789abcdef",
        HIVRA_PROBE: JSON.stringify({ activeRuns: 0, cliProcesses: 0, liveChannels, errors: [], openConnections: 0, sshSessions: 0,
          terminalAttached: false, desktopAttached: false, telegram: facts }),
      },
    }).stdout.trim();
    expect(gate(["openclaw:telegram"], "openclaw:telegram")).toBe("ok");
    expect(gate(["openclaw:telegram", "unknown:telegram"], "openclaw:telegram")).toBe("active");
    expect(gate(["openclaw:telegram"], "hermes:telegram")).toBe("active");
  });
});

const py = spawnSync("python3", ["--version"]).status === 0 ? describe : describe.skip;
py("the Telegram token read from a profile's location", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "hivra-tg-read-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const read = (type: string) => {
    const program = buildTelegramTokenReadProgram(telegramWakeSource(type, ON)!).replace('HOME = "/home/bux"', `HOME = ${JSON.stringify(dir)}`);
    return parseTelegramTokenRead(spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8" }).stdout);
  };
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  const token = ["1234567", "B".repeat(35)].join(":");

  it("reads OpenClaw's bot token from openclaw.json, and refuses its own webhook", () => {
    expect(read("openclaw")).toEqual({ ok: false, reason: "no_env" });
    put(".openclaw/openclaw.json", JSON.stringify({ channels: { telegram: {} } }));
    expect(read("openclaw")).toEqual({ ok: false, reason: "no_token" });
    put(".openclaw/openclaw.json", JSON.stringify({ channels: { telegram: { botToken: token } } }));
    expect(read("openclaw")).toEqual({ ok: true, token });
    put(".openclaw/openclaw.json", JSON.stringify({ channels: { telegram: { botToken: token, webhookUrl: "https://bot.example.test/h" } } }));
    expect(read("openclaw")).toEqual({ ok: false, reason: "webhook_mode" });
  });

  it("reads Hermes's token from .env as the fixed read does", () => {
    put(".hermes/.env", `TELEGRAM_BOT_TOKEN='${token}'\n`);
    expect(read("hermes")).toEqual({ ok: true, token });
    put(".hermes/.env", "TELEGRAM_BOT_TOKEN=short\n");
    expect(read("hermes")).toEqual({ ok: false, reason: "bad_shape" });
  });
});
