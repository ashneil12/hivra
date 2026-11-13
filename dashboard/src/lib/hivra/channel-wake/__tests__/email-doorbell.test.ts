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

import {
  DOORBELL_ARM_PREFIX,
  DOORBELL_BUNDLE_FILES,
  EMAIL_CRED_READ_PROGRAM,
  anyWakeDoorbellEnabled,
  buildDoorbellDisarmHostScript,
  buildDoorbellInstallScript,
  buildDoorbellRemoveScript,
  buildDoorbellStatusScript,
  buildEmailDoorbellArmHostScript,
  parseDoorbellArmOutput,
  parseDoorbellDisarmOutput,
  parseDoorbellResult,
  parseDoorbellStatus,
  parseWakeDoorbells,
  wakeDoorbellEnabled,
} from "../doorbell-scripts";
import { EMAIL_CHANNEL_SPEC, GENERIC_CHANNEL_SPECS, channelFpsPython } from "../registry";
import { createEmailImapAdapter, EMAIL_IMAP_ADAPTER } from "../adapters/email-imap";
import { CHANNEL_WAKE_ADAPTERS } from "../lifecycle";
import { buildChannelCredReadProgram, buildIdleProbeHostScript } from "../../agent-sleep-scripts";
import { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES } from "@/lib/infrastructure/portable-provisioner-contract";

const AGENT = "00000000-0000-4000-8000-0000000a0011";
const ARM = "00000000-0000-4fdd-85f4-f955ee4104e2";
const FP = "0123456789abcdef";
const DOORBELL_PY = path.join(process.cwd(), "provisioner/hivra-wake-doorbell.py");
const target = { vmid: 1234, bindingTag: "hivra-binding-test", env: { host: "x" } };
const ON = { HIVRA_WAKE_DOORBELLS: "email", HIVRA_INGRESS_HOST_CREDENTIAL: "true" };
const digests = { "hivra-wake-doorbell.py": "a".repeat(64), "hivra-wake-doorbell.service": "b".repeat(64) };

function bashSyntaxOk(script: string): boolean {
  return spawnSync("bash", ["-n"], { input: script }).status === 0;
}

describe("the doorbell switch", () => {
  it("is off unless HIVRA_WAKE_DOORBELLS lists a known channel", () => {
    expect([...parseWakeDoorbells(undefined)]).toEqual([]);
    expect([...parseWakeDoorbells(" Email, slack ,nope")]).toEqual(["email"]);
    expect(wakeDoorbellEnabled("email", {})).toBe(false);
    expect(wakeDoorbellEnabled("email", ON)).toBe(true);
    expect(anyWakeDoorbellEnabled({ HIVRA_WAKE_DOORBELLS: "nope" })).toBe(false);
  });
});

describe("email in the registry", () => {
  it("is a generic host-doorbell channel with an IMAP host check", () => {
    expect(GENERIC_CHANNEL_SPECS).toContain(EMAIL_CHANNEL_SPEC);
    expect(EMAIL_CHANNEL_SPEC).toMatchObject({ probeTag: "hermes:email", detector: "host-doorbell", needsServerDisarm: false, socketBased: false });
    const probe = { liveChannels: ["hermes:email"], channelFps: { email: FP }, channelFacts: { email: { imapHost: "imap.example.test" } } };
    const row = { enabled: true, credFp: FP, blockedUntil: null };
    expect(EMAIL_CHANNEL_SPEC.coverageBlockers({ acts: true, row, probe, nowMs: 0 })).toEqual([]);
    expect(EMAIL_CHANNEL_SPEC.coverageBlockers({ acts: true, row, probe: { ...probe, channelFacts: { email: { imapHost: null } } }, nowMs: 0 }))
      .toEqual(["no_imap_host"]);
  });

  it("adds doorbell_off in the adapter while the switch is off", () => {
    const probe = { liveChannels: ["hermes:email"], channelFps: { email: FP }, channelFacts: { email: { imapHost: "imap.example.test" } } };
    const input = { acts: true, row: { enabled: true, credFp: FP, blockedUntil: null }, probe, nowMs: 0 };
    expect(createEmailImapAdapter({ env: {} }).coverageBlockers(input)).toEqual(["doorbell_off"]);
    expect(createEmailImapAdapter({ env: ON }).coverageBlockers(input)).toEqual([]);
    expect(CHANNEL_WAKE_ADAPTERS).toContain(EMAIL_IMAP_ADAPTER);
    // Its rings reach Hivra only through the host credential.
    const noCredential = createEmailImapAdapter({ env: { HIVRA_WAKE_DOORBELLS: "email" } });
    expect(noCredential.coverageBlockers(input)).toEqual(["host_credential_off"]);
    expect(noCredential.canHear!()).toBe(false);
    expect(createEmailImapAdapter({ env: ON }).canHear!()).toBe(true);
    expect(createEmailImapAdapter({ env: {} }).canHear!()).toBe(false);
  });

  it("leaves the Telegram-only and plain probe scripts as they were", () => {
    // The probe asks for email's fingerprint only when a sleep covers email.
    expect(buildIdleProbeHostScript({ vmid: 123, bindingTag: "hivra-x" })).not.toContain("channelFps");
  });
});

describe("the credential read program", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "hivra-doorbell-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function runProgram(envText: string): string {
    const envPath = path.join(dir, ".env");
    writeFileSync(envPath, envText);
    const program = EMAIL_CRED_READ_PROGRAM.replace("/home/bux/.hermes/.env", envPath);
    const run = spawnSync("python3", ["-I", "-B", "-c", program], { encoding: "utf8" });
    expect(run.status).toBe(0);
    return run.stdout;
  }

  it("fingerprints exactly as the probe does, and the doorbell reads its line", () => {
    const password = `pw-${Math.random().toString(36).slice(2)}`;
    const out = runProgram(`EMAIL_ADDRESS=agent@example.test\nEMAIL_PASSWORD="${password}"\nEMAIL_IMAP_HOST=imap.example.test\nEMAIL_ALLOWED_USERS=owner@example.test\nOTHER=x\n`);
    const expectedFp = createHash("sha256").update(["agent@example.test", password, "imap.example.test"].join("\n")).digest("hex").slice(0, 16);
    const line = JSON.parse(out.trim().slice("HIVRA_EMAIL_CRED ".length));
    expect(line.fp).toBe(expectedFp);
    expect(Object.keys(line.values).sort()).toEqual(["EMAIL_ADDRESS", "EMAIL_ALLOWED_USERS", "EMAIL_IMAP_HOST", "EMAIL_PASSWORD"]);
    // The probe's own fingerprint program uses the same keys in the same order.
    expect(channelFpsPython(["email"])).toContain(`chan_fp(${JSON.stringify(EMAIL_CHANNEL_SPEC.credKeys)})`);
    // Handed to the doorbell (not running here): it answers without ever printing the password.
    const handed = spawnSync("python3", ["-I", "-B", DOORBELL_PY, "arm-from-guest", "1234", ARM, expectedFp], { input: out, encoding: "utf8" });
    expect(handed.stdout).toBe(`${DOORBELL_ARM_PREFIX}{"error":"doorbell_unreachable","ok":false,"vmid":1234}\n`);
    expect(handed.stdout + handed.stderr).not.toContain(password);
    const changed = spawnSync("python3", ["-I", "-B", DOORBELL_PY, "arm-from-guest", "1234", ARM, "fedcba9876543210"], { input: out, encoding: "utf8" });
    expect(changed.stdout).toBe(`${DOORBELL_ARM_PREFIX}{"error":"credential_changed","ok":false,"vmid":1234}\n`);
  });

  it("refuses without every fingerprint key", () => {
    expect(runProgram("EMAIL_ADDRESS=agent@example.test\n")).toBe("HIVRA_EMAIL_CRED_NONE missing\n");
  });

  it("refuses bad specs", () => {
    expect(() => buildChannelCredReadProgram({ fpKeys: ["lower"], keys: ["lower"], prefix: "HIVRA_X ", nonePrefix: "HIVRA_Y " })).toThrow();
    expect(() => buildChannelCredReadProgram({ fpKeys: ["A_B"], keys: [], prefix: "HIVRA_X ", nonePrefix: "HIVRA_Y " })).toThrow();
    expect(() => buildChannelCredReadProgram({ fpKeys: ["A_B"], keys: ["A_B"], prefix: "X ", nonePrefix: "HIVRA_Y " })).toThrow();
  });
});

describe("arm and disarm host scripts", () => {
  it("checks the binding and the doorbell before reading, and never prints what it read", () => {
    const script = buildEmailDoorbellArmHostScript({ ...target, armId: ARM, credFp: FP });
    expect(bashSyntaxOk(script)).toBe(true);
    expect(script.includes("\0")).toBe(false);
    expect(script.indexOf("refuse doorbell_missing")).toBeLessThan(script.indexOf("HIVRA_CRED_OUT="));
    expect(script.indexOf("binding_mismatch")).toBeLessThan(script.indexOf("HIVRA_CRED_OUT="));
    expect(script).toContain(`printf '%s\\n' "$HIVRA_CRED_OUT" | /usr/bin/python3 -I -B '/usr/local/lib/hivra-doorbell/hivra-wake-doorbell.py' arm-from-guest 1234 '${ARM}' '${FP}' || true`);
    // The only uses of the variable: set, piped, cleared.
    expect(script.match(/HIVRA_CRED_OUT/g)).toHaveLength(3);
    expect(() => buildEmailDoorbellArmHostScript({ ...target, armId: "x", credFp: FP })).toThrow();
    expect(() => buildEmailDoorbellArmHostScript({ ...target, armId: ARM, credFp: "nothex" })).toThrow();
  });

  it("parses the arm answer strictly", () => {
    const ok = `${DOORBELL_ARM_PREFIX}{"arm_id":"${ARM}","idle":true,"ok":true,"uidnext":40,"uidvalidity":7001,"vmid":1234}\n`;
    expect(parseDoorbellArmOutput(ok, { vmid: 1234, armId: ARM })).toEqual({ ok: true, uidvalidity: 7001, uidnext: 40, idle: true });
    expect(parseDoorbellArmOutput(ok, { vmid: 1235, armId: ARM })).toEqual({ ok: false, reason: "bad_answer" });
    expect(parseDoorbellArmOutput(ok + ok, { vmid: 1234, armId: ARM })).toEqual({ ok: false, reason: "no_answer" });
    expect(parseDoorbellArmOutput(`${DOORBELL_ARM_PREFIX}{"ok":false,"error":"login_failed"}`, { vmid: 1234, armId: ARM }))
      .toEqual({ ok: false, reason: "login_failed" });
    expect(parseDoorbellArmOutput("HIVRA_IDLE_REFUSED doorbell_missing\n", { vmid: 1234, armId: ARM }))
      .toEqual({ ok: false, reason: "doorbell_missing" });
  });

  it("disarms only the named arm, and a host without the doorbell has nothing armed", () => {
    const script = buildDoorbellDisarmHostScript({ vmid: 1234, armId: ARM });
    expect(bashSyntaxOk(script)).toBe(true);
    expect(script).toContain(`'{"cmd":"disarm","vmid":1234,"arm_id":"${ARM}"}'`);
    const run = spawnSync("bash", ["-s"], { input: script, encoding: "utf8" });
    expect(parseDoorbellDisarmOutput(run.stdout)).toEqual({ ok: true, was: "absent" });
    expect(parseDoorbellDisarmOutput('HIVRA_DOORBELL_DISARM {"ok":false,"error":"unreachable"}')).toEqual({ ok: false, was: null });
    expect(() => buildDoorbellDisarmHostScript({ vmid: 12, armId: null })).toThrow();
  });
});

describe("install, status and remove", () => {
  it("installs only the reviewed files, rolls back, and needs the helper", () => {
    const script = buildDoorbellInstallScript({ targetId: "host_a", channel: "default", bundleVersion: "2026.11.13.4", fileDigests: digests });
    expect(bashSyntaxOk(script)).toBe(true);
    expect(script.includes("\0")).toBe(false);
    expect(script).toContain("systemctl is-active --quiet hivra-wake-helper.service ||");
    expect(script).toContain("emit rolled_back");
    expect(script).toContain(`grep -qxF '${"a".repeat(64)}  hivra-wake-doorbell.py'`);
    expect(() => buildDoorbellInstallScript({ targetId: "host_a", channel: "default", bundleVersion: "2026.11.13.4",
      fileDigests: { ...digests, "hivra-wake-doorbell.py": "" } })).toThrow();
    expect(() => buildDoorbellInstallScript({ targetId: "Bad Host", channel: "default", bundleVersion: "2026.11.13.4", fileDigests: digests })).toThrow();
    expect(DOORBELL_BUNDLE_FILES.every((file) => (PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES as readonly string[]).includes(file))).toBe(true);
  });

  it("status and remove are valid bash and parse", () => {
    expect(bashSyntaxOk(buildDoorbellStatusScript("host_a"))).toBe(true);
    const remove = buildDoorbellRemoveScript("host_a");
    expect(bashSyntaxOk(remove)).toBe(true);
    expect(remove).toContain("emit refused");
    expect(parseDoorbellStatus("HIVRA_DOORBELL_STATUS installed=1 active=active ok=1 armed=2 fired=0 helper=1 credential=1\n"))
      .toEqual({ installed: true, active: "active", ok: true, armed: 2, fired: 0, helper: true, credential: true });
    expect(parseDoorbellResult("x\nHIVRA_DOORBELL_RESULT status=installed step=health changed=1 ms=812\n"))
      .toEqual({ status: "installed", step: "health", changed: true, ms: 812 });
    expect(parseDoorbellResult("HIVRA_DOORBELL_RESULT status=bogus step=x changed=1 ms=1")).toBeNull();
  });
});

describe("the email adapter", () => {
  const ctx = { agentId: AGENT, channel: "email" as const, armId: ARM, armData: {}, target };

  it("never arms with the switch off, and keeps the agent awake on any failure", async () => {
    const run = jest.fn();
    const off = createEmailImapAdapter({ env: {}, run, readCredFp: async () => FP });
    expect(await off.armBeforeSleep!(ctx)).toEqual({ ok: false, reason: "doorbell_off" });
    expect(run).not.toHaveBeenCalled();
    const failing = createEmailImapAdapter({ env: ON, run: jest.fn(async () => { throw new Error("ssh"); }), readCredFp: async () => FP });
    expect(await failing.armBeforeSleep!(ctx)).toEqual({ ok: false, reason: "run_failed" });
    const noFp = createEmailImapAdapter({ env: ON, run, readCredFp: async () => null });
    expect(await noFp.armBeforeSleep!(ctx)).toEqual({ ok: false, reason: "no_fingerprint" });
  });

  it("arms through the host script and stores only the baseline", async () => {
    const run = jest.fn(async () => ({ ok: true, stdout: `${DOORBELL_ARM_PREFIX}{"arm_id":"${ARM}","idle":false,"ok":true,"uidnext":41,"uidvalidity":9,"vmid":1234}\n`, stderr: "" }));
    const adapter = createEmailImapAdapter({ env: ON, run: run as never, readCredFp: async () => FP });
    expect(await adapter.armBeforeSleep!(ctx)).toEqual({ ok: true, armData: { vmid: 1234, uidvalidity: 9, uidnext: 41, idle: false } });
    const [script, env, options] = run.mock.calls[0] as unknown as [string, unknown, unknown];
    expect(script).toContain("arm-from-guest 1234");
    expect(env).toBe(target.env);
    expect(options).toEqual({ timeoutMs: 13_000 });
  });

  it("disarms on the agent's host, by arm id, and skips a computer that moved", async () => {
    const run = jest.fn(async () => ({ ok: true, stdout: 'HIVRA_DOORBELL_DISARM {"ok":true,"vmid":1234,"was":"fired"}\n', stderr: "" }));
    const resolveTarget = jest.fn(async () => target);
    const adapter = createEmailImapAdapter({ env: ON, run: run as never, resolveTarget });
    const wakeCtx = { agentId: AGENT, channel: "email" as const, armId: ARM, armData: { vmid: 1234 } };
    expect(await adapter.disarmForWake(wakeCtx)).toEqual({ ok: true });
    expect((run.mock.calls[0] as unknown as [string])[0]).toContain(`"arm_id":"${ARM}"`);
    expect(await adapter.disarmForWake({ ...wakeCtx, armData: { vmid: 999 } })).toEqual({ ok: true, reason: "moved" });
    const nowhere = createEmailImapAdapter({ env: ON, run: run as never, resolveTarget: async () => null });
    expect(await nowhere.disarmForWake(wakeCtx)).toEqual({ ok: false, reason: "no_target" });
    // Turning the switch off must still let arms come down.
    const off = createEmailImapAdapter({ env: {}, run: run as never, resolveTarget });
    expect(await off.disarmForWake(wakeCtx)).toEqual({ ok: true });
  });
});
