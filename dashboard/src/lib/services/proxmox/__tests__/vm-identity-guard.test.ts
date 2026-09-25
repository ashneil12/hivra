import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildProxmoxDeleteScript,
  buildProxmoxPowerScript,
  buildProxmoxResizeScript,
  PROXMOX_VM_IDENTITY_MISMATCH_MARKER,
  PROXMOX_VM_MISSING_MARKER,
} from "../script-builders";
import { resizeProxmoxVm } from "../../proxmox-instance-service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

// A prod Hermes row whose VM was destroyed out of band kept VMID 1108 on a
// shared host; Canary Hivra then created its own VM there. Prod's pause and
// tier-resize crons shut down and shrank that foreign VM (2026-09-24).
const INSTANCE_ID = "00000000-0000-4000-8000-0000000f2801";
const FOREIGN_NAME = "hivra-cc-1108";

// qm stand-in: every call is logged; `config` reports FAKE_NAME and `status`
// reports FAKE_STATUS (or exits non-zero for a missing VM).
const FAKE_QM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$QM_LOG"
STATE="$QM_LOG.state"
[ -f "$STATE" ] || printf '%s' "$FAKE_STATUS" > "$STATE"
case "$1" in
  shutdown|stop) printf stopped > "$STATE" ;;
  start) printf running > "$STATE" ;;
esac
case "$1" in
  status) [ "$(cat "$STATE")" = missing ] && exit 2; printf 'status: %s\\n' "$(cat "$STATE")" ;;
  config) printf 'name: %s\\ncores: 1\\nipconfig0: ip=10.250.20.58/24,gw=10.250.20.1\\n' "$FAKE_NAME" ;;
  *) exit 0 ;;
esac`;

describe("Proxmox lifecycle scripts only act on the instance's own VM", () => {
  let root: string;
  let qmLog: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "hermes-vm-identity-"));
    qmLog = path.join(root, "qm.log");
    mkdirSync(path.join(root, "bin"));
    for (const [name, body] of Object.entries({ qm: FAKE_QM, sleep: "#!/bin/sh\nexit 0\n" })) {
      writeFileSync(path.join(root, "bin", name), body);
      chmodSync(path.join(root, "bin", name), 0o755);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(script: string, vm: { name: string; status: string }) {
    const result = spawnSync("bash", [], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        QM_LOG: qmLog, FAKE_NAME: vm.name, FAKE_STATUS: vm.status },
    });
    const calls = existsSync(qmLog) ? readFileSync(qmLog, "utf8").trim().split("\n") : [];
    writeFileSync(qmLog, "");
    rmSync(`${qmLog}.state`, { force: true });
    const mutations = calls.filter(call => !/^(status|config) /.test(call));
    return { status: result.status, stdout: result.stdout, mutations };
  }

  const scripts = () => ({
    pause: buildProxmoxPowerScript({ vmid: 1108, expectedInstanceId: INSTANCE_ID, action: "shutdown", setOnboot: 0 }),
    start: buildProxmoxPowerScript({ vmid: 1108, expectedInstanceId: INSTANCE_ID, action: "start", setOnboot: 1 }),
    reboot: buildProxmoxPowerScript({ vmid: 1108, expectedInstanceId: INSTANCE_ID, action: "reboot" }),
    resize: buildProxmoxResizeScript({ vmid: 1108, expectedInstanceId: INSTANCE_ID, cores: 1, memoryMb: 1024 }),
  });

  it.each(["pause", "start", "reboot", "resize"] as const)(
    "%s never touches a VMID that now holds another control plane's VM",
    kind => {
      const result = run(scripts()[kind], { name: FOREIGN_NAME, status: kind === "start" ? "stopped" : "running" });
      expect(result.status).toBe(64);
      expect(result.mutations).toEqual([]);
      expect(result.stdout).toContain(`${PROXMOX_VM_IDENTITY_MISMATCH_MARKER} 1108`);
      // Callers already treat this marker as "this instance has no VM here".
      expect(result.stdout).toContain(PROXMOX_VM_MISSING_MARKER);
    },
  );

  it.each([
    ["current slug-suffix name", `hermes-my-first-agent-${INSTANCE_ID.slice(0, 8)}`],
    ["older full-uuid name", `hermes-${INSTANCE_ID}`],
  ])("still pauses and resizes the instance's own VM (%s)", (_label, name) => {
    const pause = run(scripts().pause, { name, status: "running" });
    expect(pause.status).toBe(0);
    expect(pause.mutations).toEqual(expect.arrayContaining(["set 1108 --onboot 0", expect.stringMatching(/^shutdown 1108/)]));
    const resize = run(scripts().resize, { name, status: "running" });
    expect(resize.status).toBe(0);
    expect(resize.mutations).toEqual([expect.stringMatching(/^set 1108 --cores 1 --cpulimit 1 --memory 1024/)]);
  });

  it("does not match an unrelated VM that merely shares the id prefix elsewhere in its name", () => {
    const result = run(scripts().pause, { name: `hermes-${INSTANCE_ID.slice(0, 8)}-other`, status: "running" });
    expect(result.status).toBe(64);
    expect(result.mutations).toEqual([]);
  });

  it("keeps reporting a genuinely missing VM as missing", () => {
    const result = run(scripts().pause, { name: "", status: "missing" });
    expect(result.status).toBe(64);
    expect(result.stdout).toContain(PROXMOX_VM_MISSING_MARKER);
    expect(result.stdout).not.toContain(PROXMOX_VM_IDENTITY_MISMATCH_MARKER);
  });

  it("lets delete destroy an owned full-uuid-named VM and refuses a foreign one", () => {
    const sites = path.join(root, "sites");
    mkdirSync(sites);
    writeFileSync(path.join(sites, "gw.example.test.caddy"), `# ${INSTANCE_ID}\n`);
    const script = buildProxmoxDeleteScript({ vmid: 1904, expectedInstanceId: INSTANCE_ID,
      gatewayHost: "gw.example.test", caddySitesDir: sites, gracefulShutdownTimeoutSeconds: 1 })
      // Stop before host-level Caddy/claim cleanup, which is outside this fixture.
      .replace(/\nrm -f .*[\s\S]*$/, "\necho DELETE_DONE\n");
    const foreign = run(script, { name: FOREIGN_NAME, status: "running" });
    expect(foreign.status).toBe(42);
    expect(foreign.mutations).toEqual([]);
    const owned = run(script, { name: `hermes-${INSTANCE_ID}`, status: "running" });
    expect(owned.status).toBe(0);
    expect(owned.mutations).toEqual(expect.arrayContaining([expect.stringMatching(/^destroy 1904/)]));
  });

  it("tier resize (the path that shrank the foreign VM) refuses before any qm set or guest SSH", async () => {
    let hostScript = "";
    await resizeProxmoxVm({ vmid: 1108, expectedInstanceId: INSTANCE_ID, cpuLimit: 1, memoryMb: 1024 }, {
      env: { PROXMOX_SSH_HOST: "fixture.invalid" },
      runHostScript: async script => { hostScript = script; return { ok: true, stdout: "", stderr: "" }; },
    });
    const foreign = run(hostScript, { name: FOREIGN_NAME, status: "running" });
    expect(foreign.status).toBe(64);
    expect(foreign.mutations).toEqual([]);
    expect(foreign.stdout).toContain(PROXMOX_VM_MISSING_MARKER);
  });

  it("rejects a malformed instance identity at build time", () => {
    expect(() => buildProxmoxPowerScript({ vmid: 1108, expectedInstanceId: "x'; qm destroy 1108; '", action: "start" }))
      .toThrow();
  });
});
