/** @jest-environment node */
import { spawnSync } from "node:child_process";
import {
  buildIdleProbeHostScript, buildSleepHostScript, buildWakeHostScript, idleVerdict, parseIdleProbeOutput,
  parseIdleProbeRefusal, parseSleepReceipt, parseWakeReceipt, type WakeAdmission,
} from "../agent-sleep-scripts";
import {
  AWAKE, COLD, HIBERNATED, NAPPING, TAG, VMID, makeHostHarness, probeLine, type HostHarness, type HostState,
} from "./sleep-stub-host.fixtures";

const ADMISSION = (dir: string): WakeAdmission => ({
  provisionerDirectory: dir, hostReserveMb: 2048, enforceCeilings: true, cpuDensityMilli: 1500, memoryDensityMilli: 1200,
});

const hasTools = ["bash", "python3", "perl"].every((cmd) => spawnSync("which", [cmd]).status === 0);
const host = hasTools ? describe : describe.skip;

describe("script construction", () => {
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
    expect(nap).toContain('qm suspend "$VMID" >/dev/null');
    expect(nap).not.toContain("--todisk");
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
    expect(script).toContain("hivra-cf-tunnel");
    expect(script).toContain("hwclock --hctosys");
    expect(script).toContain("systemd-timesyncd");
    expect(script).toContain("127.0.0.1:8080/healthz");
    expect(script).toContain("HIVRA_WAKE_RESULT");
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
  const receipt = (run: { stdout: string }) => parseSleepReceipt(run.stdout, VMID);
  const noMutation = (calls: string[]) =>
    expect(calls.filter((c) => /^qm (suspend|resume|start|set)/.test(c))).toEqual([]);

  describe("nap", () => {
    it("pauses an idle running computer and reports the probe", () => {
      const run = h.run(nap(), withProbe(AWAKE));
      expect(run.status).toBe(0);
      const r = receipt(run);
      expect(r).toMatchObject({ ok: true, tier: "nap", from: "awake", to: "napping", reason: "napped", vmid: VMID });
      expect(r?.probe?.activeRuns).toBe(0);
      expect(Object.keys(r?.steps ?? {})).toEqual(expect.arrayContaining(["read_state", "probe", "suspend"]));
      expect(run.state.qmp).toBe("paused");
      expect(run.calls).toContain(`qm suspend ${VMID}`);
      expect(run.calls.some((c) => c.startsWith("qm resume"))).toBe(false);
      expect(run.calls).toContain("flock -x -n 9");
      expect(run.stdout.split("\n").filter((l) => l.startsWith("HIVRA_SLEEP_RESULT ")).length).toBe(1);
    });

    it("aborts as busy when the per-VM lock is held, touching nothing", () => {
      const run = h.run(nap(), withProbe(AWAKE), { STUB_FLOCK_BUSY: "1" });
      expect(receipt(run)).toMatchObject({ ok: false, reason: "busy" });
      noMutation(run.calls);
      expect(run.calls.some((c) => c.startsWith("guest "))).toBe(false);
    });

    it("refuses when the exact binding tag is missing", () => {
      const run = h.run(nap(), withProbe({ ...AWAKE, tags: `${TAG.slice(0, -1)}b;other` }));
      expect(receipt(run)).toMatchObject({ ok: false, reason: "binding_mismatch" });
      noMutation(run.calls);
      expect(run.calls.some((c) => c.startsWith("flock"))).toBe(false);
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
      const run = h.run(nap(), withProbe({ ...AWAKE, suspendNoop: true }));
      expect(receipt(run)).toMatchObject({ ok: false, reason: "suspend_unconfirmed", to: "awake" });
      expect(run.calls.some((c) => c.startsWith("qm resume"))).toBe(false);
      const failed = h.run(nap(), withProbe({ ...AWAKE, suspendFail: true }));
      expect(receipt(failed)).toMatchObject({ ok: false, reason: "suspend_failed", to: "awake" });
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
      const order = (prefix: string) => run.calls.findIndex((c) => c.startsWith(prefix));
      expect(order("lvs")).toBeGreaterThan(-1);
      expect(order("lvs")).toBeLessThan(order(`qm set ${VMID} --onboot 0`));
      expect(order(`qm set ${VMID} --onboot 0`)).toBeLessThan(order("systemd-run"));
      expect(run.calls).toContain("timeout 240");
      expect(run.calls).toContain(`systemd-run --unit=hivra-sleep-${VMID} --collect --wait --quiet qm suspend ${VMID} --todisk 1`);
      expect(Object.keys(r?.steps ?? {})).toEqual(expect.arrayContaining(["pool", "hibernate"]));
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
  const receipt = (run: { stdout: string }) => parseWakeReceipt(run.stdout, VMID);
  const none = (calls: string[]) =>
    expect(calls.filter((c) => /^qm (resume|start|set)/.test(c))).toEqual([]);

  it("resumes a napping computer, fixes the clock and tunnel, and waits for health", () => {
    const run = h.run(wake(), NAPPING);
    expect(run.status).toBe(0);
    const r = receipt(run);
    expect(r).toMatchObject({ ok: true, from: "napping", to: "awake", reason: "resumed", vmid: VMID });
    expect(Object.keys(r?.steps ?? {})).toEqual(expect.arrayContaining(["resume", "agent", "clock", "tunnel", "healthz"]));
    expect(run.state.qmp).toBe("running");
    const guest = run.calls.filter((c) => c.startsWith("guest "));
    expect(guest[0]).toContain("hwclock --hctosys");
    expect(guest[0]).toContain("systemd-timesyncd");
    expect(guest[1]).toContain("systemctl restart hivra-cf-tunnel");
    expect(guest[2]).toContain("127.0.0.1:8080/healthz");
    const resume = run.calls.indexOf(`qm resume ${VMID}`);
    expect(resume).toBeGreaterThan(-1);
    expect(resume).toBeLessThan(run.calls.findIndex((c) => c.startsWith("guest ")));
    // A nap needs no admission and no host-wide lock.
    expect(run.calls.some((c) => c.startsWith("admission"))).toBe(false);
    expect(run.calls.some((c) => c.startsWith("flock"))).toBe(false);
    expect(run.stdout.split("\n").filter((l) => l.startsWith("HIVRA_WAKE_RESULT ")).length).toBe(1);
  });

  it("restores a hibernated computer under admission, holding the lock until it runs", () => {
    const run = h.run(wake(), HIBERNATED);
    expect(receipt(run)).toMatchObject({ ok: true, from: "hibernated", to: "awake", reason: "restored" });
    expect(run.state).toMatchObject({ status: "running", qmp: "running", lock: "", onboot: 1 });
    const at = (prefix: string) => run.calls.findIndex((c) => c.startsWith(prefix));
    expect(run.calls[at("admission")]).toBe("admission 1234 4096 4096 2 2048 1 1500 1200 0");
    expect(at("flock -w 60 8")).toBeGreaterThan(-1);
    expect(at("flock -w 60 8")).toBeLessThan(at("admission"));
    expect(at("admission")).toBeLessThan(at(`qm start ${VMID}`));
    expect(at(`qm start ${VMID}`)).toBeLessThan(at("flock -u 8"));
    expect(at("flock -u 8")).toBeLessThan(at(`qm set ${VMID} --onboot 1`));
    expect(at(`qm set ${VMID} --onboot 1`)).toBeLessThan(at("guest "));
    expect(Object.keys(receipt(run)?.steps ?? {})).toContain("admission");
  });

  it("does not start a hibernated computer the host has no room for", () => {
    const run = h.run(wake(), HIBERNATED, { STUB_ADMISSION_REFUSES: "1" });
    expect(receipt(run)).toMatchObject({ ok: false, reason: "capacity", from: "hibernated", to: "hibernated" });
    none(run.calls);
    expect(run.state.lock).toBe("suspended");
    const locked = h.run(wake(), HIBERNATED, { STUB_FLOCK_TIMEOUT: "1" });
    expect(receipt(locked)).toMatchObject({ ok: false, reason: "lock_timeout", to: "hibernated" });
    none(locked.calls);
  });

  it("keeps the lock and reports it when the start does not show running", () => {
    const run = h.run(wake(), { ...HIBERNATED, startNoop: true });
    expect(receipt(run)).toMatchObject({ ok: false, reason: "start_unconfirmed", to: "hibernated" });
    expect(run.calls.some((c) => c.startsWith("flock -u 8"))).toBe(false);
    const failed = h.run(wake(), { ...HIBERNATED, startFail: true });
    expect(receipt(failed)).toMatchObject({ ok: false, reason: "start_failed", to: "hibernated" });
  });

  it("only runs the fixups on a computer that is already running", () => {
    const run = h.run(wake(), AWAKE);
    expect(receipt(run)).toMatchObject({ ok: true, from: "awake", to: "awake", reason: "already" });
    none(run.calls);
    expect(run.calls.filter((c) => c.startsWith("guest ")).length).toBe(3);
  });

  it("reports a stopped computer with no saved state as cold, for the caller to start normally", () => {
    const run = h.run(wake(), COLD);
    expect(receipt(run)).toMatchObject({ ok: false, from: "cold", to: "cold", reason: "cold" });
    none(run.calls);
  });

  it("refuses any odd state and never resumes it", () => {
    for (const state of [{ ...AWAKE, qmp: "io-error" }, { ...AWAKE, qmp: "internal-error" }, { ...AWAKE, lock: "suspending" }, { ...HIBERNATED, lock: "backup" }]) {
      const run = h.run(wake(), state);
      expect(receipt(run)).toMatchObject({ ok: false, reason: "unexpected_state", to: "unknown" });
      none(run.calls);
    }
  });

  it("refuses the wrong binding tag", () => {
    const run = h.run(wake(), { ...NAPPING, tags: "someone-else" });
    expect(receipt(run)).toMatchObject({ ok: false, reason: "binding_mismatch" });
    none(run.calls);
  });

  it("reports a resume that fails or does not take", () => {
    expect(receipt(h.run(wake(), { ...NAPPING, resumeFail: true }))).toMatchObject({ ok: false, reason: "resume_failed", to: "napping" });
  });

  it("leaves the computer running and reports each failed fixup", () => {
    expect(receipt(h.run(wake(), { ...NAPPING, pingFail: true }))).toMatchObject({ ok: false, reason: "agent_timeout", to: "awake" });
    expect(receipt(h.run(wake(), { ...NAPPING, execFailMatch: "hivra-cf-tunnel" }))).toMatchObject({ ok: false, reason: "tunnel_failed", to: "awake" });
    expect(receipt(h.run(wake(), { ...NAPPING, execFailMatch: "healthz" }))).toMatchObject({ ok: false, reason: "healthz_timeout", to: "awake" });
    // A clock that cannot be set is not a failed wake.
    expect(receipt(h.run(wake(), { ...NAPPING, execFailMatch: "hwclock" }))).toMatchObject({ ok: true });
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
});
