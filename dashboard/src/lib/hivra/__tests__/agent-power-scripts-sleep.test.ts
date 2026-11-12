/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { hibernationDiscardBody, verifiedStopVmBody, verifiedStopVmScript } from "../agent-power-scripts";

// The stop scripts against a stub qm that behaves the way PVE does for the
// three states an agent can be in: running, napping (paused, still reads as
// running) and hibernated (reads as stopped, but locked with a saved memory
// image). While the lock is held the stub refuses qm set and qm stop, as PVE
// does. No host name or address appears here.

const TAG = "hivra-bind-fixture";
const stubQm = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ROOT/calls"
locked() { [ -s "$ROOT/lock" ]; }
case "$1" in
  status)
    echo "status: $(cat "$ROOT/status")"
    if [ "\${3:-}" = "--verbose" ]; then echo "qmpstatus: $(cat "$ROOT/qmp")"; fi ;;
  config)
    echo "name: fixture"; echo "tags: $TAG"
    locked && echo "lock: $(cat "$ROOT/lock")"
    [ -s "$ROOT/vmstate" ] && echo "vmstate: $(cat "$ROOT/vmstate")"
    echo "onboot: $(cat "$ROOT/onboot")" ;;
  unlock) : > "$ROOT/lock" ;;
  set)
    case "$*" in
      *--delete*) [ -z "$KEEP_VMSTATE" ] && : > "$ROOT/vmstate"; exit 0 ;;
      *--onboot*) locked && { echo "VM is locked" >&2; exit 25; }; echo 0 > "$ROOT/onboot" ;;
    esac ;;
  shutdown)
    [ "$(cat "$ROOT/qmp")" = paused ] && { echo "VM is paused - cannot shutdown" >&2; exit 255; }
    locked && exit 25
    echo stopped > "$ROOT/status" ;;
  stop)
    locked && { echo "VM is locked" >&2; exit 25; }
    echo stopped > "$ROOT/status" ;;
esac
exit 0
`;

type State = { status: string; qmp: string; lock: string; vmstate: string };
const RUNNING: State = { status: "running", qmp: "running", lock: "", vmstate: "" };
const NAPPING: State = { status: "running", qmp: "paused", lock: "", vmstate: "" };
const HIBERNATED: State = { status: "stopped", qmp: "", lock: "suspended", vmstate: "local-lvm:vm-123-state-suspend-1,size=4G" };

function run(script: string, state: State, env: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "power-sleep-"));
  try {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin/qm"), stubQm, { mode: 0o755 });
    writeFileSync(path.join(root, "bin/flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(root, "bin/pvesm"), "#!/bin/sh\nprintf 'pvesm %s\\n' \"$*\" >> \"$ROOT/calls\"\n", { mode: 0o755 });
    writeFileSync(path.join(root, "bin/date"), "#!/bin/sh\necho 1000\n", { mode: 0o755 });
    for (const bin of ["qm", "flock", "pvesm", "date"]) chmodSync(path.join(root, "bin", bin), 0o755);
    writeFileSync(path.join(root, "status"), state.status);
    writeFileSync(path.join(root, "qmp"), state.qmp);
    writeFileSync(path.join(root, "lock"), state.lock);
    writeFileSync(path.join(root, "vmstate"), state.vmstate);
    writeFileSync(path.join(root, "onboot"), "1");
    writeFileSync(path.join(root, "calls"), "");
    const result = spawnSync("bash", [], {
      input: script.replaceAll("/run/lock", path.join(root, "lock-dir")), encoding: "utf8",
      env: { ...process.env, ROOT: root, TAG, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, ...env },
    });
    return {
      code: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: readFileSync(path.join(root, "calls"), "utf8").trim().split("\n").filter(Boolean),
      status: readFileSync(path.join(root, "status"), "utf8").trim(),
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const stop = (autostart = false) => verifiedStopVmScript(123, 5, TAG, autostart);

describe("stop script, sleep aware", () => {
  it("shuts a running computer down cleanly and touches nothing about sleep", () => {
    const result = run(stop(), RUNNING);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HIVRA_STOP_MODE graceful");
    expect(result.calls.some((call) => call.startsWith("shutdown"))).toBe(true);
    expect(result.calls.some((call) => call.startsWith("unlock") || call.startsWith("pvesm"))).toBe(false);
  });

  it("switches a napping computer off at once, because it cannot shut itself down", () => {
    const result = run(stop(), NAPPING);
    expect(result.code).toBe(0);
    expect(result.status).toBe("stopped");
    expect(result.stdout).toContain("HIVRA_STOP_MODE asleep");
    expect(result.calls.some((call) => call.startsWith("shutdown"))).toBe(false);
    expect(result.calls).toContain("stop 123");
  });

  it("discards a hibernation before it reports the computer stopped", () => {
    const result = run(stop(), HIBERNATED);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HIVRA_HIBERNATION_DISCARDED vmid=123");
    expect(result.stdout).toContain("HIVRA_STOP_MODE already");
    const unlock = result.calls.indexOf("unlock 123");
    const remove = result.calls.indexOf("set 123 --delete vmstate,runningmachine,runningcpu");
    expect(unlock).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(unlock);
    // The saved memory volume is freed by its volume id, without the config's size suffix.
    expect(result.calls).toContain("pvesm free local-lvm:vm-123-state-suspend-1");
    expect(result.calls.indexOf("pvesm free local-lvm:vm-123-state-suspend-1")).toBeGreaterThan(remove);
  });

  it("turns autostart off only after the hibernation is discarded (the lock refuses it before)", () => {
    const result = run(stop(true), HIBERNATED);
    expect(result.code).toBe(0);
    expect(result.calls.indexOf("unlock 123")).toBeLessThan(result.calls.indexOf("set 123 --onboot 0"));
  });

  it("still turns autostart off for a napping computer, then switches it off", () => {
    const result = run(stop(true), NAPPING);
    expect(result.code).toBe(0);
    expect(result.calls).toContain("set 123 --onboot 0");
    expect(result.calls).toContain("stop 123");
  });

  it("fails, and does not claim the computer stopped, when the saved memory cannot be discarded", () => {
    const result = run(stop(), HIBERNATED, { KEEP_VMSTATE: "1" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not be discarded");
    expect(result.stdout).not.toContain("stopped 123");
  });

  it("does nothing about sleep for a computer that is simply stopped", () => {
    const result = run(stop(), { status: "stopped", qmp: "", lock: "", vmstate: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HIVRA_STOP_MODE already");
    expect(result.calls.some((call) => call.startsWith("unlock") || call.startsWith("pvesm") || call.startsWith("set"))).toBe(false);
  });

  it("discards a left over memory image even when the lock is already gone", () => {
    const result = run(stop(), { ...HIBERNATED, lock: "" });
    expect(result.code).toBe(0);
    expect(result.calls.some((call) => call.startsWith("unlock"))).toBe(false);
    expect(result.calls).toContain("set 123 --delete vmstate,runningmachine,runningcpu");
  });

  it("is safe to run twice: the second pass finds nothing to discard", () => {
    const script = `VMID=123\n${hibernationDiscardBody()}\n${hibernationDiscardBody()}`;
    const result = run(`set -euo pipefail\n${script}`, HIBERNATED);
    expect(result.code).toBe(0);
    expect(result.calls.filter((call) => call === "unlock 123")).toHaveLength(1);
  });

  it("keeps the body start the host-script tests slice on", () => {
    expect(verifiedStopVmBody(123, 5).startsWith("VMID=123\nSTOP_MODE=already\n")).toBe(true);
  });
});
