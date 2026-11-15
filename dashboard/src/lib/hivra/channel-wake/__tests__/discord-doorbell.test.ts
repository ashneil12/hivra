/** @jest-environment node */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("../../agent-wake", () => ({ resolveSleepTarget: jest.fn(), readHivraAgentRow: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn(), runProxmoxHostScriptWithStdin: jest.fn() }));

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DOORBELL_ARM_PREFIX, EMAIL_CRED_READ_PROGRAM, EMAIL_DOORBELL_KEYS, parseWakeDoorbells, wakeDoorbellEnabled } from "../doorbell-scripts";
import {
  CHANNEL_WAKE_COVERABLE,
  DISCORD_CHANNEL_SPEC,
  EMAIL_CHANNEL_SPEC,
  GENERIC_CHANNEL_SPECS,
  allowedCoveredChannels,
  channelFpsPython,
} from "../registry";
import {
  DISCORD_CRED_READ_PROGRAM,
  DISCORD_DOORBELL_KEYS,
  buildDiscordDoorbellArmHostScript,
  parseDiscordDoorbellArmOutput,
} from "../adapters/discord-doorbell-scripts";
import { createDiscordDoorbellAdapter, DISCORD_DOORBELL_ADAPTER, readDiscordOptIn } from "../adapters/discord-doorbell";
import { CHANNEL_WAKE_ADAPTERS, channelCoverageFor } from "../lifecycle";
import { buildChannelCredReadProgram, buildSleepHostScript, idleVerdict } from "../../agent-sleep-scripts";

const AGENT = "00000000-0000-4000-8000-0000000a0012";
const ARM = "00000000-0000-4fdd-85f4-f955ee4104e2";
const FP = "0123456789abcdef";
const DOORBELL_PY = path.join(process.cwd(), "provisioner/hivra-wake-doorbell.py");
const target = { vmid: 1234, bindingTag: "hivra-binding-test", env: { host: "x" } };
const ON = { HIVRA_WAKE_DOORBELLS: "email,discord", HIVRA_INGRESS_HOST_CREDENTIAL: "true" };
const facts = { backfill: true, backfillChannels: 1, backfillAllChannels: false, dmsAllowed: true };
const probe = { liveChannels: ["hermes:discord"], channelFps: { discord: FP }, channelFacts: { discord: facts } };
const row = { enabled: true, credFp: FP, blockedUntil: null };

describe("the doorbell switch", () => {
  it("lists discord on its own; email alone leaves Discord off", () => {
    expect([...parseWakeDoorbells("discord")]).toEqual(["discord"]);
    expect(wakeDoorbellEnabled("discord", { HIVRA_WAKE_DOORBELLS: "email" })).toBe(false);
    expect(wakeDoorbellEnabled("discord", {})).toBe(false);
    expect(wakeDoorbellEnabled("discord", ON)).toBe(true);
  });
});

describe("Discord in the registry", () => {
  it("is a socket-based host-doorbell channel that needs Hermes's catch-up", () => {
    expect(GENERIC_CHANNEL_SPECS).toContain(DISCORD_CHANNEL_SPEC);
    expect(CHANNEL_WAKE_COVERABLE).toContain("hermes:discord");
    expect(DISCORD_CHANNEL_SPEC).toMatchObject({
      probeTag: "hermes:discord", detector: "host-doorbell", needsServerDisarm: false, socketBased: true,
      catchUp: "needs-config:DISCORD_MISSED_MESSAGE_BACKFILL", credKeys: ["DISCORD_BOT_TOKEN"],
    });
  });

  it("blocks without catch-up, without a DM channel listed, or without facts", () => {
    const blockers = (f: unknown) => DISCORD_CHANNEL_SPEC.coverageBlockers({
      acts: true, row, probe: { ...probe, channelFacts: f === undefined ? {} : { discord: f as typeof facts } }, nowMs: 0 });
    expect(blockers(facts)).toEqual([]);
    expect(blockers({ ...facts, backfill: false })).toEqual(["backfill_off"]);
    expect(blockers({ ...facts, backfillChannels: 0 })).toEqual(["dm_not_backfilled"]);
    // "*" scans guild channels only, never DMs.
    expect(blockers({ ...facts, backfillChannels: 0, backfillAllChannels: true })).toEqual(["dm_not_backfilled"]);
    expect(blockers({ ...facts, backfill: false, backfillChannels: 0 })).toEqual(["backfill_off", "dm_not_backfilled"]);
    expect(blockers(undefined)).toEqual(["no_discord_facts"]);
  });

  it("never covers OpenClaw's Discord", () => {
    expect(allowedCoveredChannels(["openclaw:discord", "hermes:discord"])).toEqual(["hermes:discord"]);
    const opts = { manual: false, nowMs: Date.parse("2026-11-13T00:00:00Z"), idleWindowS: 60, horizonS: 60, cores: 2 };
    const base = {
      v: 1, errors: [], activeRuns: 0, cliProcesses: 0, openConnections: 0, gatewayConnections: 0, terminalAttached: false,
      terminalClients: 0, sshSessions: 0, desktopAttached: false, lastUsedAt: null, nextJobAt: null,
      loadavg: [0, 0, 0], cpus: 2, uptimeS: 99999, now: "2026-11-13T00:00:00Z", ms: 5,
    };
    expect(idleVerdict({ ...base, liveChannels: ["openclaw:discord"] }, { ...opts, coveredChannels: ["openclaw:discord", "hermes:discord"] }).reasons)
      .toEqual(["live_channels"]);
    expect(idleVerdict({ ...base, liveChannels: ["hermes:discord"] }, { ...opts, coveredChannels: ["hermes:discord"] }).idle).toBe(true);
  });

  it("adds doorbell_off in the adapter until HIVRA_WAKE_DOORBELLS lists discord", () => {
    const input = { acts: true, row, probe, nowMs: 0 };
    expect(createDiscordDoorbellAdapter({ env: { HIVRA_WAKE_DOORBELLS: "email" } }).coverageBlockers(input)).toEqual(["doorbell_off"]);
    const noCredential = createDiscordDoorbellAdapter({ env: { HIVRA_WAKE_DOORBELLS: "discord" } });
    expect(noCredential.coverageBlockers(input)).toEqual(["host_credential_off"]);
    expect(noCredential.canHear!()).toBe(false);
    expect(createDiscordDoorbellAdapter({ env: ON }).coverageBlockers(input)).toEqual([]);
    expect(CHANNEL_WAKE_ADAPTERS).toContain(DISCORD_DOORBELL_ADAPTER);
  });

  it("is one more channel in the union: an uncovered Discord keeps an email agent awake", () => {
    const email = createDiscordDoorbellAdapter({ env: {} });
    const contexts = {
      telegram: null,
      generic: [{ adapter: email, row: { agent_id: AGENT, channel: "discord", enabled: true, cred_fp: FP, blocked_until: null } as never }],
    };
    expect(channelCoverageFor(contexts, probe, 0).covered).toEqual([]);
  });
});

const hasPerl = spawnSync("which", ["perl"]).status === 0;
(hasPerl ? describe : describe.skip)("the host gate for Discord", () => {
  const quiet = { activeRuns: 0, cliProcesses: 0, openConnections: 0, sshSessions: 0, terminalAttached: false, desktopAttached: false, errors: [] };
  const gate = (discordFacts: unknown) => {
    const script = buildSleepHostScript({ vmid: 123, bindingTag: "hivra-x", tier: "nap", manual: false,
      channelCoverage: { channels: ["hermes:discord"], fingerprints: { discord: FP } } });
    const body = script.split("<<'HIVRA_PROBE_CHECK'\n")[1].split("\nHIVRA_PROBE_CHECK")[0];
    const run = spawnSync("perl", ["-MJSON::PP", "-", "0"], {
      input: body,
      env: { ...process.env, HIVRA_PROBE: JSON.stringify({ ...quiet, liveChannels: ["hermes:discord"], channelFps: { discord: FP },
        channelFacts: { discord: discordFacts } }), HIVRA_COVERED_CHANNELS: "hermes:discord", HIVRA_CHANNEL_FPS: `discord:${FP}` },
      encoding: "utf8",
    });
    return run.stdout.trim();
  };

  it("sleeps only with catch-up on and a DM channel listed, as the server checked", () => {
    expect(gate(facts)).toBe("ok");
    expect(gate({ ...facts, backfill: false })).toBe("active");
    expect(gate({ ...facts, backfillChannels: 0 })).toBe("active");
    expect(gate({ ...facts, backfillChannels: 0, dmsAllowed: false })).toBe("ok");
    expect(gate({ ...facts, backfillChannels: "3" })).toBe("ok");
    expect(gate({ ...facts, backfillChannels: "3; rm" })).toBe("active");
    expect(gate(null)).toBe("active");
  });
});

describe("the credential read program", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "hivra-discord-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function runProgram(envText: string, yaml: string | null): string {
    writeFileSync(path.join(dir, ".env"), envText);
    if (yaml !== null) writeFileSync(path.join(dir, "config.yaml"), yaml);
    const program = DISCORD_CRED_READ_PROGRAM.split("/home/bux/.hermes").join(dir);
    const run = spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8" });
    expect(run.status).toBe(0);
    return run.stdout;
  }

  const token = () => `bot.${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}xx`;

  it("reads the token and reply rules, fingerprinted as the probe does, and the doorbell takes it", () => {
    const value = token();
    const out = runProgram(`DISCORD_BOT_TOKEN=${value}\nDISCORD_FREE_RESPONSE_CHANNELS=700000000000000007\nOTHER=x\n`, null);
    const line = JSON.parse(out.trim().slice("HIVRA_DISCORD_CRED ".length));
    expect(line.fp).toBe(createHash("sha256").update(value).digest("hex").slice(0, 16));
    expect(Object.keys(line.values).sort()).toEqual(["DISCORD_BOT_TOKEN", "DISCORD_FREE_RESPONSE_CHANNELS"]);
    expect(channelFpsPython(["discord"])).toContain(`chan_fp(${JSON.stringify(DISCORD_CHANNEL_SPEC.credKeys)})`);
    const handed = spawnSync("python3", ["-I", "-B", DOORBELL_PY, "arm-from-guest", "1234", ARM, line.fp, "discord"], { input: out, encoding: "utf8" });
    expect(handed.stdout).toBe(`${DOORBELL_ARM_PREFIX}{"error":"doorbell_unreachable","ok":false,"vmid":1234}\n`);
    expect(handed.stdout + handed.stderr).not.toContain(value);
    // The email reading of the same answer finds no email line.
    const asEmail = spawnSync("python3", ["-I", "-B", DOORBELL_PY, "arm-from-guest", "1234", ARM, line.fp], { input: out, encoding: "utf8" });
    expect(asEmail.stdout).toBe(`${DOORBELL_ARM_PREFIX}{"error":"no_answer","ok":false,"vmid":1234}\n`);
  });

  it("marks reply rules set in config.yaml's discord block, and only there", () => {
    const env = `DISCORD_BOT_TOKEN=${token()}\n`;
    const gates = (yaml: string | null) => JSON.parse(runProgram(env, yaml).trim().slice("HIVRA_DISCORD_CRED ".length)).values._yaml_gates;
    expect(gates(null)).toBeUndefined();
    expect(gates("model: x\ndiscord:\n  require_mention: false\n")).toBe("1");
    expect(gates("discord:\n  missed_message_backfill:\n    enabled: true\n\n  free_response_channels:\n    - 1\nother: y\n")).toBe("1");
    expect(gates("discord: {allow_bots: all}\n")).toBe("1");
    expect(gates("telegram:\n  require_mention: false\ndiscord:\n  missed_message_backfill:\n    enabled: true\n")).toBeUndefined();
  });

  it("refuses without a token", () => {
    expect(runProgram("DISCORD_REQUIRE_MENTION=false\n", null)).toBe("HIVRA_DISCORD_CRED_NONE missing\n");
  });

  it("leaves the email program exactly as it was", () => {
    expect(EMAIL_CRED_READ_PROGRAM).toBe(buildChannelCredReadProgram({
      fpKeys: EMAIL_CHANNEL_SPEC.credKeys, keys: EMAIL_DOORBELL_KEYS, prefix: "HIVRA_EMAIL_CRED ", nonePrefix: "HIVRA_EMAIL_CRED_NONE " }));
    expect(EMAIL_CRED_READ_PROGRAM).not.toContain("_yaml_gates");
    expect(createHash("sha256").update(EMAIL_CRED_READ_PROGRAM).digest("hex"))
      .toBe("ad897ace2a5d4f979482ded6f94b11f964236da4afbfb8d6b8eb4c0e39595bb9");
    expect(DISCORD_DOORBELL_KEYS).toContain("DISCORD_BOT_TOKEN");
    expect(() => buildChannelCredReadProgram({ fpKeys: ["A_B"], keys: ["A_B"], prefix: "HIVRA_X ", nonePrefix: "HIVRA_Y ", extraPython: " " })).toThrow();
    expect(() => buildChannelCredReadProgram({ fpKeys: ["A_B"], keys: ["A_B"], prefix: "HIVRA_X ", nonePrefix: "HIVRA_Y ", extraPython: "x = 'HIVRA_Z'" })).toThrow();
  });
});

describe("the arm host script", () => {
  it("checks the doorbell before reading, hands over with the discord channel, and never prints what it read", () => {
    const script = buildDiscordDoorbellArmHostScript({ ...target, armId: ARM, credFp: FP });
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    expect(script.includes("\0")).toBe(false);
    expect(script.indexOf("refuse doorbell_missing")).toBeLessThan(script.indexOf("HIVRA_CRED_OUT="));
    expect(script).toContain(`arm-from-guest 1234 '${ARM}' '${FP}' discord || true`);
    expect(script.match(/HIVRA_CRED_OUT/g)).toHaveLength(3);
    expect(() => buildDiscordDoorbellArmHostScript({ ...target, armId: "x", credFp: FP })).toThrow();
    expect(() => buildDiscordDoorbellArmHostScript({ ...target, vmid: 5, armId: ARM, credFp: FP })).toThrow();
  });

  it("parses the answer strictly", () => {
    const ok = `${DOORBELL_ARM_PREFIX}{"arm_id":"${ARM}","channel":"discord","login_remaining":812,"ok":true,"vmid":1234}\n`;
    expect(parseDiscordDoorbellArmOutput(ok, { vmid: 1234, armId: ARM })).toEqual({ ok: true, loginRemaining: 812 });
    expect(parseDiscordDoorbellArmOutput(ok, { vmid: 1235, armId: ARM })).toEqual({ ok: false, reason: "bad_answer" });
    // An email answer (an older doorbell would never give one, but it must not count).
    expect(parseDiscordDoorbellArmOutput(`${DOORBELL_ARM_PREFIX}{"arm_id":"${ARM}","ok":true,"uidnext":1,"uidvalidity":2,"vmid":1234}`,
      { vmid: 1234, armId: ARM })).toEqual({ ok: false, reason: "bad_answer" });
    expect(parseDiscordDoorbellArmOutput(`${DOORBELL_ARM_PREFIX}{"error":"bad_arguments","ok":false}`, { vmid: 1234, armId: ARM }))
      .toEqual({ ok: false, reason: "bad_arguments" });
    expect(parseDiscordDoorbellArmOutput(`${DOORBELL_ARM_PREFIX}{"error":"login_budget","ok":false,"vmid":1234}`, { vmid: 1234, armId: ARM }))
      .toEqual({ ok: false, reason: "login_budget" });
    expect(parseDiscordDoorbellArmOutput("HIVRA_IDLE_REFUSED doorbell_down\n", { vmid: 1234, armId: ARM })).toEqual({ ok: false, reason: "doorbell_down" });
    expect(parseDiscordDoorbellArmOutput(ok + ok, { vmid: 1234, armId: ARM })).toEqual({ ok: false, reason: "no_answer" });
  });
});

describe("the Discord adapter", () => {
  const ctx = { agentId: AGENT, channel: "discord" as const, armId: ARM, armData: {}, target };

  it("never arms with the switch off, and keeps the agent awake on any failure", async () => {
    const run = jest.fn();
    const off = createDiscordDoorbellAdapter({ env: { HIVRA_WAKE_DOORBELLS: "email" }, run, readCredFp: async () => FP });
    expect(await off.armBeforeSleep!(ctx)).toEqual({ ok: false, reason: "doorbell_off" });
    expect(run).not.toHaveBeenCalled();
    const failing = createDiscordDoorbellAdapter({ env: ON, run: jest.fn(async () => { throw new Error("ssh"); }), readCredFp: async () => FP });
    expect(await failing.armBeforeSleep!(ctx)).toEqual({ ok: false, reason: "run_failed" });
    const noFp = createDiscordDoorbellAdapter({ env: ON, run, readCredFp: async () => null });
    expect(await noFp.armBeforeSleep!(ctx)).toEqual({ ok: false, reason: "no_fingerprint" });
    const noTarget = createDiscordDoorbellAdapter({ env: ON, run, readCredFp: async () => FP });
    expect(await noTarget.armBeforeSleep!({ ...ctx, target: undefined })).toEqual({ ok: false, reason: "no_target" });
  });

  it("arms through the host script and stores only the vmid and the login budget", async () => {
    const run = jest.fn(async () => ({ ok: true, stdout: `${DOORBELL_ARM_PREFIX}{"arm_id":"${ARM}","channel":"discord","login_remaining":700,"ok":true,"vmid":1234}\n`, stderr: "" }));
    const adapter = createDiscordDoorbellAdapter({ env: ON, run: run as never, readCredFp: async () => FP });
    expect(await adapter.armBeforeSleep!(ctx)).toEqual({ ok: true, armData: { vmid: 1234, loginRemaining: 700 } });
    const [script, env, options] = run.mock.calls[0] as unknown as [string, unknown, unknown];
    expect(script).toContain("discord || true");
    expect(env).toBe(target.env);
    expect(options).toEqual({ timeoutMs: 13_000 });
  });

  it("disarms by arm id on the agent's host, even with the switch off", async () => {
    const run = jest.fn(async () => ({ ok: true, stdout: 'HIVRA_DOORBELL_DISARM {"ok":true,"vmid":1234,"was":"fired"}\n', stderr: "" }));
    const adapter = createDiscordDoorbellAdapter({ env: {}, run: run as never, resolveTarget: async () => target });
    const wakeCtx = { agentId: AGENT, channel: "discord" as const, armId: ARM, armData: { vmid: 1234 } };
    expect(await adapter.disarmForWake(wakeCtx)).toEqual({ ok: true });
    expect((run.mock.calls[0] as unknown as [string])[0]).toContain(`"arm_id":"${ARM}"`);
  });
});

describe("the opt-in read", () => {
  const probeLine = (extra: Record<string, unknown>) => `HIVRA_IDLE ${JSON.stringify({
    v: 1, errors: [], activeRuns: 0, cliProcesses: 0, openConnections: 0, gatewayConnections: 0, terminalAttached: false,
    terminalClients: 0, sshSessions: 0, desktopAttached: false, lastUsedAt: null, nextJobAt: null, liveChannels: ["hermes:discord"],
    loadavg: [0, 0, 0], cpus: 2, uptimeS: 99999, now: "2026-11-13T00:00:00Z", ms: 5, ...extra })}\n`;
  const read = (stdout: string) => readDiscordOptIn(target, { run: jest.fn(async () => ({ ok: true, stdout, stderr: "" })) as never });

  it("keeps the fingerprint and refuses while catch-up would miss the message", async () => {
    expect(await read(probeLine({ channelFps: { discord: FP }, channelFacts: { discord: facts } })))
      .toEqual({ ok: true, fp: FP, backfill: true, dmBackfilled: true });
    expect(await read(probeLine({ channelFps: { discord: FP }, channelFacts: { discord: { ...facts, backfill: false } } })))
      .toEqual({ ok: false, reason: "backfill_off" });
    expect(await read(probeLine({ channelFps: { discord: FP }, channelFacts: { discord: { ...facts, backfillChannels: 0 } } })))
      .toEqual({ ok: false, reason: "dm_not_backfilled" });
    expect(await read(probeLine({ channelFps: { discord: null } }))).toEqual({ ok: false, reason: "no_discord" });
    expect(await read("HIVRA_IDLE_REFUSED asleep\n")).toEqual({ ok: false, reason: "asleep" });
  });
});
