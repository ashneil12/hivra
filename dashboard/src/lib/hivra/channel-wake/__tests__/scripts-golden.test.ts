/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildIdleProbeHostScript,
  buildSleepHostScript,
  buildWakeHostScript,
  idleProbeProgramFor,
  idleVerdict,
  probeCheckPerl,
  validateIdleProbe,
} from "../../agent-sleep-scripts";
import { IDLE_PROBE_PROGRAM, IDLE_PROBE_TELEGRAM_PROGRAM, TELEGRAM_ENV_VALUE_PY } from "../../sleep/idle-probe-program";
import {
  CHANNEL_WAKE_COVERABLE,
  TELEGRAM_HOST_CHECK_PERL,
  allowedCoveredChannels,
  channelFpsEnv,
  channelFpsPython,
  channelGatePerl,
  coverableProbeTags,
  standardChannelBlockers,
} from "../registry";
import { TELEGRAM_WAKE_COVERABLE_CHANNELS } from "../../telegram-wake/coverage";
import type { ChannelWakeSpec } from "../types";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const target = { vmid: 123, bindingTag: "hivra-x" };
const admission = { provisionerDirectory: "/opt/hivra", hostReserveMb: 2048, enforceCeilings: true, cpuDensityMilli: 1500, memoryDensityMilli: 1200 };
const TG = { channels: ["hermes:telegram"], fingerprint: "0123456789abcdef" };

/** A made-up generic channel, standing in for the adapters later packages add. */
const EMAIL: ChannelWakeSpec = {
  channel: "email",
  probeTag: "hermes:email",
  detector: "host-doorbell",
  catchUp: "native",
  needsServerDisarm: false,
  socketBased: false,
  credKeys: ["EMAIL_ADDRESS", "EMAIL_IMAP_HOST"],
  coverageBlockers: (input) => standardChannelBlockers(EMAIL, input),
  hostFactsPerl: `defined($f) && defined($f->{imapHost}) && !ref($f->{imapHost})`,
};
const SPECS = [EMAIL];

describe("only Telegram on: script goldens", () => {
  // Taken from the code before the channel framework (merge 215a8f89). The
  // port must change nothing for a Telegram-only sleep or wake. Sleep and idle
  // probe goldens include the OpenClaw SQLite scheduler reader, and wake
  // goldens include the Hibernate timing breakdown.
  it("pins the sleep, probe, and wake scripts", () => {
    expect(digest(buildSleepHostScript({ ...target, tier: "nap", manual: false, telegramCoverage: TG })))
      .toBe("3de559fa827c5359a9f41ac959fc26563a38a963e5c05c181cd27b0fec09f5e0");
    expect(digest(buildSleepHostScript({ ...target, tier: "hibernate", manual: true, telegramCoverage: TG, fastConfigRead: true })))
      .toBe("78c965185554dfcc728d031a93911ec746caa4c673a24bd17efce805ce10df9d");
    expect(digest(buildSleepHostScript({ ...target, tier: "nap", manual: false })))
      .toBe("0e2dbd1db0723810871482066af818cb4dc6b2e14ddc6e6ae7c120115fdcf2aa");
    expect(digest(buildIdleProbeHostScript(target, { telegram: true })))
      .toBe("8adb309a735272e0461c4eb36dd5a03cab1fb518cc2a615c0ca7bef61bc8ea36");
    expect(digest(buildIdleProbeHostScript(target)))
      .toBe("cd2ed17a796fedf965e79c39818c252c1c2f2d5a0639da15a2cf7644c37fe67f");
    expect(digest(buildWakeHostScript({ ...target, admission, killStaleSockets: true })))
      .toBe("90934cf34659797907aba8a771141465e7ab4ba6121608198b419a5b569c7146");
    expect(digest(buildWakeHostScript({ ...target, admission })))
      .toBe("92e1752d8ec949c9f36f161452f994471c3f90d117f5d8ce16564f8eb484742b");
    expect(digest(probeCheckPerl(true))).toBe("0f06351c81edca56943372443cce8196990507aae5b919df68dea119d1915fb4");
    expect(digest(probeCheckPerl(false))).toBe("34d60e88afa04451c81cf8d2e45dbb3ff911b4e480a05af4f5d32b0813826284");
  });

  it("asks the probe for nothing new with no generic channel", () => {
    expect(idleProbeProgramFor({})).toBe(IDLE_PROBE_PROGRAM);
    expect(idleProbeProgramFor({ telegram: true })).toBe(IDLE_PROBE_TELEGRAM_PROGRAM);
  });

  it("keeps Telegram's own allowlist to Telegram; the general one adds Matrix, email and Discord", () => {
    // The Telegram-only gate (probeCheckPerl(true)) never reads the general registry.
    expect(TELEGRAM_WAKE_COVERABLE_CHANNELS).toEqual(["hermes:telegram"]);
    expect(CHANNEL_WAKE_COVERABLE).toEqual(["hermes:telegram", "hermes:matrix", "hermes:email", "hermes:discord"]);
    expect(probeCheckPerl(true)).toContain(`my %allowed = map { $_ => 1 } ("hermes:telegram");`);
    // The general gate's Telegram check is the legacy one, word for word.
    expect(probeCheckPerl(true)).toContain(TELEGRAM_HOST_CHECK_PERL);
    expect(channelGatePerl([])).toContain(TELEGRAM_HOST_CHECK_PERL);
  });

  it("refuses a channel coverage that covers only Telegram, and both forms at once", () => {
    expect(() => buildSleepHostScript({ ...target, tier: "nap", manual: false,
      channelCoverage: { channels: ["hermes:telegram"], fingerprints: { telegram: TG.fingerprint } } }, SPECS)).toThrow();
    expect(() => buildSleepHostScript({ ...target, tier: "nap", manual: false, telegramCoverage: TG,
      channelCoverage: { channels: ["hermes:email"], fingerprints: { email: "fedcba9876543210" } } }, SPECS)).toThrow();
  });
});

describe("registry", () => {
  it("builds the TypeScript and Perl allowlists from the same array", () => {
    expect(coverableProbeTags(SPECS)).toEqual(["hermes:telegram", "hermes:email"]);
    expect(channelGatePerl(SPECS)).toContain(`my %allowed = map { $_ => 1 } ("hermes:telegram", "hermes:email");`);
    expect(allowedCoveredChannels(["hermes:email", "hermes:discord", "hermes:email"], SPECS)).toEqual(["hermes:email"]);
    expect(allowedCoveredChannels(["hermes:slack", "openclaw:discord"])).toEqual([]);
  });

  it("refuses bad specs and bad fingerprints", () => {
    expect(() => channelGatePerl([{ ...EMAIL, credKeys: ["lower"] }])).toThrow();
    expect(() => channelGatePerl([EMAIL, EMAIL])).toThrow();
    expect(() => channelGatePerl([{ ...EMAIL, hostFactsPerl: "$ENV{HIVRA_X}" }])).toThrow();
    expect(() => channelFpsEnv({ email: "nothex" })).toThrow();
    expect(channelFpsEnv({ telegram: "0123456789abcdef", email: "fedcba9876543210" })).toBe("email:fedcba9876543210,telegram:0123456789abcdef");
  });

  it("puts the fingerprint lines in the probe, with no NUL and no value", () => {
    const program = idleProbeProgramFor({ channels: ["email"] }, SPECS);
    expect(program).toContain(channelFpsPython(["email"], SPECS));
    expect(program).toContain(`OUT["channelFps"] = {"email": chan_fp(["EMAIL_ADDRESS","EMAIL_IMAP_HOST"])}`);
    expect(program.includes("\0")).toBe(false);
    expect(() => idleProbeProgramFor({ channels: ["matrix"] }, SPECS)).toThrow();
  });

  it("standard blockers: opt-in, block, fingerprint", () => {
    const probe = { liveChannels: ["hermes:email"], channelFps: { email: "fedcba9876543210" } };
    const row = { enabled: true, credFp: "fedcba9876543210", blockedUntil: null };
    expect(standardChannelBlockers(EMAIL, { acts: true, row, probe, nowMs: 0 })).toEqual([]);
    expect(standardChannelBlockers(EMAIL, { acts: false, row: null, probe: null, nowMs: 0 }))
      .toEqual(["not_configured", "not_opted_in", "no_probe"]);
    expect(standardChannelBlockers(EMAIL, { acts: true, row, probe: { ...probe, channelFps: { email: "0000000000000000" } }, nowMs: 0 }))
      .toEqual(["credential_changed"]);
    expect(standardChannelBlockers(EMAIL, { acts: true, row: { ...row, blockedUntil: "2999-01-01T00:00:00Z" }, probe, nowMs: 0 }))
      .toEqual(["blocked"]);
  });
});

describe("the probe answer", () => {
  const base = {
    v: 1, errors: [], activeRuns: 0, cliProcesses: 0, openConnections: 0, gatewayConnections: 0, terminalAttached: false,
    terminalClients: 0, sshSessions: 0, desktopAttached: false, lastUsedAt: null, nextJobAt: null, liveChannels: ["hermes:email"],
    loadavg: [0, 0, 0], cpus: 2, uptimeS: 99999, now: "2026-11-13T00:00:00Z", ms: 5,
  };

  it("keeps channel facts only with fingerprints, and refuses bad fingerprints", () => {
    expect(validateIdleProbe({ ...base, channelFacts: { email: { imapHost: "imap.example.test" } } })).not.toHaveProperty("channelFacts");
    const withFps = validateIdleProbe({ ...base, channelFps: { email: "fedcba9876543210" }, channelFacts: { email: { imapHost: "imap.example.test" } } });
    expect(withFps?.channelFps).toEqual({ email: "fedcba9876543210" });
    expect(withFps?.channelFacts).toEqual({ email: { imapHost: "imap.example.test" } });
    expect(validateIdleProbe({ ...base, channelFps: { email: "bad" } })).toBeNull();
    expect(validateIdleProbe({ ...base, channelFps: { nosuch: null } })).toBeNull();
    expect(validateIdleProbe({ ...base, channelFps: { email: null }, channelFacts: "junk" })).not.toHaveProperty("channelFacts");
  });

  it("server verdict: covered only through the spec list", () => {
    const opts = { manual: false, nowMs: Date.parse(base.now), idleWindowS: 60, horizonS: 60, cores: 2 };
    // Slack has no spec in the registry, so naming it covers nothing.
    expect(idleVerdict({ ...base, liveChannels: ["hermes:slack"] }, { ...opts, coveredChannels: ["hermes:slack"] }).reasons).toEqual(["live_channels"]);
    expect(idleVerdict(base, { ...opts, coveredChannels: ["hermes:email"], channelSpecs: SPECS }).idle).toBe(true);
    // A union: one uncovered live channel still blocks.
    expect(idleVerdict({ ...base, liveChannels: ["hermes:email", "hermes:discord"] },
      { ...opts, coveredChannels: ["hermes:email"], channelSpecs: SPECS }).reasons).toEqual(["live_channels"]);
  });
});

const hasPerl = spawnSync("which", ["perl"]).status === 0;
(hasPerl ? describe : describe.skip)("the general host gate", () => {
  const quiet = {
    activeRuns: 0, cliProcesses: 0, openConnections: 0, sshSessions: 0, terminalAttached: false, desktopAttached: false, errors: [],
  };
  const tg = { hermesFp: "0123456789abcdef", hermesTokenInEnv: true, hermesWebhookMode: false, hermesConfigToken: false };
  const email = { channelFps: { email: "fedcba9876543210" }, channelFacts: { email: { imapHost: "imap.example.test" } } };
  const FPS = "telegram:0123456789abcdef,email:fedcba9876543210";

  // The gate is the full probe check with the general channel rule in it.
  const full = (probe: Record<string, unknown>, covered: string, fps: string) => {
    const perl = buildSleepHostScript({ ...target, tier: "nap", manual: false,
      channelCoverage: { channels: ["hermes:email"], fingerprints: { email: "fedcba9876543210" } } }, SPECS);
    const body = perl.split("<<'HIVRA_PROBE_CHECK'\n")[1].split("\nHIVRA_PROBE_CHECK")[0];
    const run = spawnSync("perl", ["-MJSON::PP", "-", "0"], {
      input: body,
      env: { ...process.env, HIVRA_PROBE: JSON.stringify(probe), HIVRA_COVERED_CHANNELS: covered, HIVRA_CHANNEL_FPS: fps },
      encoding: "utf8",
    });
    return run.stdout.trim();
  };

  it("lets an email-only agent sleep when its fingerprint and facts match", () => {
    expect(full({ ...quiet, ...email, liveChannels: ["hermes:email"] }, "hermes:email", "email:fedcba9876543210")).toBe("ok");
  });

  it("keeps it awake on a changed credential, missing facts, or an uncovered channel", () => {
    expect(full({ ...quiet, ...email, channelFps: { email: "0000000000000000" }, liveChannels: ["hermes:email"] }, "hermes:email", "email:fedcba9876543210")).toBe("active");
    expect(full({ ...quiet, channelFps: email.channelFps, liveChannels: ["hermes:email"] }, "hermes:email", "email:fedcba9876543210")).toBe("active");
    expect(full({ ...quiet, ...email, liveChannels: ["hermes:email", "hermes:discord"] }, "hermes:email", "email:fedcba9876543210")).toBe("active");
    expect(full({ ...quiet, ...email, liveChannels: ["hermes:email"] }, "", "email:fedcba9876543210")).toBe("active");
  });

  it("applies the Telegram facts to Telegram only", () => {
    const both = { ...quiet, ...email, telegram: tg, liveChannels: ["hermes:email", "hermes:telegram"] };
    expect(full(both, "hermes:email,hermes:telegram", FPS)).toBe("ok");
    expect(full({ ...both, telegram: { ...tg, hermesWebhookMode: true } }, "hermes:email,hermes:telegram", FPS)).toBe("active");
    // Telegram facts do not matter to an email-only agent.
    expect(full({ ...quiet, ...email, liveChannels: ["hermes:email"] }, "hermes:email", "email:fedcba9876543210")).toBe("ok");
  });

  it("still sleeps with no live channel at all", () => {
    expect(full({ ...quiet, liveChannels: [] }, "hermes:email", "email:fedcba9876543210")).toBe("ok");
  });
});

const hasPython = spawnSync("which", ["python3"]).status === 0;
(hasPython ? describe : describe.skip)("the probe's fingerprint lines", () => {
  it("print the sha256 prefix of the joined values, and None when one is missing", () => {
    const run = (envText: string) => {
      const program = [
        "import json, re",
        TELEGRAM_ENV_VALUE_PY,
        `env = ${JSON.stringify(envText)}`,
        "OUT = {}",
        channelFpsPython(["email"], SPECS),
        "print(json.dumps(OUT))",
      ].join("\n");
      const out = spawnSync("python3", ["-I", "-c", program], { encoding: "utf8" });
      return JSON.parse(out.stdout) as { channelFps: Record<string, string | null> };
    };
    const expected = createHash("sha256").update("bot@example.test\nimap.example.test").digest("hex").slice(0, 16);
    const both = run("EMAIL_ADDRESS=bot@example.test\nEMAIL_IMAP_HOST=imap.example.test\nEMAIL_PASSWORD=hunter\n");
    expect(both.channelFps).toEqual({ email: expected });
    expect(JSON.stringify(both)).not.toContain("hunter");
    expect(run("EMAIL_ADDRESS=bot@example.test\n").channelFps).toEqual({ email: null });
  });
});
