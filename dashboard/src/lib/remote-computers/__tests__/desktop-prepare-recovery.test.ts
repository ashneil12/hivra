import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDesktopPrepareRecoveryScript,
  DESKTOP_PREPARE_FENCE_DIRECTORY,
  parseDesktopPrepareRecoveryOutput,
} from "../desktop-prepare-recovery";

const identity = {
  operationId: "00000000-0000-4000-8000-000000002108",
  computerId: "00000000-0000-4000-8000-000000001108",
  vmid: 1108,
  guestIp: "10.250.20.58",
  bindingTag: `hivra-bind-${"4".repeat(32)}`,
};
const BOOT = "00000000-0000-4000-8000-000000003108";

// qm stand-in: VM state from FAKE_* env; `guest exec` runs the real observer
// locally and wraps its result in the QGA JSON shape the prelude decodes.
const FAKE_QM = `#!/usr/bin/env bash
set -u
case "$1" in
  status) [ "$FAKE_VM" = missing ] && exit 2; printf 'status: %s\\n' "$FAKE_VM" ;;
  config) printf 'name: hivra-cc-1108\\ntags: %s\\n' "$FAKE_TAGS" ;;
  guest)
    if [ "$2" = cmd ]; then exit "\${FAKE_PING:-0}"; fi
    shift 6
    OUT="$("$@")"; CODE=$?
    /usr/bin/python3 -c 'import json,sys; print(json.dumps({"exited":1,"exitcode":int(sys.argv[1]),"out-data":sys.argv[2]}))' "$CODE" "$OUT" ;;
  *) exit 64 ;;
esac`;

describe("desktop preparation stale-lease recovery host observation", () => {
  let root: string;
  let guestRoot: string;
  let fenceDirectory: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "hivra-prepare-recovery-"));
    guestRoot = path.join(root, "guest", "desktop-preparations");
    fenceDirectory = path.join(root, "fences");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    mkdirSync(path.join(root, "lock"));
    for (const [name, body] of Object.entries({
      qm: FAKE_QM,
      flock: "#!/bin/sh\nexit 0\n",
      sync: "#!/bin/sh\nexit 0\n",
      // The QGA prelude uses GNU stat (Debian hosts); keep the fixture portable.
      stat: "#!/bin/sh\nif [ \"$1\" = -c ] && [ \"$2\" = %s ]; then wc -c < \"$3\" | tr -d ' '; else exec /usr/bin/stat \"$@\"; fi\n",
      // Drop root ownership flags; the fixture runs unprivileged.
      install: "#!/usr/bin/env bash\nargs=(); while [ $# -gt 0 ]; do case \"$1\" in -o|-g) shift 2;; *) args+=(\"$1\"); shift;; esac; done\nexec /usr/bin/install \"${args[@]}\"\n",
    })) {
      writeFileSync(path.join(bin, name), body);
      chmodSync(path.join(bin, name), 0o755);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(env: Record<string, string>) {
    const script = buildDesktopPrepareRecoveryScript(identity)
      .replaceAll("/run/lock", path.join(root, "lock"))
      .replaceAll("/run/hivra-qga-result", path.join(root, "qga-result"))
      .replaceAll(DESKTOP_PREPARE_FENCE_DIRECTORY, fenceDirectory)
      .replaceAll("/var/lib/hivra/desktop-preparations", guestRoot)
      .replaceAll("st_uid!=0", "st_uid!=os.getuid()");
    const result = spawnSync("bash", [], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        FAKE_TAGS: `${identity.bindingTag};hivra-op-00000000000040008000000000004108`, ...env },
    });
    expect(result.stderr).not.toMatch(/unbound|syntax error/);
    expect(result.status).toBe(0);
    return { observation: parseDesktopPrepareRecoveryOutput(result.stdout, identity),
      fenced: existsSync(path.join(fenceDirectory, identity.operationId)) };
  }

  function guestFile(name: string, content: string) {
    mkdirSync(guestRoot, { recursive: true, mode: 0o700 });
    chmodSync(guestRoot, 0o700);
    writeFileSync(path.join(guestRoot, name), content, { mode: 0o600 });
  }

  it("fences and reports a powered-off VM (the orphaned Canary lease)", () => {
    expect(run({ FAKE_VM: "stopped" })).toEqual({
      observation: { kind: "quiescent", vmStatus: "stopped", guestInstaller: "powered_off" }, fenced: true });
  });

  it("preserves the lease without a fence when the VM is missing or not ours", () => {
    expect(run({ FAKE_VM: "missing" })).toEqual({ observation: { kind: "missing" }, fenced: false });
    expect(run({ FAKE_VM: "stopped", FAKE_TAGS: `hivra-bind-${"9".repeat(32)}` }))
      .toEqual({ observation: { kind: "ownership_mismatch" }, fenced: false });
    expect(run({ FAKE_VM: "paused" })).toEqual({ observation: { kind: "busy", reason: "vm_state_unknown" }, fenced: false });
  });

  it("preserves the lease when the running guest cannot be observed", () => {
    expect(run({ FAKE_VM: "running", FAKE_PING: "1" }))
      .toEqual({ observation: { kind: "busy", reason: "guest_unreachable" }, fenced: false });
  });

  it("fences a running guest that never started the installer", () => {
    expect(run({ FAKE_VM: "running" })).toEqual({
      observation: { kind: "quiescent", vmStatus: "running", guestInstaller: "absent" }, fenced: true });
  });

  it("fences a started installer only once its guest lock is free", async () => {
    guestFile("installer.lock", "");
    guestFile(`${identity.operationId}.json`, JSON.stringify({ ...identity, version: 1, bootId: BOOT, phase: "started" }));
    const holder = spawn("/usr/bin/python3", ["-c",
      "import fcntl,os,sys,time; fd=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(fd,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(30)",
      path.join(guestRoot, "installer.lock")]);
    try {
      await new Promise<void>(resolve => holder.stdout.once("data", () => resolve()));
      expect(run({ FAKE_VM: "running" })).toEqual({
        observation: { kind: "busy", reason: "installer_running" }, fenced: false });
    } finally {
      holder.kill("SIGKILL");
      await new Promise(resolve => holder.once("exit", resolve));
    }
    expect(run({ FAKE_VM: "running" })).toEqual({
      observation: { kind: "quiescent", vmStatus: "running", guestInstaller: "exited" }, fenced: true });
  });

  it("returns the installer's own exact terminal receipt", () => {
    const receipt = { ...identity, version: 1, bootId: BOOT, exitCode: 0 };
    guestFile("installer.lock", "");
    guestFile(`${identity.operationId}.json`, JSON.stringify(receipt));
    expect(run({ FAKE_VM: "running" })).toEqual({ observation: { kind: "terminal", receipt }, fenced: true });
    guestFile(`${identity.operationId}.json`, JSON.stringify({ ...receipt, vmid: 1144 }));
    expect(run({ FAKE_VM: "running" }).observation).toBeNull();
  });

  it("rejects ambiguous or forged host output", () => {
    const line = "HIVRA_DESKTOP_PREPARE_RECOVERY vm=stopped installer=powered_off";
    expect(parseDesktopPrepareRecoveryOutput(`${line}\n${line}\n`, identity)).toBeNull();
    expect(parseDesktopPrepareRecoveryOutput("HIVRA_DESKTOP_PREPARE_RECOVERY vm=stopped installer=exited\n", identity)).toBeNull();
    expect(() => buildDesktopPrepareRecoveryScript({ ...identity, operationId: "x; reboot" })).toThrow();
  });
});
