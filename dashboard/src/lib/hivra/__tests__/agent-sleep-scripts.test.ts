/** @jest-environment node */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildIdleProbeHostScript, buildMemoryDropHostScript, buildSleepHostScript, buildWakeHostScript, idleVerdict, parseIdleProbeOutput,
  parseMemoryDropReceipt,
  parseIdleProbeRefusal, parseSleepReceipt, parseWakeReceipt, TRIM_GUEST_COMMAND, type WakeAdmission,
} from "../agent-sleep-scripts";
import { HOST_VM_CONTROL_PROGRAM, HOST_VM_CONTROL_SOCKETS_PROGRAM } from "../sleep/host-vm-control-program";
import { IDLE_PROBE_PROGRAM } from "../sleep/idle-probe-program";
import { shellQuote } from "../proxmox-target";
import { CANARY_MEMORY_OVERCOMMIT_PROVISIONER } from "@/lib/infrastructure/host-capacity-policy";
import {
  AWAKE, COLD, HIBERNATED, NAPPING, TAG, VMID, makeHostHarness, probeLine, type HostHarness, type HostState,
} from "./sleep-stub-host.fixtures";

const ADMISSION = (dir: string): WakeAdmission => ({
  provisionerDirectory: dir, hostReserveMb: 2048, enforceCeilings: true, cpuDensityMilli: 1500, memoryDensityMilli: 1200,
});

const hasTools = ["bash", "python3", "perl"].every((cmd) => spawnSync("which", [cmd]).status === 0);
/** The host's mark that a hibernate turned autostart off, inside a harness. */
const onbootMark = (h: HostHarness) => path.join(h.dir, "var-lib-hivra-sleep", `onboot-${VMID}`);
const host = hasTools ? describe : describe.skip;
function explain<T>(run: { stdout: string; stderr?: string }, parsed: T | null): T | null {
  // Every receipt these tests read must parse, so a null fails here with the output in the message.
  if (parsed === null) throw new Error(`unparsed receipt\n--- stdout\n${run.stdout}\n--- stderr\n${(run.stderr ?? "").slice(-4000)}`);
  return parsed;
}

describe("script construction", () => {
  // Pin the scripts sent with every switch off. The wake golden includes the
  // Hibernate timing breakdown; the sleep goldens are unchanged.
  //
  // The sleep scripts carry the idle probe program, which changed on purpose
  // (unflagged) when it learned Hermes's gateway_state.json and more channels:
  // that change can only keep more agents awake. So the sleep digests are taken
  // with the probe program cut out; they are the same values the earlier code
  // gives with its probe cut out. The probe has its own tests.
  it("pins the default scripts, including the wake timing boundaries", () => {
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const withoutProbe = (text: string) => {
      expect(text).toContain(shellQuote(IDLE_PROBE_PROGRAM));
      return text.split(shellQuote(IDLE_PROBE_PROGRAM)).join("'<probe>'");
    };
    const target = { vmid: 123, bindingTag: "hivra-x" };
    const admission = { provisionerDirectory: "/opt/hivra", hostReserveMb: 2048, enforceCeilings: true, cpuDensityMilli: 1500, memoryDensityMilli: 1200 };
    expect(digest(withoutProbe(buildSleepHostScript({ ...target, tier: "nap", manual: false }))))
      .toBe("30792d3358eeeb69c93e71559494694ca8e8eb4b3e3a6c07fa71fd529f838ff0");
    expect(digest(withoutProbe(buildSleepHostScript({ ...target, tier: "hibernate", manual: false }))))
      .toBe("6afca6eae86892fd2115fe862baa9f475e1dc777f6cc2d699bc5aa4b3b87314e");
    expect(digest(buildWakeHostScript({ ...target, admission })))
      .toBe("92e1752d8ec949c9f36f161452f994471c3f90d117f5d8ce16564f8eb484742b");
  });

  it("trims memory only when asked, and only for a computer that is running", () => {
    const target = { vmid: VMID, bindingTag: TAG, manual: false };
    for (const tier of ["nap", "hibernate"] as const) {
      expect(buildSleepHostScript({ ...target, tier })).not.toContain("drop_caches");
      const trimmed = buildSleepHostScript({ ...target, tier, trimMemory: true });
      expect(trimmed).toContain(shellQuote(TRIM_GUEST_COMMAND));
      expect(spawnSync("bash", ["-n"], { input: trimmed }).status).toBe(0);
    }
    // A paused computer cannot answer its guest agent: the hibernate trims only inside the awake branch.
    const hibernate = buildSleepHostScript({ ...target, tier: "hibernate", trimMemory: true });
    expect(hibernate).toMatch(/if \[ "\$FROM" = awake \]; then\n[^]*?probe_or_finish\n[^]*?  trim_memory\nfi/);
  });

  it("carries the sockets helper only in a wake that asks for it", () => {
    const plain = buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra") });
    const sockets = buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra"), killStaleSockets: true });
    expect(plain).toContain(shellQuote(HOST_VM_CONTROL_PROGRAM));
    expect(plain).not.toContain("ss -K");
    expect(sockets).toContain(shellQuote(HOST_VM_CONTROL_SOCKETS_PROGRAM));
    expect(sockets).toContain('ctl $((AGENT_WAIT + 45)) fixup "$VMID" "$AGENT_WAIT"\n');
  });

  it("refuses a missing or odd binding tag and a bad VMID", () => {
    expect(() => buildSleepHostScript({ vmid: VMID, bindingTag: null, tier: "nap", manual: false })).toThrow();
    expect(() => buildSleepHostScript({ vmid: VMID, bindingTag: "", tier: "nap", manual: false })).toThrow();
    expect(() => buildSleepHostScript({ vmid: VMID, bindingTag: "a b; reboot", tier: "nap", manual: false })).toThrow();
    expect(() => buildSleepHostScript({ vmid: 5, bindingTag: TAG, tier: "nap", manual: false })).toThrow();
    expect(() => buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "deep" as never, manual: false })).toThrow();
    expect(() => buildIdleProbeHostScript({ vmid: VMID, bindingTag: null })).toThrow();
    expect(() => buildWakeHostScript({ vmid: VMID, bindingTag: null, admission: ADMISSION("/opt/p") })).toThrow();
    expect(() => buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: { ...ADMISSION("/opt/p"), hostReserveMb: 10 } })).toThrow();
    expect(() => buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/p; reboot") })).toThrow();
  });

  it("never puts a NUL byte in a script, which the sudo transport refuses", () => {
    for (const script of [
      buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false }),
      buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "hibernate", manual: false }),
      buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra") }),
      buildIdleProbeHostScript({ vmid: VMID, bindingTag: TAG }),
    ]) {
      expect(script.includes("\0")).toBe(false);
    }
  });

  it("times steps on the monotonic clock, so a wall clock step never gives a negative time", () => {
    for (const script of [
      buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false }),
      buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra") }),
    ]) {
      expect(script).toContain("</proc/uptime");
      expect(script).not.toContain("%3N");
      expect(script).toContain('"$(since_ms "$T0")"');
    }
  });

  it("quotes values and wraps qm in timeout in every script", () => {
    for (const script of [
      buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false }),
      buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "hibernate", manual: true }),
      buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra") }),
      buildIdleProbeHostScript({ vmid: VMID, bindingTag: TAG }),
    ]) {
      expect(script).toContain("set -euo pipefail");
      expect(script).toContain(`VMID=${VMID}`);
      expect(script).toContain(`EXPECTED_BINDING_TAG='${TAG}'`);
      expect(script).toMatch(/qm\(\) \{ command timeout -k \d+ \d+ qm "\$@" <\/dev\/null; \}/);
    }
  });

  it("the sleep scripts take the per-VM lock and hibernate through systemd-run", () => {
    const nap = buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false });
    const hib = buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "hibernate", manual: false });
    for (const script of [nap, hib]) {
      expect(script).toContain(`exec 9>/run/lock/hivra-vm-${VMID}.lock`);
      expect(script).toContain("flock -x -n 9");
      expect(script).toContain("run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c");
      expect(script).toContain("HIVRA_SLEEP_RESULT");
    }
    // A nap is QMP stop through the helper, never the qm CLI.
    expect(nap).toContain('ctl 10 qmp "$VMID" stop 5');
    expect(nap).not.toContain("qm suspend");
    expect(nap).not.toContain("--todisk");
    expect(hib).toContain("qm suspend");
    expect(hib).toContain(`timeout -k 10 240 systemd-run --unit="hivra-sleep-$VMID" --collect --wait --quiet qm suspend "$VMID" --todisk 1`);
    expect(hib).toContain('qm set "$VMID" --onboot 0');
    expect(hib).toContain("lvs");
  });

  it("the wake script holds FD 8 across qm start and releases it only once running", () => {
    const script = buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra") });
    expect(script).toContain("exec 8>/run/lock/hivra-allocation.lock");
    expect(script).toContain("PROVISIONER_DIR='/opt/hivra'");
    expect(script).toContain("CPU_DENSITY_MILLI=1500");
    expect(script.indexOf("qm start")).toBeLessThan(script.indexOf("flock -u 8"));
    expect(script).toContain("HIVRA_WAKE_RESULT");
  });

  it("the wake script resumes through QMP cont and runs the fixups through the helper, not the CLI", () => {
    const script = buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra") });
    expect(script).toContain('ctl 10 qmp "$VMID" cont 5');
    expect(script).toContain('fixup "$VMID" "$AGENT_WAIT"');
    // The helper runs isolated, with no .pyc and no user site, as the spec says.
    expect(script).toContain('python3 -I -B -c "$HOST_CTL_PROGRAM"');
    // The one guest command lives in the helper, with the epoch filled in at send time.
    expect(HOST_VM_CONTROL_PROGRAM).toContain("date -s @%s >/dev/null; systemctl kill -s SIGKILL hivra-cf-tunnel; systemctl restart hivra-cf-tunnel");
    expect(script).not.toContain("hwclock");
    expect(script).not.toContain("run_vmid_bound_guest_exec");
  });

  it("checks the binding once and reuses that config read for the first state read", () => {
    for (const script of [
      buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false }),
      buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION("/opt/hivra") }),
    ]) {
      expect(script.match(/^require_binding$/gm)?.length).toBe(1);
      expect(script).toContain("CONFIG_FRESH=1");
    }
  });
});

host("sleep script against a stub host", () => {
  let h: HostHarness;
  beforeAll(() => { h = makeHostHarness(); });
  afterAll(() => h.cleanup());

  const nap = (manual = false) => buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual });
  const hib = (manual = false) => buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "hibernate", manual });
  const withProbe = (state: HostState, overrides: Record<string, unknown> = {}): HostState =>
    ({ ...state, probeStdout: probeLine(overrides) });
  const receipt = (run: { stdout: string; stderr?: string }) => explain(run, parseSleepReceipt(run.stdout, VMID));
  const noMutation = (calls: string[]) =>
    expect(calls.filter((c) => /^(qm (suspend|resume|start|set)|qmp (stop|cont)|qga )/.test(c))).toEqual([]);

  describe("nap", () => {
    it.each([null, "2026-11-12T14:00:00Z"])("refuses a nap when the schedule changed after reserving the wake (%s)", (expectedNextJobAt) => {
      const script = buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false, expectedNextJobAt });
      const run = h.run(script, withProbe(AWAKE, { nextJobAt: "2026-11-12T13:00:00Z" }));
      expect(receipt(run)).toMatchObject({ ok: false, reason: "schedule_changed", to: "awake" });
      expect(run.calls).not.toContain("qmp stop");
    });

    it("naps when the guest still has the scheduled job covered by the lease", () => {
      const nextJobAt = "2026-11-12T13:00:00Z";
      const script = buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false, expectedNextJobAt: nextJobAt });
      const run = h.run(script, withProbe(AWAKE, { nextJobAt }));
      expect(receipt(run)).toMatchObject({ ok: true, to: "napping" });
    });

    it("pauses an idle running computer and reports the probe", () => {
      const run = h.run(nap(), withProbe(AWAKE));
      expect(run.status).toBe(0);
      const r = receipt(run);
      expect(r).toMatchObject({ ok: true, tier: "nap", from: "awake", to: "napping", reason: "napped", vmid: VMID });
      expect(r?.probe?.activeRuns).toBe(0);
      expect(Object.keys(r?.steps ?? {})).toEqual(expect.arrayContaining(["read_state", "probe", "suspend"]));
      expect(run.state.qmp).toBe("paused");
      // QMP stop on the monitor socket, not the qm CLI.
      expect(run.calls).toContain("qmp stop");
      expect(run.calls.some((c) => c.startsWith("qm suspend") || c.startsWith("qm resume"))).toBe(false);
      // One config read serves the binding check and the state read; the state itself comes from QMP.
      expect(run.calls.filter((c) => c.startsWith("qm config")).length).toBe(1);
      expect(run.calls.some((c) => c.startsWith("qm status"))).toBe(false);
      expect(run.calls).toContain("flock -x -n 9");
      expect(run.stdout.split("\n").filter((l) => l.startsWith("HIVRA_SLEEP_RESULT ")).length).toBe(1);
    });

    it("with trimMemory, drops the guest's file cache after the probe and before the pause", () => {
      const run = h.run(buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false, trimMemory: true }), withProbe(AWAKE));
      const r = receipt(run);
      expect(r).toMatchObject({ ok: true, to: "napping", reason: "napped" });
      expect(Object.keys(r?.steps ?? {})).toContain("trim");
      const trim = run.calls.findIndex((c) => c.startsWith("guest ") && c.includes("drop_caches"));
      expect(trim).toBeGreaterThan(-1);
      expect(trim).toBeLessThan(run.calls.indexOf("qmp stop"));
    }, 30_000);

    it("a trim the guest refuses never stops the nap", () => {
      const run = h.run(
        buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false, trimMemory: true }),
        { ...withProbe(AWAKE), execFailMatch: "drop_caches" },
      );
      const r = receipt(run);
      expect(r).toMatchObject({ ok: true, to: "napping", reason: "napped" });
      expect(Object.keys(r?.steps ?? {})).toContain("trim_failed");
      expect(run.state.qmp).toBe("paused");
    });

    it("aborts as busy when the per-VM lock is held, touching nothing", () => {
      const run = h.run(nap(), withProbe(AWAKE), { STUB_FLOCK_BUSY: "1" });
      // The other script decides what happens next, so the receipt says what the host shows now.
      expect(receipt(run)).toMatchObject({ ok: false, reason: "busy", to: "awake" });
      noMutation(run.calls);
      expect(run.calls.some((c) => c.startsWith("guest "))).toBe(false);
    });

    it("refuses when the exact binding tag is missing", () => {
      const run = h.run(nap(), withProbe({ ...AWAKE, tags: `${TAG.slice(0, -1)}b;other` }));
      expect(receipt(run)).toMatchObject({ ok: false, reason: "binding_mismatch" });
      noMutation(run.calls);
      expect(run.calls.some((c) => c.startsWith("guest "))).toBe(false);
    });

    it.each([
      ["a run in progress", { activeRuns: 1 }],
      ["a coding CLI", { cliProcesses: 2 }],
      ["a chat channel", { liveChannels: ["telegram:bux-tg"] }],
      ["an open connection", { openConnections: 1 }],
      ["an ssh session", { sshSessions: 1 }],
      ["an attached terminal", { terminalAttached: true }],
      ["an attached desktop", { desktopAttached: true }],
    ])("leaves the computer awake with %s", (_name, overrides) => {
      const run = h.run(nap(), withProbe(AWAKE, overrides));
      const r = receipt(run);
      expect(r).toMatchObject({ ok: false, reason: "active", from: "awake", to: "awake" });
      expect(r?.probe).not.toBeNull();
      noMutation(run.calls);
    });

    it("leaves the computer awake when the probe reports an error other than a timer count", () => {
      for (const errors of [["conn"], ["read"], ["timers", "json"]]) {
        const run = h.run(nap(), withProbe(AWAKE, { errors }));
        expect(receipt(run)).toMatchObject({ ok: false, reason: "probe_invalid", to: "awake" });
        noMutation(run.calls);
      }
      expect(receipt(h.run(nap(), withProbe(AWAKE, { errors: ["timers"] })))).toMatchObject({ ok: true });
    });

    it("a manual sleep ignores the page's own connections but never a run or a channel", () => {
      expect(receipt(h.run(nap(true), withProbe(AWAKE, { openConnections: 3, terminalAttached: true, sshSessions: 1 }))))
        .toMatchObject({ ok: true, to: "napping" });
      expect(receipt(h.run(nap(true), withProbe(AWAKE, { activeRuns: 1 })))).toMatchObject({ ok: false, reason: "active" });
      expect(receipt(h.run(nap(true), withProbe(AWAKE, { liveChannels: ["hermes:discord"] })))).toMatchObject({ ok: false, reason: "active" });
    });

    it("does not sleep on a probe it cannot read", () => {
      const none = h.run(nap(), { ...AWAKE }); // the guest prints nothing and fails
      expect(receipt(none)).toMatchObject({ ok: false, reason: "probe_failed", to: "awake" });
      noMutation(none.calls);
      const twice = h.run(nap(), { ...AWAKE, probeStdout: probeLine() + probeLine() });
      expect(receipt(twice)).toMatchObject({ ok: false, reason: "probe_failed" });
      const wrong = h.run(nap(), { ...AWAKE, probeStdout: probeLine({ activeRuns: "0" }) });
      expect(receipt(wrong)).toMatchObject({ ok: false, reason: "probe_invalid", to: "awake", probe: null });
      noMutation(wrong.calls);
      // Numbers that arrive as strings, or flags as numbers, are not counts and flags.
      for (const bad of [{ openConnections: "0" }, { sshSessions: "0" }, { terminalAttached: 0 }, { desktopAttached: "false" }, { cliProcesses: 0.5 }]) {
        const run = h.run(nap(), { ...AWAKE, probeStdout: probeLine(bad) });
        expect(receipt(run)).toMatchObject({ ok: false, reason: "probe_invalid", to: "awake" });
        noMutation(run.calls);
      }
    });

    it("refuses any state but running/running/none and never resumes", () => {
      for (const state of [
        { ...AWAKE, qmp: "io-error" },
        { ...AWAKE, qmp: "prelaunch" },
        { ...AWAKE, lock: "backup" },
        { ...NAPPING },
        { ...HIBERNATED },
        { ...COLD },
      ]) {
        const run = h.run(nap(), withProbe(state));
        const r = receipt(run);
        expect(r).toMatchObject({ ok: false, reason: "not_sleepable" });
        noMutation(run.calls);
      }
      expect(receipt(h.run(nap(), withProbe({ ...AWAKE, qmp: "io-error" })))).toMatchObject({ to: "unknown" });
      expect(receipt(h.run(nap(), withProbe(NAPPING)))).toMatchObject({ from: "napping", to: "napping" });
    });

    it("reports a suspend that did not take as unconfirmed, and never resumes", () => {
      const run = h.run(nap(), withProbe({ ...AWAKE, qmpStopNoop: true }));
      expect(receipt(run)).toMatchObject({ ok: false, reason: "suspend_unconfirmed", to: "awake" });
      expect(run.calls.some((c) => c.startsWith("qm resume") || c === "qmp cont")).toBe(false);
      const failed = h.run(nap(), withProbe({ ...AWAKE, qmpStopFail: true }));
      expect(receipt(failed)).toMatchObject({ ok: false, reason: "suspend_failed", to: "awake" });
      expect(failed.calls.some((c) => c.startsWith("qm suspend"))).toBe(false);
    });

    it("reports a computer it cannot reach over QMP as failed, never as napping", () => {
      const run = h.run(nap(), withProbe({ ...AWAKE, qmpDown: true }));
      // QMP does not answer, so the state read falls back to the CLI and the stop cannot be made.
      expect(receipt(run)).toMatchObject({ ok: false, reason: "suspend_failed", to: "awake" });
      expect(run.calls.some((c) => c.startsWith("qm status"))).toBe(true);
      expect(run.calls.some((c) => c.startsWith("qm suspend") || c === "qmp stop")).toBe(false);
    });

    it("still prints a receipt, and keeps the failing exit, when the script itself breaks", () => {
      const run = h.run(nap(), withProbe(AWAKE));
      // Make /run/lock unusable: a file where the directory belongs.
      const broken = nap().replace("install -d -m 0755 /run/lock", "install -d -m 0755 /run/lock/x/y");
      const bad = h.run(`: > /run/lock\n${broken}`, withProbe(AWAKE));
      expect(bad.status).not.toBe(0);
      expect(receipt(bad)).toMatchObject({ ok: false, reason: "script_error", to: "unknown" });
      expect(run.status).toBe(0);
    });
  });

  describe("hibernate", () => {
    it("saves an idle running computer to disk through systemd-run and checks the result", () => {
      const run = h.run(hib(), withProbe(AWAKE));
      const r = receipt(run);
      expect(r).toMatchObject({ ok: true, tier: "hibernate", from: "awake", to: "hibernated", reason: "hibernated" });
      expect(r?.probe).not.toBeNull();
      expect(run.state).toMatchObject({ status: "stopped", lock: "suspended", vmstate: true, onboot: 0 });
      // The autostart it turned off is marked on the host, for the wake to give back.
      expect(existsSync(onbootMark(h))).toBe(true);
      const order = (prefix: string) => run.calls.findIndex((c) => c.startsWith(prefix));
      expect(order("lvs")).toBeGreaterThan(-1);
      expect(order("lvs")).toBeLessThan(order(`qm set ${VMID} --onboot 0`));
      expect(order(`qm set ${VMID} --onboot 0`)).toBeLessThan(order("systemd-run"));
      expect(run.calls).toContain("timeout 240");
      expect(run.calls).toContain(`systemd-run --unit=hivra-sleep-${VMID} --collect --wait --quiet qm suspend ${VMID} --todisk 1`);
      expect(Object.keys(r?.steps ?? {})).toEqual(expect.arrayContaining(["pool", "hibernate"]));
    });

    it("leaves an autostart that was off alone, with no mark", () => {
      rmSync(onbootMark(h), { force: true });
      const run = h.run(hib(), withProbe({ ...AWAKE, onboot: 0 }));
      expect(receipt(run)).toMatchObject({ ok: true, to: "hibernated" });
      expect(run.calls.some((c) => c.startsWith(`qm set ${VMID} --onboot`))).toBe(false);
      expect(existsSync(onbootMark(h))).toBe(false);
    });

    it("skips the probe for a paused computer", () => {
      const run = h.run(hib(), NAPPING);
      expect(receipt(run)).toMatchObject({ ok: true, from: "napping", to: "hibernated", probe: null });
      expect(run.calls.some((c) => c.startsWith("guest "))).toBe(false);
    });

    it("leaves an active computer alone", () => {
      const run = h.run(hib(), withProbe(AWAKE, { activeRuns: 2 }));
      expect(receipt(run)).toMatchObject({ ok: false, reason: "active", to: "awake" });
      noMutation(run.calls);
    });

    it.each([
      ["a pool above 85 percent", { lvsPercent: "85.10" }, "pool_full"],
      ["too little room for the memory", { lvsSizeMb: "10000.00", lvsPercent: "50.00" }, "pool_headroom"],
      ["a disk with no thin pool", { lvsMissing: true }, "pool_unknown"],
      ["an unreadable pool answer", { lvsRaw: "garbage\n" }, "pool_unknown"],
    ])("refuses with %s", (_name, extra, reason) => {
      const run = h.run(hib(), withProbe({ ...AWAKE, ...extra }));
      expect(receipt(run)).toMatchObject({ ok: false, reason, to: "awake" });
      noMutation(run.calls);
    });

    it("accepts a pool just under the line with exactly 1.25 times the memory free", () => {
      // 4096 MB of memory needs 5120 MB free; 10240 MB at 50 percent leaves exactly that.
      const run = h.run(hib(), withProbe({ ...AWAKE, lvsSizeMb: "10240.00", lvsPercent: "50.00" }));
      expect(receipt(run)).toMatchObject({ ok: true, to: "hibernated" });
    });

    it("refuses a separate state storage it cannot check", () => {
      const state = withProbe(AWAKE);
      const script = hib().replace("VM_CONFIG=\"$CONFIG\"", "VM_CONFIG=\"$CONFIG\"\nVM_CONFIG=\"$VM_CONFIG\nvmstatestorage: other\"");
      expect(receipt(h.run(script, state))).toMatchObject({ ok: false, reason: "pool_unknown" });
    });

    it("gives autostart back when the save fails and the computer is still up", () => {
      const run = h.run(hib(), withProbe({ ...AWAKE, hibernateFail: true }));
      expect(receipt(run)).toMatchObject({ ok: false, reason: "hibernate_failed", to: "awake" });
      expect(run.state.onboot).toBe(1);
      const paused = h.run(hib(), { ...NAPPING, hibernateFail: true });
      expect(receipt(paused)).toMatchObject({ ok: false, reason: "hibernate_failed", from: "napping", to: "napping" });
    });

    it("reports a timeout and never touches the computer afterwards", () => {
      const run = h.run(hib(), withProbe(AWAKE), { STUB_TIMEOUT_EXPIRES: "240" });
      expect(receipt(run)).toMatchObject({ ok: false, reason: "hibernate_timeout", to: "awake" });
      expect(run.calls.some((c) => c.startsWith("qm resume"))).toBe(false);
    });

    it("refuses a computer that is already saved, stopped or odd", () => {
      for (const state of [HIBERNATED, COLD, { ...AWAKE, qmp: "io-error" }, { ...AWAKE, lock: "suspending" }]) {
        const run = h.run(hib(), withProbe(state));
        expect(receipt(run)).toMatchObject({ ok: false, reason: "not_sleepable" });
        noMutation(run.calls);
      }
    });

    it("is busy when the per-VM lock is held", () => {
      const run = h.run(hib(), withProbe(AWAKE), { STUB_FLOCK_BUSY: "1" });
      expect(receipt(run)).toMatchObject({ ok: false, reason: "busy" });
      noMutation(run.calls);
    });
  });
});

host("wake script against a stub host", () => {
  let h: HostHarness;
  beforeAll(() => { h = makeHostHarness(); });
  afterAll(() => h.cleanup());

  const wake = () => buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION(h.provisionerDir) });
  // Short waits for the cases that run a wait out: one second for the guest agent, two polls for a start.
  const quick = (script: string) => script.replace("AGENT_WAIT=8", "AGENT_WAIT=1").replace("seq 1 30", "seq 1 2");
  const receipt = (run: { stdout: string; stderr?: string }) => explain(run, parseWakeReceipt(run.stdout, VMID));
  const none = (calls: string[]) =>
    expect(calls.filter((c) => /^(qm (resume|start|set)|qmp cont)/.test(c))).toEqual([]);
  const fixups = (calls: string[]) => calls.filter((c) => c.startsWith("qga exec "));
  const FIXUP = /^qga exec date -s @(\d{10})\.(\d{9}) >\/dev\/null; systemctl kill -s SIGKILL hivra-cf-tunnel; systemctl restart hivra-cf-tunnel$/;

  it("resumes a napping computer with QMP cont and runs the one fixup over the guest agent socket", () => {
    const before = Date.now();
    const run = h.run(wake(), NAPPING);
    const after = Date.now();
    expect(run.status).toBe(0);
    const r = receipt(run);
    expect(r).toMatchObject({ ok: true, from: "napping", to: "awake", reason: "resumed", vmid: VMID, via: "socket", tries: 1 });
    expect(Object.keys(r?.steps ?? {})).toEqual(expect.arrayContaining(["read_state", "resume", "fixup", "lock", "agent", "exec"]));
    expect(run.state.qmp).toBe("running");
    // QMP cont first, then exactly one guest exec, and none of the CLI paths.
    expect(run.calls.indexOf("qmp cont")).toBeGreaterThan(-1);
    expect(run.calls.indexOf("qmp cont")).toBeLessThan(run.calls.findIndex((c) => c.startsWith("qga exec")));
    expect(fixups(run.calls).length).toBe(1);
    expect(run.calls.some((c) => c.startsWith("qm resume") || c.startsWith("qm guest") || c.startsWith("guest "))).toBe(false);
    // One config read (binding and state together) and the state itself from QMP.
    expect(run.calls.filter((c) => c.startsWith("qm config")).length).toBe(1);
    expect(run.calls.some((c) => c.startsWith("qm status"))).toBe(false);
    // The clock the guest is given is the host's, read while the script ran.
    const m = FIXUP.exec(fixups(run.calls)[0]);
    expect(m).not.toBeNull();
    const epochMs = Number(m![1]) * 1000 + Number(m![2]) / 1e6;
    expect(epochMs).toBeGreaterThanOrEqual(before - 5);
    expect(epochMs).toBeLessThanOrEqual(after + 5);
    // A nap needs no admission and no host-wide lock, only the per-computer lock it shares with a sleep.
    expect(run.calls.some((c) => c.startsWith("admission"))).toBe(false);
    expect(run.calls.filter((c) => c.startsWith("flock"))).toEqual(["flock -x -w 15 9"]);
    expect(run.calls.indexOf("flock -x -w 15 9")).toBeLessThan(run.calls.indexOf("qmp cont"));
    expect(run.stdout.split("\n").filter((l) => l.startsWith("HIVRA_WAKE_RESULT ")).length).toBe(1);
  });

  it("restores a hibernated computer under admission, holding the lock until it runs", () => {
    mkdirSync(path.dirname(onbootMark(h)), { recursive: true });
    writeFileSync(onbootMark(h), "");
    const run = h.run(wake(), { ...HIBERNATED, qmpStatusDelay: 0.15 });
    const r = receipt(run)!;
    expect(r).toMatchObject({ ok: true, from: "hibernated", to: "awake", reason: "restored", via: "socket" });
    expect(run.state).toMatchObject({ status: "running", qmp: "running", lock: "", onboot: 1 });
    const at = (prefix: string) => run.calls.findIndex((c) => c.startsWith(prefix));
    expect(run.calls[at("admission")]).toBe("admission 1234 4096 4096 2 2048 1 1500 1200 0");
    expect(at("flock -w 60 8")).toBeGreaterThan(-1);
    expect(at("flock -w 60 8")).toBeLessThan(at("admission"));
    expect(at("admission")).toBeLessThan(at(`qm start ${VMID}`));
    expect(at(`qm start ${VMID}`)).toBeLessThan(at("flock -u 8"));
    expect(at("flock -u 8")).toBeLessThan(at(`qm set ${VMID} --onboot 1`));
    expect(at(`qm set ${VMID} --onboot 1`)).toBeLessThan(at("qga exec"));
    expect(run.calls.some((c) => c === "qmp cont")).toBe(false);
    const phases = ["binding", "read_state", "allocation_lock", "locked_recheck", "hard_admission", "start_running", "guest_fixup"];
    const wireSteps = run.stdout.match(/"steps":\{([^}]+)\}/)![1];
    const keys = Array.from(wireSteps.matchAll(/"([a-z_]+)":/g), (match) => match[1]);
    expect(keys.sort()).toEqual([...phases, "admission", "start", "resume", "fixup", "lock", "agent", "exec"].sort());
    expect(phases.reduce((sum, key) => sum + r.steps[key], 0)).toBeLessThanOrEqual(r.ms);
    expect(r.steps.start_running).toBeGreaterThanOrEqual(r.steps.start + 140);
    expect(r.steps.resume).toBeGreaterThanOrEqual(r.steps.start_running + r.steps.allocation_lock + r.steps.locked_recheck + r.steps.hard_admission);
    expect(r.steps.fixup).toBeGreaterThanOrEqual(r.steps.guest_fixup);
    expect(run.calls.filter((call) => /^(qm |flock )/.test(call))).toEqual([
      "flock -x -w 15 9", `qm config ${VMID}`, `qm status ${VMID} --verbose`,
      "flock -w 60 8", `qm config ${VMID}`, `qm status ${VMID} --verbose`,
      `qm start ${VMID}`, "flock -u 8", `qm set ${VMID} --onboot 1`,
    ]);
    expect(fixups(run.calls)).toHaveLength(1);
    expect(existsSync(onbootMark(h))).toBe(false);
    // With no mark the hibernate never turned autostart off, so the wake leaves it as it is.
    const unmarked = h.run(wake(), HIBERNATED);
    expect(receipt(unmarked)).toMatchObject({ ok: true, reason: "restored" });
    expect(unmarked.calls.some((c) => c.startsWith(`qm set ${VMID} --onboot`))).toBe(false);
    expect(unmarked.state.onboot).toBe(0);
  });

  it("gives the admission helper fast qm reads from the host's own files, and the CLI for anything else", () => {
    const conf = path.join(h.dir, "pve-qemu-server");
    mkdirSync(conf, { recursive: true });
    const cli = (run: { calls: string[] }) => run.calls.filter((c) => /^qm (config|status) /.test(c));
    const line = (run: { calls: string[] }, prefix: string) => run.calls.find((c) => c.startsWith(prefix)) ?? "";

    // A plain config file is read directly; snapshot sections and comments are left out.
    writeFileSync(path.join(conf, `${VMID}.conf`), "#note\nmemory: 4096\ncores: 2\n\n[snap1]\nmemory: 1\n");
    const fast = h.run(wake(), HIBERNATED, { STUB_ADMISSION_QM: "1" });
    expect(receipt(fast)).toMatchObject({ ok: true, reason: "restored" });
    expect(line(fast, "admission-qm-config")).toBe("admission-qm-config memory: 4096;cores: 2;");
    // No pid file: stopped, without asking the CLI.
    expect(line(fast, "admission-qm-status")).toBe("admission-qm-status status: stopped");
    const before = cli(fast).length;

    // Pending changes go to the CLI, whose answer applies them.
    writeFileSync(path.join(conf, `${VMID}.conf`), "memory: 4096\n[PENDING]\nmemory: 8192\n");
    const pending = h.run(wake(), HIBERNATED, { STUB_ADMISSION_QM: "1" });
    expect(line(pending, "admission-qm-config")).toContain("memory: 4096");
    expect(cli(pending).length).toBe(before + 1);

    // A pid file that points at this VM's process reads as running.
    const proc = spawn("python3", ["-c", "import time; time.sleep(60)", "-id", String(VMID)], { stdio: "ignore" });
    const pid = proc.pid as number;
    try {
      // The harness moves this path into its own directory, as it does for the script.
      const runDir = "/var/run/qemu-server";
      const withPid = h.run(
        `mkdir -p ${runDir}; echo ${pid} > ${runDir}/${VMID}.pid\n${wake()}`,
        HIBERNATED,
        { STUB_ADMISSION_QM: "1" },
      );
      expect(line(withPid, "admission-qm-status")).toBe("admission-qm-status status: running");
      // A pid file for some other process goes to the CLI.
      const stray = h.run(`mkdir -p ${runDir}; echo $$ > ${runDir}/${VMID}.pid\n${wake()}`, HIBERNATED, { STUB_ADMISSION_QM: "1" });
      expect(line(stray, "admission-qm-status")).toBe("admission-qm-status status: stopped");
      expect(stray.calls.some((c) => c === `qm status ${VMID}`)).toBe(true);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      rmSync(path.join(conf, `${VMID}.conf`), { force: true });
    }
  });

  describe("with the fast binding check", () => {
    const fastWake = () => buildWakeHostScript({
      vmid: VMID, bindingTag: TAG, admission: ADMISSION(h.provisionerDir), fastConfigRead: true,
    });
    const confFile = () => path.join(h.dir, "pve-qemu-server", `${VMID}.conf`);
    const writeConf = (text: string) => {
      mkdirSync(path.dirname(confFile()), { recursive: true });
      writeFileSync(confFile(), text);
    };
    const configCalls = (run: { calls: string[] }) => run.calls.filter((c) => c.startsWith("qm config"));
    afterEach(() => rmSync(confFile(), { force: true }));

    it("is off unless asked for: the binding check starts the CLI", () => {
      expect(wake()).toContain('CONFIG="$(qm config "$VMID" 2>/dev/null)" || finish false unreachable');
      expect(fastWake()).toContain('CONFIG="$(hivra_fast_qm config "$VMID" 2>/dev/null)" || finish false unreachable');
      // Switched on, the reader is defined once, ahead of the binding check, in both kinds of script.
      const fastNap = buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false, fastConfigRead: true });
      for (const script of [fastWake(), fastNap]) {
        expect(script.match(/^hivra_fast_qm\(\) \{$/gm)?.length).toBe(1);
        expect(script.indexOf("hivra_fast_qm() {")).toBeLessThan(script.indexOf("require_binding() {"));
      }
      // Switched off, the wake keeps it in the admission shell for the helper only, and a sleep has none.
      expect(wake().match(/^hivra_fast_qm\(\) \{$/gm)?.length).toBe(1);
      expect(buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false })).not.toContain("hivra_fast_qm");
    });

    it("wakes a nap reading the binding from the config file, with no qm CLI at all", () => {
      writeConf(`#note\nmemory: 4096\ntags: other;${TAG}\n\n[snap1]\ntags: someone-else\n`);
      const run = h.run(fastWake(), NAPPING);
      expect(receipt(run)).toMatchObject({ ok: true, from: "napping", to: "awake", reason: "resumed" });
      expect(configCalls(run)).toEqual([]);
    });

    it("leaves snapshot sections out, so a tag only a snapshot holds does not match", () => {
      writeConf(`memory: 4096\ntags: someone-else\n[snap1]\ntags: ${TAG}\n`);
      const run = h.run(fastWake(), NAPPING);
      expect(receipt(run)).toMatchObject({ ok: false, reason: "binding_mismatch" });
      none(run.calls);
      expect(configCalls(run)).toEqual([]);
    });

    it("hands a file with pending changes to the CLI", () => {
      writeConf(`tags: someone-else\n[PENDING]\ntags: ${TAG}\n`);
      const run = h.run(fastWake(), NAPPING);
      // The CLI's answer (from the stub host's state) is the one that counts.
      expect(receipt(run)).toMatchObject({ ok: true, reason: "resumed" });
      expect(configCalls(run)).toEqual([`qm config ${VMID}`]);
    });

    it("reads the current file again under the allocation lock without a config CLI", () => {
      const config = `tags: ${TAG}\nmemory: 4096\ncores: 2`;
      writeConf(`${config}\nlock: suspended\nvmstate: local:vm-${VMID}-state`);
      const restored = h.run(fastWake(), HIBERNATED);
      expect(receipt(restored)).toMatchObject({ ok: true, reason: "restored" });
      expect(configCalls(restored)).toEqual([]);

      const changed = h.run(fastWake(), HIBERNATED, { STUB_FLOCK_CONFIG: config });
      expect(receipt(changed)).toMatchObject({ ok: false, reason: "state_changed", to: "cold" });
      expect(configCalls(changed)).toEqual([]);
      expect(changed.calls.some(c => c.startsWith("admission ") || c.startsWith("qm start"))).toBe(false);
    });

    it("skips verbose status only for a saved VM with no runtime artifacts", () => {
      const host = makeHostHarness({ socketless: true });
      const pathToRun = "/var/run/qemu-server";
      try {
        const script = buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION(host.provisionerDir), fastConfigRead: true });
        const env = { STUB_ADMISSION_REFUSES: "1" };
        const statusCall = `qm status ${VMID} --verbose`;
        const stopped = host.run(`mkdir -p ${pathToRun}\n${script}`, HIBERNATED, env);
        expect(receipt(stopped)).toMatchObject({ ok: false, reason: "capacity", to: "hibernated" });
        expect(stopped.calls).not.toContain(statusCall);
        expect(stopped.calls).toContain("flock -w 60 8");
        expect(host.run(script, { ...HIBERNATED, vmstate: false }, env).calls).toContain(statusCall);
        expect(host.run(`ln -s missing ${pathToRun}/${VMID}.qmp\n${script}`, HIBERNATED, env).calls).toContain(statusCall);
      } finally {
        host.cleanup();
      }
    });

    it("asks the CLI when there is no config file, and says unreachable when the CLI fails too", () => {
      const viaCli = h.run(fastWake(), NAPPING);
      expect(receipt(viaCli)).toMatchObject({ ok: true, reason: "resumed" });
      expect(configCalls(viaCli)).toEqual([`qm config ${VMID}`]);
      const gone = h.run(fastWake(), { ...NAPPING, configFail: true });
      expect(receipt(gone)).toMatchObject({ ok: false, reason: "unreachable" });
      none(gone.calls);
      expect(fixups(gone.calls)).toEqual([]);
    });

    it("works the same in the sleep script", () => {
      writeConf(`tags: ${TAG}\n`);
      const nap = buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false, fastConfigRead: true });
      const run = h.run(nap, { ...AWAKE, probeStdout: probeLine() });
      expect(explain(run, parseSleepReceipt(run.stdout, VMID))).toMatchObject({ ok: true, to: "napping" });
      expect(configCalls(run)).toEqual([]);
    });
  });

  it("retries the guest agent until it answers after a restore", () => {
    // The first connection stays silent, as a guest that is still booting does.
    const run = h.run(quick(wake()).replace("AGENT_WAIT=8", "AGENT_WAIT=1").replace("AGENT_WAIT=30", "AGENT_WAIT=6"), { ...HIBERNATED, qgaSilentConnects: 1 });
    expect(receipt(run)).toMatchObject({ ok: true, reason: "restored", via: "socket", tries: 2 });
    expect(fixups(run.calls).length).toBe(1);
  });

  it("changes nothing, and says what the host shows, when a sleep holds the computer", () => {
    for (const [state, to] of [[AWAKE, "awake"], [NAPPING, "napping"], [HIBERNATED, "hibernated"]] as const) {
      const run = h.run(wake(), state, { STUB_FLOCK_BUSY: "1" });
      expect(receipt(run)).toMatchObject({ ok: false, reason: "busy", to });
      none(run.calls);
      expect(fixups(run.calls)).toEqual([]);
    }
  });

  it("keeps the lock descriptors away from the computer's own process", () => {
    expect(wake()).toMatch(/qm start "\$VMID" 7>&- 8>&- 9>&-/);
    // And every way out of the script closes them.
    expect(wake()).toMatch(/exec 7>&- 8>&- 9>&-\n\s*exit "\$code"/);
  });

  it("does not start a hibernated computer the host has no room for", () => {
    const run = h.run(wake(), HIBERNATED, { STUB_ADMISSION_REFUSES: "1" });
    expect(receipt(run)).toMatchObject({ ok: false, reason: "capacity", from: "hibernated", to: "hibernated" });
    expect(Object.keys(receipt(run)!.steps)).toEqual(["binding", "read_state", "allocation_lock", "locked_recheck", "hard_admission"]);
    none(run.calls);
    expect(fixups(run.calls)).toEqual([]);
    expect(run.state.lock).toBe("suspended");
    const locked = h.run(wake(), HIBERNATED, { STUB_FLOCK_TIMEOUT: "1" });
    expect(receipt(locked)).toMatchObject({ ok: false, reason: "lock_timeout", to: "hibernated" });
    expect(Object.keys(receipt(locked)!.steps)).toEqual(["binding", "read_state", "allocation_lock"]);
    none(locked.calls);
  });

  it("does not retry or start after batched hard admission refuses", () => {
    const script = buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: ADMISSION(h.provisionerDir), batchQemuAdmission: true });
    const run = h.run(script, HIBERNATED, { STUB_ADMISSION_REFUSES: "1" });
    expect(receipt(run)).toMatchObject({ ok: false, reason: "capacity", from: "hibernated", to: "hibernated" });
    expect(run.calls.filter((call) => call.startsWith("admission "))).toEqual(["admission 1234 4096 4096 2 2048 1 1500 1200 0"]);
    none(run.calls);
  });

  it("measures the locked recheck and refuses a changed state before admission", () => {
    const run = h.run(wake(), HIBERNATED, { STUB_FLOCK_STATE: JSON.stringify(NAPPING) });
    const r = receipt(run)!;
    expect(r).toMatchObject({ ok: false, reason: "state_changed", from: "hibernated", to: "napping" });
    expect(Object.keys(r.steps)).toEqual(["binding", "read_state", "allocation_lock", "locked_recheck"]);
    expect(run.calls.some((call) => call.startsWith("admission "))).toBe(false);
    none(run.calls);
    expect(fixups(run.calls)).toEqual([]);
  });

  it("keeps the lock and reports it when the start does not show running", () => {
    const run = h.run(quick(wake()), { ...HIBERNATED, startNoop: true });
    expect(receipt(run)).toMatchObject({ ok: false, reason: "start_unconfirmed", to: "hibernated", steps: { start_running: expect.any(Number) } });
    expect(receipt(run)?.steps).toHaveProperty("start");
    expect(receipt(run)?.steps).not.toHaveProperty("resume");
    expect(receipt(run)?.steps).not.toHaveProperty("guest_fixup");
    expect(run.calls.some((c) => c.startsWith("flock -u 8"))).toBe(false);
    expect(fixups(run.calls)).toEqual([]);
    const failed = h.run(wake(), { ...HIBERNATED, startFail: true });
    expect(receipt(failed)).toMatchObject({ ok: false, reason: "start_failed", to: "hibernated" });
  });

  it("only runs the fixup on a computer that is already running", () => {
    const run = h.run(wake(), AWAKE);
    expect(receipt(run)).toMatchObject({ ok: true, from: "awake", to: "awake", reason: "already" });
    none(run.calls);
    expect(fixups(run.calls).length).toBe(1);
  });

  it("reports a stopped computer with no saved state as cold, for the caller to start normally", () => {
    const run = h.run(wake(), COLD);
    expect(receipt(run)).toMatchObject({ ok: false, from: "cold", to: "cold", reason: "cold" });
    none(run.calls);
    expect(fixups(run.calls)).toEqual([]);
  });

  it("boots a long sleeper from its disk only when asked and only with the host's mark", () => {
    const coldMark = path.join(h.dir, "var-lib-hivra-sleep", `cold-${VMID}`);
    const coldWake = buildWakeHostScript({ vmid: VMID, bindingTag: TAG, admission: { provisionerDirectory: h.provisionerDir, hostReserveMb: 2048, enforceCeilings: true, cpuDensityMilli: 1500, memoryDensityMilli: 1200 }, coldStart: true });
    rmSync(coldMark, { force: true });
    // No mark: an owner switched it off, and it stays off.
    const unmarked = h.run(coldWake, COLD);
    expect(receipt(unmarked)).toMatchObject({ ok: false, from: "cold", to: "cold", reason: "cold" });
    expect(unmarked.calls.some((c) => c.startsWith(`qm start`))).toBe(false);
    // Marked: admitted and started like a restore, autostart given back, mark gone.
    mkdirSync(path.dirname(coldMark), { recursive: true });
    writeFileSync(coldMark, `${TAG}\n`);
    writeFileSync(onbootMark(h), "");
    const run = h.run(coldWake, { ...COLD, onboot: 0 });
    expect(receipt(run)).toMatchObject({ ok: true, from: "cold", to: "awake", reason: "cold_started" });
    const at = (prefix: string) => run.calls.findIndex((c) => c.startsWith(prefix));
    expect(at("admission")).toBeGreaterThan(-1);
    expect(at("admission")).toBeLessThan(at(`qm start ${VMID}`));
    expect(run.state).toMatchObject({ status: "running", onboot: 1 });
    expect(existsSync(coldMark)).toBe(false);
    // A mark written for another computer (a reused number) counts as none.
    writeFileSync(coldMark, "hivra-bind-other\n");
    expect(receipt(h.run(coldWake, COLD))).toMatchObject({ ok: false, reason: "cold" });
    // A refused admission leaves it off and keeps the mark for the next try.
    writeFileSync(coldMark, `${TAG}\n`);
    const refused = h.run(coldWake, COLD, { STUB_ADMISSION_REFUSES: "1" });
    expect(receipt(refused)).toMatchObject({ ok: false, reason: "capacity", to: "cold" });
    expect(existsSync(coldMark)).toBe(true);
    rmSync(coldMark, { force: true });
    // A computer with saved memory is still restored, exactly as without the switch.
    const restored = h.run(coldWake, HIBERNATED);
    expect(receipt(restored)).toMatchObject({ ok: true, from: "hibernated", reason: "restored" });
    // Without the switch the mark changes nothing.
    writeFileSync(coldMark, `${TAG}\n`);
    expect(receipt(h.run(wake(), COLD))).toMatchObject({ ok: false, reason: "cold" });
    rmSync(coldMark, { force: true });
    // Its disks are in storage: never started, even if a cold mark is also there.
    const storedMark = path.join(h.dir, "var-lib-hivra-sleep", `stored-${VMID}`);
    writeFileSync(storedMark, `${TAG}\n`);
    writeFileSync(coldMark, `${TAG}\n`);
    const stored = h.run(coldWake, COLD);
    expect(receipt(stored)).toMatchObject({ ok: false, from: "cold", to: "cold", reason: "stored" });
    expect(stored.calls.some((c) => c.startsWith(`qm start`))).toBe(false);
    expect(existsSync(storedMark)).toBe(true);
    // A stored mark written for another computer counts as none.
    writeFileSync(storedMark, "hivra-bind-other\n");
    expect(receipt(h.run(coldWake, COLD))).toMatchObject({ ok: true, reason: "cold_started" });
    rmSync(storedMark, { force: true });
    rmSync(coldMark, { force: true });
  });

  it.each([2304, 2560])("checks cold deep-sleep startup memory on a %i MiB host", (hostMemoryMb) => {
    const fixture = makeHostHarness();
    try {
      const meminfo = path.join(fixture.dir, "meminfo");
      const operations = path.join(fixture.dir, "operations");
      const marks = path.join(fixture.dir, "var-lib-hivra-sleep");
      mkdirSync(operations);
      mkdirSync(marks);
      writeFileSync(path.join(marks, `cold-${VMID}`), `${TAG}\n`);
      writeFileSync(meminfo, `MemTotal: ${hostMemoryMb * 1024} kB\n`);
      writeFileSync(path.join(fixture.dir, "bin", "nproc"), "#!/bin/sh\nprintf '8\\n'\n", { mode: 0o755 });
      writeFileSync(
        path.join(fixture.provisionerDir, "hivra-host-capacity-admission"),
        readFileSync("provisioner/hivra-host-capacity-admission"),
      );
      const script = buildWakeHostScript({
        vmid: VMID, bindingTag: TAG, coldStart: true,
        admission: { ...ADMISSION(fixture.provisionerDir), hostReserveMb: 512 },
      });
      const result = fixture.run(script, { ...COLD, memory: 2048, balloon: 1024 }, {
        HIVRA_CAPACITY_MEMINFO_PATH: meminfo,
        HIVRA_PROVISION_OPERATIONS_DIR: operations,
      });

      if (hostMemoryMb === 2304) {
        expect(receipt(result)).toMatchObject({ ok: false, reason: "capacity", to: "cold" });
        expect(result.stderr).toContain("active memory floors plus host reserve exceed physical memory");
        expect(result.calls).not.toContain(`qm start ${VMID}`);
        expect(result.state.status).toBe("stopped");
        expect(existsSync(path.join(marks, `cold-${VMID}`))).toBe(true);
      } else {
        expect(receipt(result)).toMatchObject({ ok: true, reason: "cold_started", to: "awake" });
        expect(result.calls).toContain(`qm start ${VMID}`);
        expect(result.state.status).toBe("running");
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("requires the exact admission helper and holds the allocation lock across a pilot restore", () => {
    const fixture = makeHostHarness();
    try {
      const helper = path.join(fixture.provisionerDir, "hivra-host-capacity-admission");
      const intentDir = path.join(fixture.dir, "provision-operations");
      mkdirSync(intentDir);
      const intent = path.join(intentDir, `wake-${VMID}.selected`);
      const bindingTag = `hivra-bind-${"a".repeat(32)}`;
      const env = { STUB_WAKE_INTENT: "1" };
      const grant = {
        ratioMilli: 1100, validUntilEpoch: Math.floor(Date.now() / 1000) + 60, measuredGuests: [],
        pressureBaseline: "00000000-0000-4000-8000-000000000042:0:17:0:24", hostId: "fixture-node-a", qaTemplateVmid: null,
      };
      const scriptBody = `#!/bin/bash
set -eu
[ -e /proc/$$/fd/8 ]
[ "$HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI" = "1100" ]
[ "$1 $2 $3" = "${VMID} 1024 2048" ]
printf '%s\\n' pilot_admission >&2
`;
      writeFileSync(helper, scriptBody);
      const script = buildWakeHostScript({
        vmid: VMID, bindingTag,
        admission: {
          ...ADMISSION(fixture.provisionerDir),
          overcommit: { grant, helperSha256: createHash("sha256").update(scriptBody).digest("hex") },
        },
      });
      const state = { ...HIBERNATED, tags: bindingTag, memory: 2048, balloon: 1024 };
      writeFileSync(path.join(fixture.provisionerDir, "VERSION"), "2026.11.28.1\n");
      expect(receipt(fixture.run(script, state, env))).toMatchObject({ ok: false, reason: "capacity_pilot" });
      writeFileSync(path.join(fixture.provisionerDir, "VERSION"), `${CANARY_MEMORY_OVERCOMMIT_PROVISIONER}\n`);
      const admitted = fixture.run(script, state, env);
      expect(receipt(admitted)).toMatchObject({ ok: true, reason: "restored" });
      expect(admitted.stderr).toContain("pilot_admission");
      expect(admitted.calls).toContain("wake intent present at start");
      expect(existsSync(intent)).toBe(false);
      const uncertain = fixture.run(script, { ...state, startFail: true }, env);
      expect(receipt(uncertain)).toMatchObject({ ok: false, reason: "pilot_start_unconfirmed" });
      expect(readFileSync(intent, "utf8")).toBe(`v1 ${VMID} ${bindingTag} 2048\n`);
      const pending = fixture.run(script, state, env);
      expect(receipt(pending)).toMatchObject({ ok: false, reason: "capacity_pilot" });
      expect(pending.calls).not.toContain(`qm start ${VMID}`);
      rmSync(intent);
      writeFileSync(helper, scriptBody + "\n");
      const changed = fixture.run(script, state, env);
      expect(receipt(changed)).toMatchObject({ ok: false, reason: "capacity_pilot" });
      expect(changed.calls).not.toContain(`qm start ${VMID}`);
    } finally {
      fixture.cleanup();
    }
  });

  it("drops the saved memory of a hibernated computer, marks it, and then a cold start wakes it", () => {
    const coldMark = path.join(h.dir, "var-lib-hivra-sleep", `cold-${VMID}`);
    const drop = buildMemoryDropHostScript({ vmid: VMID, bindingTag: TAG });
    const dropReceipt = (run: { stdout: string; stderr?: string }) => explain(run, parseMemoryDropReceipt(run.stdout, VMID));
    rmSync(coldMark, { force: true });
    const run = h.run(drop, HIBERNATED);
    expect(dropReceipt(run)).toEqual({ ok: true, vmid: VMID, reason: "dropped" });
    expect(run.state).toMatchObject({ status: "stopped", lock: "", vmstate: false });
    expect(run.calls).toEqual(expect.arrayContaining([`qm unlock ${VMID}`, `pvesm free local-lvm:vm-${VMID}-state-suspend`]));
    expect(run.calls.some((c) => /^qm (start|stop|destroy|resume|suspend)/.test(c))).toBe(false);
    expect(readFileSync(coldMark, "utf8")).toBe(`${TAG}\n`);
    rmSync(coldMark, { force: true });
    // Anything that is not off with saved memory is left exactly as it is, unmarked.
    for (const state of [AWAKE, NAPPING, COLD, { ...HIBERNATED, lock: "backup" }]) {
      const left = h.run(drop, state);
      expect(dropReceipt(left)).toMatchObject({ ok: false, reason: "not_hibernated" });
      expect(left.state).toEqual(state);
      expect(left.calls.some((c) => /^(qm (unlock|set)|pvesm)/.test(c))).toBe(false);
      expect(existsSync(coldMark)).toBe(false);
    }
    // Another computer's tag, or a script already working on it: nothing happens.
    expect(dropReceipt(h.run(drop, { ...HIBERNATED, tags: "hivra-bind-other" }))).toMatchObject({ ok: false, reason: "binding_mismatch" });
    const busy = h.run(drop, HIBERNATED, { STUB_FLOCK_BUSY: "1" });
    expect(dropReceipt(busy)).toMatchObject({ ok: false, reason: "busy" });
    expect(busy.state).toEqual(HIBERNATED);
    // A drop that changed nothing takes its mark away again: the computer still resumes from saved memory.
    const stuck = h.run(drop, { ...HIBERNATED, unlockFail: true, setFail: true });
    expect(dropReceipt(stuck)).toMatchObject({ ok: false, reason: "drop_failed" });
    expect(stuck.state).toMatchObject({ lock: "suspended", vmstate: true });
    expect(existsSync(coldMark)).toBe(false);
    // Half done (unlocked, saved memory still listed): marked, so the next wake still starts it.
    const partial = h.run(drop, { ...HIBERNATED, setFail: true });
    expect(dropReceipt(partial)).toMatchObject({ ok: false, reason: "drop_partial" });
    expect(existsSync(coldMark)).toBe(true);
    rmSync(coldMark, { force: true });
    expect(() => buildMemoryDropHostScript({ vmid: VMID, bindingTag: null })).toThrow();
    expect(parseMemoryDropReceipt('HIVRA_MEMORY_DROP_RESULT {"ok":true,"vmid":1234,"reason":"busy"}\n', VMID)).toBeNull();
    expect(parseMemoryDropReceipt('HIVRA_MEMORY_DROP_RESULT {"ok":true,"vmid":99999,"reason":"dropped"}\n', VMID)).toBeNull();
  });

  it("refuses any odd state and never resumes it", () => {
    for (const state of [{ ...AWAKE, qmp: "io-error" }, { ...AWAKE, qmp: "internal-error" }, { ...AWAKE, lock: "suspending" }, { ...HIBERNATED, lock: "backup" }]) {
      const run = h.run(wake(), state);
      expect(receipt(run)).toMatchObject({ ok: false, reason: "unexpected_state", to: "unknown" });
      none(run.calls);
      expect(fixups(run.calls)).toEqual([]);
    }
  });

  it("refuses the wrong binding tag", () => {
    const run = h.run(wake(), { ...NAPPING, tags: "someone-else" });
    expect(receipt(run)).toMatchObject({ ok: false, reason: "binding_mismatch" });
    none(run.calls);
    expect(fixups(run.calls)).toEqual([]);
  });

  describe("when the QMP resume does not work", () => {
    it("falls back to qm resume, and reports a resume that fails or does not take", () => {
      const viaCli = h.run(wake(), { ...NAPPING, qmpContFail: true });
      expect(receipt(viaCli)).toMatchObject({ ok: true, reason: "resumed", to: "awake" });
      expect(viaCli.calls).toContain(`qm resume ${VMID}`);
      expect(fixups(viaCli.calls).length).toBe(1);
      const noop = h.run(wake(), { ...NAPPING, qmpContNoop: true });
      expect(receipt(noop)).toMatchObject({ ok: true, reason: "resumed" });
      const failed = h.run(wake(), { ...NAPPING, qmpContFail: true, resumeFail: true });
      expect(receipt(failed)).toMatchObject({ ok: false, reason: "resume_failed", to: "napping" });
      expect(fixups(failed.calls)).toEqual([]);
    });
  });

  describe("the guest fixup", () => {
    it("falls back to a timeout-wrapped qm guest exec when the socket never works", () => {
      const run = h.run(quick(wake()), { ...NAPPING, qgaDown: true });
      expect(receipt(run)).toMatchObject({ ok: true, to: "awake", via: "qm" });
      expect(receipt(run)!.tries).toBeGreaterThan(1);
      const guest = run.calls.filter((c) => c.startsWith("guest "));
      expect(guest.length).toBe(1);
      expect(guest[0]).toMatch(/^guest \/bin\/sh -c date -s @\d{10}\.\d{9} >\/dev\/null; systemctl kill -s SIGKILL hivra-cf-tunnel; systemctl restart hivra-cf-tunnel$/);
      const i = run.calls.findIndex((c) => c.startsWith("qm guest exec"));
      expect(run.calls[i - 1]).toMatch(/^timeout \d+$/);
      expect(Object.keys(receipt(run)?.steps ?? {})).toContain("fallback");
    });

    it("leaves the computer running and reports an agent that never answers", () => {
      const run = h.run(quick(wake()), { ...NAPPING, qgaDown: true, pingFail: true });
      expect(receipt(run)).toMatchObject({ ok: false, reason: "agent_timeout", to: "awake" });
    });

    it("reports a tunnel that did not restart, without running it twice", () => {
      const run = h.run(wake(), { ...NAPPING, execFailMatch: "hivra-cf-tunnel" });
      expect(receipt(run)).toMatchObject({ ok: false, reason: "tunnel_failed", to: "awake", via: "socket" });
      expect(fixups(run.calls).length).toBe(1);
      expect(run.calls.some((c) => c.startsWith("guest "))).toBe(false);
    });
  });
});

describe("idle probe host script", () => {
  const script = () => buildIdleProbeHostScript({ vmid: VMID, bindingTag: TAG });

  it("refuses a computer that is not plainly running, without asking the guest", () => {
    expect(script()).toContain("run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c");
    expect(script()).toContain("refuse asleep");
  });

  host("against a stub host", () => {
    let h: HostHarness;
    beforeAll(() => { h = makeHostHarness(); });
    afterAll(() => h.cleanup());

    it("prints the guest's one line for a running computer", () => {
      const run = h.run(script(), { ...AWAKE, probeStdout: probeLine() });
      expect(run.status).toBe(0);
      expect(parseIdleProbeOutput(run.stdout)?.activeRuns).toBe(0);
    });

    it.each([
      [NAPPING, "asleep"],
      [HIBERNATED, "asleep"],
      [COLD, "not_running"],
      [{ ...AWAKE, qmp: "io-error" }, "unexpected_state"],
      [{ ...AWAKE, tags: "other" }, "binding_mismatch"],
    ])("refuses %#", (state, reason) => {
      const run = h.run(script(), { ...state, probeStdout: probeLine() });
      expect(parseIdleProbeRefusal(run.stdout)).toBe(reason);
      expect(parseIdleProbeOutput(run.stdout)).toBeNull();
      expect(run.calls.some((c) => c.startsWith("guest "))).toBe(false);
    });

    it("refuses when the guest does not answer", () => {
      const run = h.run(script(), { ...AWAKE });
      expect(parseIdleProbeRefusal(run.stdout)).toBe("guest_unreachable");
    });
  });
});

describe("parseIdleProbeOutput", () => {
  it("reads exactly one valid line", () => {
    expect(parseIdleProbeOutput(`noise\n${probeLine()}`)?.liveChannels).toEqual([]);
    expect(parseIdleProbeOutput(probeLine() + probeLine())).toBeNull();
    expect(parseIdleProbeOutput("")).toBeNull();
    expect(parseIdleProbeOutput("HIVRA_IDLE {not json}")).toBeNull();
    expect(parseIdleProbeOutput("HIVRA_IDLE []")).toBeNull();
  });

  it.each([
    { v: 2 },
    { activeRuns: -1 },
    { activeRuns: 1.5 },
    { activeRuns: "0" },
    { terminalAttached: 0 },
    { lastUsedAt: "yesterday" },
    { now: null },
    { liveChannels: "none" },
    { liveChannels: ["bad name"] },
    { loadavg: [0, 0] },
    { loadavg: [0, 0, "x"] },
    { errors: [1] },
    { cpus: -2 },
  ])("rejects %j", (bad) => {
    expect(parseIdleProbeOutput(probeLine(bad))).toBeNull();
  });

  it("rejects a missing field", () => {
    const line = JSON.parse(probeLine().slice("HIVRA_IDLE ".length));
    delete line.sshSessions;
    expect(parseIdleProbeOutput(`HIVRA_IDLE ${JSON.stringify(line)}`)).toBeNull();
  });

  it("accepts null times", () => {
    expect(parseIdleProbeOutput(probeLine({ lastUsedAt: null, nextJobAt: null }))).toMatchObject({ lastUsedAt: null });
  });
});

describe("idleVerdict", () => {
  const base = probeLine();
  const probe = (overrides: Record<string, unknown> = {}) => parseIdleProbeOutput(probeLine(overrides))!;
  const now = Date.parse("2026-11-12T12:00:00Z");
  const options = { manual: false, nowMs: now, idleWindowS: 300, horizonS: 1200, cores: 2 };

  it("is idle when nothing is going on", () => {
    expect(base).toBeTruthy();
    expect(idleVerdict(probe(), options)).toEqual({ idle: true, reasons: [], nextJobAt: null });
  });

  it.each([
    [{ activeRuns: 1 }, "active_runs"],
    [{ cliProcesses: 1 }, "cli_process"],
    [{ liveChannels: ["hermes:slack"] }, "live_channels"],
    [{ openConnections: 1 }, "open_connections"],
    [{ terminalAttached: true }, "terminal_attached"],
    [{ sshSessions: 2 }, "ssh_sessions"],
    [{ desktopAttached: true }, "desktop_attached"],
    [{ lastUsedAt: "2026-11-12T11:57:00Z" }, "recent_use"],
    [{ lastUsedAt: "2026-11-12T12:30:00Z" }, "recent_use"],
    [{ loadavg: [1.0, 0, 0] }, "high_load"],
    [{ nextJobAt: "2026-11-12T12:19:00Z" }, "job_soon"],
    [{ nextJobAt: "2026-11-12T11:00:00Z" }, "job_soon"],
    [{ errors: ["tmux"] }, "probe_error"],
    [{ lastUsedAt: null, uptimeS: 60 }, "recently_started"],
  ])("is not idle for %j", (overrides, reason) => {
    const verdict = idleVerdict(probe(overrides), options);
    expect(verdict.idle).toBe(false);
    expect(verdict.reasons).toContain(reason);
  });

  it("treats a never used, long running computer as idle", () => {
    expect(idleVerdict(probe({ lastUsedAt: null }), options).idle).toBe(true);
  });

  it("ignores an informational timers error", () => {
    expect(idleVerdict(probe({ errors: ["timers"] }), options).idle).toBe(true);
  });

  it("a manual sleep ignores the page's own signals but never a run, channel or job", () => {
    const manual = { ...options, manual: true };
    const noise = { openConnections: 4, terminalAttached: true, sshSessions: 1, desktopAttached: true,
      lastUsedAt: "2026-11-12T11:59:59Z", loadavg: [5, 5, 5] };
    expect(idleVerdict(probe(noise), manual).idle).toBe(true);
    expect(idleVerdict(probe({ ...noise, activeRuns: 1 }), manual).reasons).toEqual(["active_runs"]);
    expect(idleVerdict(probe({ cliProcesses: 1 }), manual).idle).toBe(false);
    expect(idleVerdict(probe({ liveChannels: ["telegram:bux-tg"] }), manual).idle).toBe(false);
    expect(idleVerdict(probe({ nextJobAt: "2026-11-12T12:05:00Z" }), manual).idle).toBe(false);
  });

  it("allows a job beyond the horizon and reports it on the server's clock", () => {
    const verdict = idleVerdict(probe({ nextJobAt: "2026-11-12T13:00:00Z" }), options);
    expect(verdict).toEqual({ idle: true, reasons: [], nextJobAt: "2026-11-12T13:00:00.000Z" });
    // A guest clock an hour behind the server gives the same distance to the job.
    const skewed = idleVerdict(probe({ now: "2026-11-12T11:00:00Z", lastUsedAt: "2026-11-12T10:00:00Z", nextJobAt: "2026-11-12T12:00:00Z" }), options);
    expect(skewed.idle).toBe(true);
    expect(skewed.nextJobAt).toBe("2026-11-12T13:00:00.000Z");
  });

  it("collects every reason", () => {
    const verdict = idleVerdict(probe({ activeRuns: 1, sshSessions: 1 }), options);
    expect(verdict.reasons).toEqual(["active_runs", "ssh_sessions"]);
  });

  it("is not idle for a probe or options it cannot trust", () => {
    expect(idleVerdict(null, options)).toEqual({ idle: false, reasons: ["probe_invalid"], nextJobAt: null });
    expect(idleVerdict({ ...probe(), activeRuns: undefined }, options).idle).toBe(false);
    expect(idleVerdict({}, options).idle).toBe(false);
    expect(idleVerdict(probe(), { ...options, idleWindowS: Number.NaN }).idle).toBe(false);
    expect(idleVerdict(probe(), { ...options, horizonS: -1 }).idle).toBe(false);
    expect(idleVerdict(probe(), { ...options, cores: 0 }).reasons).toContain("load_unknown");
  });
});

describe("receipt parsers", () => {
  const sleepRow = (over: Record<string, unknown> = {}) => ({
    ok: true, vmid: VMID, tier: "nap", from: "awake", to: "napping", reason: "napped", ms: 1200,
    steps: { read_state: 40, probe: 300, suspend: 90 },
    probe: JSON.parse(probeLine().slice("HIVRA_IDLE ".length)), ...over,
  });
  const wakeRow = (over: Record<string, unknown> = {}) => ({
    ok: true, vmid: VMID, from: "napping", to: "awake", reason: "resumed", ms: 900, steps: { resume: 20, agent: 100 }, ...over,
  });
  const sleepLine = (row: unknown) => `HIVRA_SLEEP_RESULT ${JSON.stringify(row)}\n`;
  const wakeLine = (row: unknown) => `HIVRA_WAKE_RESULT ${JSON.stringify(row)}\n`;

  it("reads a good sleep receipt", () => {
    const r = parseSleepReceipt(`warning\n${sleepLine(sleepRow())}`, VMID);
    expect(r).toMatchObject({ ok: true, tier: "nap", to: "napping", steps: { probe: 300 } });
    expect(r?.probe?.now).toBe("2026-11-12T12:00:00Z");
    expect(parseSleepReceipt(sleepLine(sleepRow({ tier: "hibernate", to: "hibernated", probe: null })))).toMatchObject({ probe: null });
  });

  it.each([
    ["no line", ""],
    ["two lines", sleepLine(sleepRow()) + sleepLine(sleepRow())],
    ["not json", "HIVRA_SLEEP_RESULT {oops"],
    ["a wake prefix", wakeLine(sleepRow())],
    ["ok not a boolean", sleepLine(sleepRow({ ok: "yes" }))],
    ["a bad state", sleepLine(sleepRow({ to: "sleeping" }))],
    ["a bad reason", sleepLine(sleepRow({ reason: "Not OK!" }))],
    ["a negative time", sleepLine(sleepRow({ ms: -1 }))],
    ["a fractional time", sleepLine(sleepRow({ ms: 1.5 }))],
    ["bad steps", sleepLine(sleepRow({ steps: { probe: "fast" } }))],
    ["a bad step name", sleepLine(sleepRow({ steps: { "Probe!": 1 } }))],
    ["a bad tier", sleepLine(sleepRow({ tier: "deep" }))],
    ["a bad probe", sleepLine(sleepRow({ probe: { v: 1 } }))],
    ["a nap with no probe", sleepLine(sleepRow({ probe: null }))],
    ["a nap that did not end napping", sleepLine(sleepRow({ to: "awake" }))],
    ["a hibernate that did not end saved", sleepLine(sleepRow({ tier: "hibernate", to: "napping" }))],
    ["another vmid", sleepLine(sleepRow({ vmid: 4321 }))],
    ["a missing field", sleepLine((() => { const row: Record<string, unknown> = sleepRow(); delete row.reason; return row; })())],
  ])("rejects a sleep receipt with %s", (_name, stdout) => {
    expect(parseSleepReceipt(stdout, VMID)).toBeNull();
  });

  it("accepts a failed sleep that reports where the computer ended up", () => {
    expect(parseSleepReceipt(sleepLine(sleepRow({ ok: false, to: "awake", reason: "active" })), VMID)).toMatchObject({ ok: false, to: "awake" });
  });

  it("reads wake receipts strictly", () => {
    expect(parseWakeReceipt(wakeLine(wakeRow()), VMID)).toMatchObject({ ok: true, from: "napping", to: "awake" });
    expect(parseWakeReceipt(wakeLine(wakeRow({ ok: false, to: "cold", from: "cold", reason: "cold" })), VMID)).toMatchObject({ to: "cold" });
    expect(parseWakeReceipt("", VMID)).toBeNull();
    expect(parseWakeReceipt(wakeLine(wakeRow()) + wakeLine(wakeRow()), VMID)).toBeNull();
    expect(parseWakeReceipt(wakeLine(wakeRow({ to: "hibernated" })), VMID)).toBeNull();
    expect(parseWakeReceipt(wakeLine(wakeRow({ vmid: 1 })), VMID)).toBeNull();
    expect(parseWakeReceipt(wakeLine(wakeRow()), 4321)).toBeNull();
    expect(parseWakeReceipt(sleepLine(wakeRow()), VMID)).toBeNull();
  });

  it("reads how the wake fixup ran, and rejects anything else", () => {
    expect(parseWakeReceipt(wakeLine(wakeRow()), VMID)).toMatchObject({ via: "none", tries: 0 });
    expect(parseWakeReceipt(wakeLine(wakeRow({ via: "socket", tries: 3 })), VMID)).toMatchObject({ via: "socket", tries: 3 });
    expect(parseWakeReceipt(wakeLine(wakeRow({ via: "qm", tries: 9 })), VMID)).toMatchObject({ via: "qm" });
    for (const bad of [{ via: "ssh" }, { via: 1 }, { tries: -1 }, { tries: 1.5 }, { tries: "2" }, { via: "none", tries: 0 }]) {
      expect(parseWakeReceipt(wakeLine(wakeRow(bad)), VMID)).toBeNull();
    }
    // A failure may report that no fixup ran.
    expect(parseWakeReceipt(wakeLine(wakeRow({ ok: false, to: "hibernated", from: "hibernated", reason: "capacity", via: "none", tries: 0 })), VMID))
      .toMatchObject({ ok: false, via: "none" });
  });
});
