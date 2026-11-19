/** @jest-environment node */
// The scripts that deal with a save to disk that was interrupted, run for real in bash against a
// stand-in `qm` and `systemctl` that keep one computer's state in files.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("../agent-wake", () => ({}));
jest.mock("../agent-sleep-store", () => ({}));

import { buildSleepHostScript } from "../agent-sleep-scripts";
import { buildInterruptedSaveRecoveryScript, buildSleepStateHostScript, parseSaveRecoveryOk, parseSleepStateReceipt } from "../sleep-reconcile";

const VMID = 4242;
const TAG = "hivra-bind-00000000000000000000000000000000";
const SINCE = 1794980000;
const hasBash = spawnSync("bash", ["--version"]).status === 0 && spawnSync("flock", ["--version"]).status === 0;
const run = hasBash ? describe : describe.skip;

run("an interrupted save, on a stand-in host", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "hivra-interrupted-save-"));
    mkdirSync(path.join(dir, "bin"));
    mkdirSync(path.join(dir, "lock"));
    const bin = (name: string, body: string) => {
      writeFileSync(path.join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(path.join(dir, "bin", name), 0o755);
    };
    // qm: config and status come from files; unlock and resume change them.
    bin("qm", `D=${JSON.stringify(dir)}
case "$1" in
  config) cat "$D/config" ;;
  status) printf 'status: %s\\nqmpstatus: %s\\n' "$(cat "$D/status")" "$(cat "$D/qmp")" ;;
  unlock) sed -i '/^lock:/d' "$D/config"; echo unlock >> "$D/calls" ;;
  set) [ "$*" = "set ${VMID} --skiplock 1 --lock suspended" ] || exit 1
       sed -i 's/^lock:.*/lock: suspended/' "$D/config"; echo mark-saved >> "$D/calls" ;;
  resume) echo running > "$D/qmp"; echo resume >> "$D/calls" ;;
  *) echo "$1" >> "$D/calls"; exit 1 ;;
esac`);
    bin("systemctl", `[ -e ${JSON.stringify(path.join(dir, "unit-active"))} ]`);
    // journalctl: the save's own lines, only when asked for this computer's unit since a given second.
    bin("journalctl", `case "$*" in *"-u hivra-sleep-${VMID}.service --since @${SINCE} "*) cat ${JSON.stringify(path.join(dir, "journal"))} 2>/dev/null ;; esac; true`);
    writeFileSync(path.join(dir, "calls"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const host = (state: { status: string; qmp: string; lock?: string; vmstate?: boolean; tag?: string }) => {
    writeFileSync(path.join(dir, "status"), state.status);
    writeFileSync(path.join(dir, "qmp"), state.qmp);
    writeFileSync(path.join(dir, "config"), [
      "cores: 2",
      ...(state.lock ? [`lock: ${state.lock}`] : []),
      `tags: ${state.tag ?? TAG};other`,
      ...(state.vmstate ? ["vmstate: local-lvm:vm-4242-state-suspend-2026-11-18"] : []),
    ].join("\n") + "\n");
  };
  const exec = (script: string) => {
    const r = spawnSync("bash", ["-c", script.replaceAll("/run/lock", path.join(dir, "lock"))], {
      encoding: "utf8", env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}` }, timeout: 20_000,
    });
    expect(r.status).toBe(0);
    return r.stdout;
  };
  const target = { vmid: VMID, bindingTag: TAG };
  const state = () => parseSleepStateReceipt(exec(buildSleepStateHostScript(target)), VMID);
  const recover = (since: number | null = null) => exec(buildInterruptedSaveRecoveryScript(target, since));
  const calls = () => readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean);

  it("is named by the state read, which changes nothing", () => {
    host({ status: "stopped", qmp: "stopped", lock: "suspending" });
    expect(state()).toMatchObject({ ok: false, observed: "unknown", reason: "interrupted_save", unitActive: false });
    host({ status: "running", qmp: "paused", lock: "suspending" });
    expect(state()).toMatchObject({ reason: "interrupted_save" });
    host({ status: "stopped", qmp: "stopped", lock: "suspending", vmstate: true });
    expect(state()).toMatchObject({ ok: false, observed: "unknown", reason: "interrupted_save" });
    host({ status: "stopped", qmp: "stopped", lock: "backup" });
    expect(state()).toMatchObject({ ok: false, observed: "unknown", reason: "unexpected_state" });
    host({ status: "stopped", qmp: "stopped", lock: "suspended", vmstate: true });
    expect(state()).toMatchObject({ ok: true, observed: "hibernated" });
    expect(calls()).toEqual([]);
  });

  it("unlocks a computer that is off, and it then reads as off", () => {
    host({ status: "stopped", qmp: "stopped", lock: "suspending" });
    expect(parseSaveRecoveryOk(recover(), VMID)).toBe(true);
    expect(calls()).toEqual(["unlock"]);
    expect(state()).toMatchObject({ ok: true, observed: "cold" });
  });

  it("unlocks a computer the save left paused and lets it run again", () => {
    host({ status: "running", qmp: "paused", lock: "suspending" });
    expect(parseSaveRecoveryOk(recover(), VMID)).toBe(true);
    expect(calls()).toEqual(["unlock", "resume"]);
    expect(state()).toMatchObject({ ok: true, observed: "awake" });
  });

  it("marks a finished save as saved when only its last step failed, and it then reads as a deep sleeper", () => {
    // Seen on Canary: the save printed that it was done, then the quit timed out; computer off, lock left behind.
    host({ status: "stopped", qmp: "stopped", lock: "suspending", vmstate: true });
    writeFileSync(path.join(dir, "journal"), "State saved, quitting\nVM 4242 qmp command 'quit' failed - got timeout\n");
    expect(parseSaveRecoveryOk(recover(SINCE), VMID)).toBe(true);
    expect(calls()).toEqual(["mark-saved"]);
    expect(state()).toMatchObject({ ok: true, observed: "hibernated" });
  });

  it("never trusts recorded saved state without this save's own word that it finished", () => {
    host({ status: "stopped", qmp: "stopped", lock: "suspending", vmstate: true });
    // No start time known.
    writeFileSync(path.join(dir, "journal"), "State saved, quitting\n");
    expect(parseSaveRecoveryOk(recover(null), VMID)).toBe(false);
    // The journal since this save began does not say it finished.
    writeFileSync(path.join(dir, "journal"), "VM 4242 qmp command 'savevm-start' failed\n");
    expect(parseSaveRecoveryOk(recover(SINCE), VMID)).toBe(false);
    // Still running: not off.
    writeFileSync(path.join(dir, "journal"), "State saved, quitting\n");
    host({ status: "running", qmp: "paused", lock: "suspending", vmstate: true });
    expect(parseSaveRecoveryOk(recover(SINCE), VMID)).toBe(false);
    expect(calls()).toEqual([]);
    expect(state()).toMatchObject({ ok: false, reason: "interrupted_save" });
  });

  it("touches nothing when a save is still running, the lock is another kind, or it is another computer", () => {
    host({ status: "stopped", qmp: "stopped", lock: "suspending" });
    writeFileSync(path.join(dir, "unit-active"), "");
    expect(recover()).toContain('"reason":"not_interrupted"');
    rmSync(path.join(dir, "unit-active"));
    host({ status: "stopped", qmp: "stopped", lock: "backup" });
    expect(recover()).toContain('"reason":"not_interrupted"');
    host({ status: "stopped", qmp: "stopped", lock: "suspending", tag: "hivra-bind-11111111111111111111111111111111" });
    expect(recover()).toContain('"reason":"binding_mismatch"');
    expect(calls()).toEqual([]);
  });

  it("refuses while another script holds the computer", () => {
    host({ status: "stopped", qmp: "stopped", lock: "suspending" });
    const lock = path.join(dir, "lock", `hivra-vm-${VMID}.lock`);
    const inner = path.join(dir, "inner.sh");
    writeFileSync(inner, buildInterruptedSaveRecoveryScript(target).replaceAll("/run/lock", path.join(dir, "lock")));
    const out = exec(`exec 8>'${lock}'; flock -x 8; bash '${inner}' 8>&-`);
    expect(out).toContain('"reason":"busy"');
    expect(calls()).toEqual([]);
  });

  it("the deep sleep script itself recovers right after a failed save, before it reports", () => {
    const script = buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "hibernate", manual: false });
    expect(script).toContain("recover_interrupted_save() {");
    const save = script.indexOf('qm suspend "$VMID" --todisk 1');
    const recovery = script.indexOf('[ "$OBS" = unknown ] && recover_interrupted_save "$SAVE_SINCE"');
    expect(script).toContain('local conf since="${1:-}"');
    expect(script.indexOf("SAVE_SINCE=")).toBeLessThan(save);
    expect(save).toBeGreaterThan(0);
    expect(recovery).toBeGreaterThan(save);
    expect(recovery).toBeLessThan(script.indexOf("finish false hibernate_failed"));
    // A nap never saves to disk, and its script is unchanged.
    expect(buildSleepHostScript({ vmid: VMID, bindingTag: TAG, tier: "nap", manual: false })).not.toContain("recover_interrupted_save");
  });
});
