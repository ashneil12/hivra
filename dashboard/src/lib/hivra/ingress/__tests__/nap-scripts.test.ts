/** @jest-environment node */

// The host-ingress variants of the nap, hibernate, wake and idle-probe host
// scripts: byte-identical with the switch off, and, run for real against the
// stub host, drain then stop then marker then napped, a marker removed on
// every wake and by hibernate, and a fixup that never names the guest tunnel.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildIdleProbeHostScript,
  buildSleepHostScript,
  buildWakeHostScript,
  parseSleepReceipt,
  parseWakeReceipt,
  type WakeAdmission,
} from "../../agent-sleep-scripts";
import {
  HOST_VM_CONTROL_INGRESS_PROGRAM,
  HOST_VM_CONTROL_PROGRAM,
  WAKE_FIXUP_INGRESS_COMMAND_TEMPLATE,
} from "../../sleep/host-vm-control-program";
import { INGRESS_PROXY_CLI, parseIngressVmStats } from "../proxy-stats";
import {
  AWAKE,
  HIBERNATED,
  NAPPING,
  TAG,
  VMID,
  makeHostHarness,
  probeLine,
  type HostHarness,
  type HostRun,
  type HostState,
} from "../../__tests__/sleep-stub-host.fixtures";

const target = { vmid: VMID, bindingTag: TAG };
const admission: WakeAdmission = {
  provisionerDirectory: "/opt/hivra/provisioner",
  hostReserveMb: 2048,
  enforceCeilings: false,
  cpuDensityMilli: 1000,
  memoryDensityMilli: 1000,
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("with host ingress off", () => {
  it("every script is byte-identical to the one built without the option", () => {
    for (const tier of ["nap", "hibernate"] as const) {
      for (const manual of [true, false]) {
        expect(digest(buildSleepHostScript({ ...target, tier, manual, hostIngress: false })))
          .toBe(digest(buildSleepHostScript({ ...target, tier, manual })));
      }
    }
    for (const killStaleSockets of [true, false]) {
      expect(digest(buildWakeHostScript({ ...target, admission, killStaleSockets, hostIngress: false })))
        .toBe(digest(buildWakeHostScript({ ...target, admission, killStaleSockets })));
    }
    expect(digest(buildIdleProbeHostScript(target, { telegram: true, ingressStats: false })))
      .toBe(digest(buildIdleProbeHostScript(target, { telegram: true })));
  });
});

describe("with host ingress on", () => {
  it("the ingress fixup sets the clock and drops dead sockets, and never names the guest tunnel", () => {
    expect(WAKE_FIXUP_INGRESS_COMMAND_TEMPLATE).not.toContain("hivra-cf-tunnel");
    expect(HOST_VM_CONTROL_INGRESS_PROGRAM).not.toContain("hivra-cf-tunnel");
    expect(HOST_VM_CONTROL_INGRESS_PROGRAM).toContain("ss -K");
    expect(HOST_VM_CONTROL_PROGRAM).toContain("hivra-cf-tunnel");
    const wake = buildWakeHostScript({ ...target, admission, hostIngress: true });
    expect(wake).not.toContain("hivra-cf-tunnel");
    expect(buildWakeHostScript({ ...target, admission, hostIngress: true, killStaleSockets: true })).toBe(wake);
  });

  it("no script carries a NUL byte or names anything host-specific", () => {
    const scripts = [
      buildSleepHostScript({ ...target, tier: "nap", manual: false, hostIngress: true }),
      buildSleepHostScript({ ...target, tier: "hibernate", manual: false, hostIngress: true }),
      buildWakeHostScript({ ...target, admission, hostIngress: true }),
      buildIdleProbeHostScript(target, { ingressStats: true }),
    ];
    for (const script of scripts) {
      expect(script.includes("\u0000")).toBe(false);
      expect(script).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    }
  });
});

const hasTools = ["bash", "python3", "perl"].every((tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0)
  && spawnSync("/usr/bin/perl", ["-MJSON::PP", "-e", "1"], { stdio: "ignore" }).status === 0;
const host = hasTools ? describe : describe.skip;

// The proxy's CLI: logs each call, answers from STUB_CTL_<CMD> (ok, busy, down, refuse).
const STUB_CTL = String.raw`#!/usr/bin/env python3
import json, os, sys
d = os.environ["STUB_DIR"]
a = sys.argv[1:]
assert a[0] == "ctl"
open(os.path.join(d, "calls.log"), "a").write("ingress " + " ".join(a[1:]) + "\n")
mode = os.environ.get("STUB_CTL_" + a[1].upper(), "ok")
if mode == "down":
    sys.stdout.write('{"error":"unreachable","ok":false}\n'); sys.exit(2)
if mode == "busy":
    sys.stdout.write('{"error":"busy","ok":false,"streams":1}\n'); sys.exit(1)
if mode == "refuse":
    sys.stdout.write('{"error":"forwarder_down","ok":false}\n'); sys.exit(1)
if a[1] == "stats":
    vm = {"route": True, "inflight": 0, "streams": 0, "draining": False, "last_any_at": None, "last_authed_at": None, "wakes": []}
    sys.stdout.write(json.dumps({"ok": True, "forwarder": True, "vms": {a[2]: vm}, "vmid": int(a[2])}) + "\n"); sys.exit(0)
sys.stdout.write(json.dumps({"ok": True, "vmid": int(a[2])}) + "\n")
`;

const STUB_SYSTEMCTL = `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_DIR/calls.log"
[ -z "\${STUB_CONNECTOR_DOWN:-}" ]
`;

host("against the stub host", () => {
  let harness: HostHarness;
  let extraBin: string;
  let ctlPath: string;

  beforeAll(() => {
    harness = makeHostHarness();
    extraBin = path.join(harness.dir, "ingress-bin");
    mkdirSync(extraBin);
    ctlPath = path.join(harness.dir, "stub-ctl.py");
    writeFileSync(ctlPath, STUB_CTL);
    chmodSync(ctlPath, 0o755);
    writeFileSync(path.join(extraBin, "systemctl"), STUB_SYSTEMCTL);
    chmodSync(path.join(extraBin, "systemctl"), 0o755);
  });
  afterAll(() => harness.cleanup());

  /**
   * Runs a script with the proxy CLI stubbed, the QEMU pid file in place and
   * the proxy's state directory made. `marker` puts a nap marker there first.
   */
  function run(script: string, state: HostState, env: Record<string, string> = {}, marker = false): HostRun & { marker: string | null } {
    const setup = [
      "mkdir -p /run/hivra-ingress-state",
      "cp \"$STUB_DIR/qemu.pid\" /var/run/qemu-server/1234.pid 2>/dev/null || true",
      marker ? "cp \"$STUB_DIR/qemu.pid\" /run/hivra-ingress-state/napped-1234" : "",
    ].filter(Boolean).join("\n");
    const result = harness.run(`${setup}\n${script.replaceAll(INGRESS_PROXY_CLI, ctlPath)}`, state, {
      PATH: `${extraBin}:${harness.dir}/bin:/usr/bin:/bin`,
      ...env,
    });
    const markerPath = path.join(result.runDir, "hivra-ingress-state", `napped-${VMID}`);
    return { ...result, marker: existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : null };
  }

  const qemuPid = () => readFileSync(path.join(harness.dir, "qemu.pid"), "utf8").trim();
  const nap = buildSleepHostScript({ ...target, tier: "nap", manual: false, hostIngress: true });
  const awakeProbe = { ...AWAKE, probeStdout: probeLine() };
  const ordered = (calls: string[]) => calls.filter((c) => /^(ingress |qmp |systemctl )/.test(c));

  describe("nap", () => {
    it("drains, stops, writes the marker with the QEMU pid, then says napped", () => {
      const result = run(nap, awakeProbe);
      const receipt = parseSleepReceipt(result.stdout, VMID);
      expect(receipt).toMatchObject({ ok: true, reason: "napped", to: "napping" });
      expect(Object.keys(receipt!.steps)).toEqual(expect.arrayContaining(["drain", "suspend", "marker"]));
      expect(ordered(result.calls)).toEqual([
        `systemctl is-active --quiet hivra-cf@${VMID}.service`,
        `ingress drain ${VMID} 2000`,
        "qmp stop",
        `ingress napped ${VMID}`,
      ]);
      expect(result.marker).toBe(qemuPid());
      expect(result.state.qmp).toBe("paused");
    });

    it("refuses with ingress_busy and never stops when the proxy has open streams", () => {
      const result = run(nap, awakeProbe, { STUB_CTL_DRAIN: "busy" });
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: false, reason: "ingress_busy", to: "awake" });
      expect(result.calls).not.toContain("qmp stop");
      expect(result.marker).toBeNull();
    });

    it("refuses with ingress_down when the proxy cannot be reached or the host connector is down", () => {
      const down = run(nap, awakeProbe, { STUB_CTL_DRAIN: "down" });
      expect(parseSleepReceipt(down.stdout, VMID)).toMatchObject({ ok: false, reason: "ingress_down", to: "awake" });
      expect(down.calls).not.toContain("qmp stop");
      const refused = run(nap, awakeProbe, { STUB_CTL_DRAIN: "refuse" });
      expect(parseSleepReceipt(refused.stdout, VMID)).toMatchObject({ ok: false, reason: "ingress_down" });
      const noConnector = run(nap, awakeProbe, { STUB_CONNECTOR_DOWN: "1" });
      expect(parseSleepReceipt(noConnector.stdout, VMID)).toMatchObject({ ok: false, reason: "ingress_down" });
      expect(noConnector.calls.some((c) => c.startsWith("ingress drain"))).toBe(false);
    });

    it("resumes, removes the marker and undrains when the proxy will not take the nap", () => {
      const result = run(nap, awakeProbe, { STUB_CTL_NAPPED: "down" });
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: false, reason: "ingress_down", to: "awake" });
      expect(ordered(result.calls)).toEqual([
        `systemctl is-active --quiet hivra-cf@${VMID}.service`,
        `ingress drain ${VMID} 2000`,
        "qmp stop",
        `ingress napped ${VMID}`,
        "qmp cont",
        `ingress undrain ${VMID}`,
      ]);
      expect(result.marker).toBeNull();
      expect(result.state.qmp).toBe("running");
    });

    it("undrains when the stop fails", () => {
      const result = run(nap, { ...awakeProbe, qmpStopFail: true });
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: false, reason: "suspend_failed", to: "awake" });
      expect(result.calls).toContain(`ingress undrain ${VMID}`);
      expect(result.marker).toBeNull();
    });

    it("keeps a computer the failed stop paused anyway, with its marker, so the proxy can wake it", () => {
      const result = run(nap, { ...awakeProbe, qmpStopFailPaused: true });
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: false, to: "napping" });
      expect(result.marker).toBe(qemuPid());
      expect(result.state.qmp).toBe("paused");
    });

    it("resumes a computer the failed stop paused anyway when the proxy will not take the marker", () => {
      const result = run(nap, { ...awakeProbe, qmpStopFailPaused: true }, { STUB_CTL_NAPPED: "down" });
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: false, to: "awake" });
      expect(result.marker).toBeNull();
      expect(result.state.qmp).toBe("running");
      expect(ordered(result.calls).slice(-2)).toEqual(["qmp cont", `ingress undrain ${VMID}`]);
    });

    it("leaves no trace of the proxy when the computer is in use", () => {
      const result = run(nap, { ...AWAKE, probeStdout: probeLine({ activeRuns: 1 }) });
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: false, reason: "active" });
      expect(ordered(result.calls)).toEqual([]);
    });
  });

  describe("hibernate", () => {
    const hibernate = buildSleepHostScript({ ...target, tier: "hibernate", manual: false, hostIngress: true });

    it("removes the nap marker once the computer is saved", () => {
      const result = run(hibernate, NAPPING, {}, true);
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: true, reason: "hibernated" });
      expect(result.marker).toBeNull();
    });

    it("drains a running computer before it is saved, and refuses when the proxy is busy", () => {
      const saved = run(hibernate, awakeProbe);
      expect(parseSleepReceipt(saved.stdout, VMID)).toMatchObject({ ok: true, reason: "hibernated" });
      expect(saved.calls).toContain(`ingress drain ${VMID} 2000`);
      const busy = run(hibernate, awakeProbe, { STUB_CTL_DRAIN: "busy" });
      expect(parseSleepReceipt(busy.stdout, VMID)).toMatchObject({ ok: false, reason: "ingress_busy", to: "awake" });
      expect(busy.state.status).toBe("running");
      const failed = run(hibernate, { ...awakeProbe, hibernateFail: true });
      expect(parseSleepReceipt(failed.stdout, VMID)).toMatchObject({ ok: false, to: "awake" });
      expect(failed.calls).toContain(`ingress undrain ${VMID}`);
    });

    it("never drains a napping computer (it has no requests to finish)", () => {
      const result = run(hibernate, NAPPING, {}, true);
      expect(result.calls.some((c) => c.startsWith("ingress drain"))).toBe(false);
    });

    it("keeps the marker when the computer is still paused after a failed save", () => {
      const result = run(hibernate, { ...NAPPING, hibernateFail: true }, {}, true);
      expect(parseSleepReceipt(result.stdout, VMID)).toMatchObject({ ok: false, to: "napping" });
      expect(result.marker).toBe(qemuPid());
    });
  });

  describe("wake", () => {
    const wake = buildWakeHostScript({ ...target, admission, hostIngress: true });

    it("removes the marker after a resume, and the fixup never touches the guest tunnel", () => {
      const result = run(wake, NAPPING, {}, true);
      expect(parseWakeReceipt(result.stdout, VMID)).toMatchObject({ ok: true, reason: "resumed", to: "awake" });
      expect(result.marker).toBeNull();
      expect(result.calls.join("\n")).not.toContain("hivra-cf-tunnel");
      expect(result.calls.some((c) => c.startsWith("qga exec date -s @") && c.includes("ss -K"))).toBe(true);
    });

    it("removes the marker on an already-awake wake too", () => {
      const result = run(wake, AWAKE, {}, true);
      expect(parseWakeReceipt(result.stdout, VMID)).toMatchObject({ ok: true, reason: "already" });
      expect(result.marker).toBeNull();
    });

    it("removes the marker after a restore", () => {
      const result = run(buildWakeHostScript({ ...target, admission: { ...admission, provisionerDirectory: harness.provisionerDir }, hostIngress: true }), HIBERNATED, {}, true);
      expect(parseWakeReceipt(result.stdout, VMID)).toMatchObject({ ok: true, reason: "restored" });
      expect(result.marker).toBeNull();
    });
  });

  describe("idle probe", () => {
    it("carries the proxy's stats for the computer in the same call", () => {
      const result = run(buildIdleProbeHostScript(target, { ingressStats: true }), awakeProbe);
      expect(result.calls).toContain(`ingress stats ${VMID}`);
      expect(parseIngressVmStats(result.stdout, VMID)).toMatchObject({ inflight: 0, streams: 0, lastAuthedAtMs: null });
    });

    it("prints an empty stats line when the proxy does not answer", () => {
      const result = run(buildIdleProbeHostScript(target, { ingressStats: true }), awakeProbe, { STUB_CTL_STATS: "down" });
      expect(parseIngressVmStats(result.stdout, VMID)).toBeNull();
    });
  });
});
