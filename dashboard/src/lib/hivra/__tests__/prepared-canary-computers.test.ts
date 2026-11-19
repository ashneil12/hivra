import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resumePreparedCanaryComputer,
  matchPreparedCanaryComputer,
  preparedCanaryBindingScript,
  preparedCanaryLifecycleScript,
  preparedCanaryReleaseScript,
  preparedComputerForDelete,
  releasePreparedComputerClaim,
  preparedConsoleHostPreparationScript,
  preparedConsoleOrigin,
  readPreparedSlot,
} from "../prepared-canary-computers";

const CONFIG = JSON.stringify({
  omarchy: { host: "node-b", node: "node-b", vmid: 2099, ip: "10.240.20.99", claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1" },
  windows: { host: "node-b", node: "node-b", vmid: 2098, ip: "10.240.20.98", claim: "00000000-0000-4000-8000-000000001005" },
});

// A deployment may serve a slot only where it holds that host's own
// credentials; without them the configuration is ignored (there is no
// cross-host key fallback).
const HOST_ENV = { PROXMOX_NODE_B_SSH_HOST: "198.51.100.11", PROXMOX_NODE_B_SSH_USER: "root" } as const;
const MANAGED_ENV_KEYS = [
  "HIVRA_MANAGED_PROVISIONER_CHANNEL",
  "HIVRA_CANARY_PREPARED_COMPUTERS_JSON",
  "HIVRA_PREPARED_COMPUTERS_JSON",
  ...Object.keys(HOST_ENV),
] as const;
const PRIOR_MANAGED_ENV = Object.fromEntries(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

/** The retained Canary deployment shape: its own lane, its own slot config. */
function retainedCanaryDeployment() {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key];
  process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
  process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON = CONFIG;
  Object.assign(process.env, HOST_ENV);
}

describe("prepared computers", () => {
  beforeEach(retainedCanaryDeployment);
  afterAll(() => {
    for (const key of MANAGED_ENV_KEYS) {
      const prior = PRIOR_MANAGED_ENV[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("keeps the exact profile, VM, IP and claim in server-only configuration", () => {
    expect(readPreparedSlot("windows")).toEqual({
      host: "node-b", node: "node-b", vmid: 2098, ip: "10.240.20.98", claim: "00000000-0000-4000-8000-000000001005",
    });
  });

  it("starts stopped prepared computers and selects the graphical Omarchy session", () => {
    const windows = preparedConsoleHostPreparationScript("windows", 2098);
    const omarchy = preparedConsoleHostPreparationScript("omarchy", 2099);
    expect(windows).toContain("if [ \"$STATUS\" = stopped ]; then qm start 2098");
    expect(windows).not.toContain("ctrl-alt-f1");
    expect(omarchy).toContain("if [ \"$STATUS\" = stopped ]; then qm start 2099");
    expect(omarchy).toContain("qm sendkey 2099 ctrl-alt-f1\nsleep 1");
  });

  it("matches only the exact configured prepared computer identity", () => {
    const row = {
      type: "linux-desktop",
      computer_profile: "windows",
      managed_provisioner_channel: "canary",
      proxmox_host: "node-b",
      vmid: 2098,
      ip: "10.240.20.98",
    };
    expect(matchPreparedCanaryComputer(row)).toEqual({
      profile: "windows",
      slot: expect.objectContaining({ host: "node-b", vmid: 2098 }),
    });
    expect(matchPreparedCanaryComputer({ ...row, vmid: 2099 })).toBeNull();
    expect(matchPreparedCanaryComputer({ ...row, ip: "10.240.20.99" })).toBeNull();
    expect(matchPreparedCanaryComputer({ ...row, managed_provisioner_channel: "default" })).toBeNull();
  });

  it.each([
    ["start", 1, "if [ \"$CURRENT_STATUS\" = stopped ]; then qm start"],
    // Stop and Restart report whether the shutdown finished or qm stop had to run.
    ["restart", 1, "if qm shutdown \"$VMID\" --timeout 60; then\n    echo \"HIVRA_STOP_MODE graceful\"\n  else\n    SHUTDOWN_WAITED=\"$(( $(date +%s) - SHUTDOWN_STARTED ))\"\n    [ \"$SHUTDOWN_WAITED\" -ge 0 ] || SHUTDOWN_WAITED=0\n    qm stop \"$VMID\"\n    echo \"HIVRA_STOP_MODE forced $SHUTDOWN_WAITED 60\""],
    ["stop", 0, "EXPECTED_STATUS=stopped"],
    ["force_stop", 0, "qm stop \"$VMID\" --overrule-shutdown 1 --timeout 30 || qm stop \"$VMID\" --timeout 30\nfi\nEXPECTED_STATUS=stopped"],
    ["force_restart", 1, "qm stop \"$VMID\" --overrule-shutdown 1 --timeout 30 || qm stop \"$VMID\" --timeout 30\nfi\nqm start \"$VMID\" 8>&-"],
  ] as const)("builds an identity-bound %s lifecycle with persistent onboot=%i", (action, onboot, transition) => {
    const slot = readPreparedSlot("windows");
    expect(slot).not.toBeNull();
    const script = preparedCanaryLifecycleScript("windows", slot!, action);
    expect(script).toContain("hivra-windows-operation%3A00000000-0000-4000-8000-000000001005");
    expect(script).toContain("name: hivra-windows-canary");
    expect(script).toContain(`qm set \"$VMID\" --onboot ${onboot} --startup order=30,up=15,down=60`);
    expect(script).toContain(transition);
    expect(script).toContain(`HIVRA_PREPARED_LIFECYCLE %s %s %s\\n' 'windows' '${action}'`);
    expect(script).not.toContain("hivra-start-on-host.sh");
  });

  it.each(["start", "restart"] as const)("holds the parent lock but excludes it from %s daemon children", action => {
    const script = preparedCanaryLifecycleScript("omarchy", readPreparedSlot("omarchy")!, action);
    const start = script.match(/qm start "\$VMID"[^;\n]*/)?.[0];
    expect(start).toBe('qm start "$VMID" 8>&-');
    const result = spawnSync("python3", ["-c", `import errno, fcntl, os, signal, subprocess, sys, tempfile
with tempfile.NamedTemporaryFile() as lock, tempfile.TemporaryDirectory() as commands:
    os.dup2(lock.fileno(), 8)
    fcntl.flock(8, fcntl.LOCK_EX)
    mock = os.path.join(commands, 'qm')
    with open(mock, 'w') as source:
        source.write('#!/bin/bash\\nsleep 30 >/dev/null 2>&1 & echo $!\\n')
    os.chmod(mock, 0o700)
    command = 'VMID=2099; ' + sys.argv[1] + '; [ -e /dev/fd/8 ]'
    child = subprocess.check_output(['bash', '-c', command], pass_fds=(8,), text=True,
                                    env={**os.environ, 'PATH': commands + ':' + os.environ['PATH']})
    pid = int(child.strip())
    try:
        probe = os.open(lock.name, os.O_RDWR)
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            raise AssertionError('parent lock was lost')
        except OSError as error:
            assert error.errno in (errno.EAGAIN, errno.EACCES)
        os.close(8)
        lock.close()
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.kill(pid, 0)
        os.close(probe)
    finally:
        os.kill(pid, signal.SIGTERM)
`, start!], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each(["force_stop", "force_restart"] as const)("never asks the computer to shut down for %s", action => {
    const script = preparedCanaryLifecycleScript("windows", readPreparedSlot("windows")!, action);
    expect(script).not.toContain("qm shutdown");
    expect(script).not.toContain("HIVRA_STOP_MODE");
  });

  // The wait is measured on the host (a stub clock here, moved on by the stub
  // qm shutdown): a shutdown that gave up at the 60 s timeout, and one that
  // failed after 2 s, are reported as what they were. Regression: the script
  // used to print "forced 60" for any failed shutdown.
  it.each([
    ["0", 5, "graceful"],
    ["1", 60, "forced 60 60"],
    ["1", 2, "forced 2 60"],
  ] as const)("a Stop whose shutdown exits %s after %i s reports %s", (shutdownExit, seconds, mode) => {
    const script = preparedCanaryLifecycleScript("windows", readPreparedSlot("windows")!, "stop");
    const transition = script.slice(script.indexOf('if [ "$CURRENT_STATUS" != stopped ]'), script.indexOf("EXPECTED_STATUS=stopped"));
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", `NOW=1000
date() { echo "$NOW"; }
qm() { if [ "$1" = shutdown ]; then NOW=$((NOW + ${seconds})); return ${shutdownExit}; fi; return 0; }
VMID=2098; CURRENT_STATUS=running
${transition}`], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`HIVRA_STOP_MODE ${mode}\n`);
  });

  it.each(["start", "stop", "restart", "force_stop", "force_restart"] as const)("emits a newline-delimited %s receipt", action => {
    const script = preparedCanaryLifecycleScript("omarchy", readPreparedSlot("omarchy")!, action);
    const receipt = script.split("\n").find(line => line.includes("printf 'HIVRA_PREPARED_LIFECYCLE"))!;
    const status = action === "stop" || action === "force_stop" ? "stopped" : "running";
    const result = spawnSync("bash", ["-s"], { encoding: "utf8", input: `CURRENT_STATUS=${status}\n${receipt}\n` });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`HIVRA_PREPARED_LIFECYCLE omarchy ${action} ${status}\n`);
  });

  const assignedOmarchy = {
    id: "assigned", user_id: "operator-a", computer_profile: "omarchy" as const,
    type: "linux-desktop", deployment_mode: "hivra-managed", managed_provisioner_channel: "canary",
    proxmox_host: "node-b", vmid: 2099, ip: "10.240.20.99", status: "running",
    infrastructure_binding_token_enforced: true,
  };

  it("cannot assign a released guest to either the next operator or its previous owner", async () => {
    let row: typeof assignedOmarchy | null = assignedOmarchy;
    const lookup = jest.fn(async () => row);
    const request = { userId: "operator-a", profile: "omarchy", operator: true } as const;
    await expect(resumePreparedCanaryComputer(request, lookup)).resolves.toBe(assignedOmarchy);
    await expect(resumePreparedCanaryComputer({ ...request, userId: "operator-b" }, lookup))
      .rejects.toThrow("prepared_slot_claimed");

    const released = await releasePreparedComputerClaim(
      { infrastructure_binding_token_hash: "a".repeat(64) },
      { profile: "omarchy", slot: readPreparedSlot("omarchy")! },
      async () => ({ ok: true, stdout: "HIVRA_PREPARED_BINDING_RELEASED\n", stderr: "" }),
    );
    expect(released.ok).toBe(true);
    row = { ...assignedOmarchy, status: "deleted" };
    await expect(resumePreparedCanaryComputer(request, lookup)).rejects.toThrow("prepared_profile_unavailable");
    row = null; // The live-owner lookup excludes deleted rows.
    await expect(resumePreparedCanaryComputer({ ...request, userId: "operator-b" }, lookup))
      .rejects.toThrow("prepared_profile_unavailable");
    await expect(resumePreparedCanaryComputer(request, lookup)).rejects.toThrow("prepared_profile_unavailable");
  });

  it.each(["omarchy", "windows"] as const)("refuses an unassigned %s slot without clean-guest evidence", async profile => {
    const lookup = jest.fn().mockResolvedValue(null);
    await expect(resumePreparedCanaryComputer({ userId: "operator-a", profile, operator: true }, lookup))
      .rejects.toThrow("prepared_profile_unavailable");
    expect(lookup).toHaveBeenCalledWith(readPreparedSlot(profile));
  });

  it("returns the existing owner's pending refresh but does not reassign it during or after cancellation", async () => {
    const pending = {
      ...assignedOmarchy, status: "provisioning", operation_kind: "provision",
      operation_payload: { stage: "prepared_omarchy_refresh" }, infrastructure_binding_token_enforced: false,
    };
    let row: (typeof pending & { desired_state?: string }) | null = pending;
    const lookup = async () => row;
    const request = { userId: "operator-a", profile: "omarchy", operator: true } as const;
    const nextOwner = { ...request, userId: "operator-b" };
    await expect(resumePreparedCanaryComputer(request, lookup)).resolves.toBe(pending);
    row = { ...pending, desired_state: "deleted" };
    await expect(resumePreparedCanaryComputer(request, lookup)).rejects.toThrow("prepared_profile_unavailable");
    await expect(resumePreparedCanaryComputer(nextOwner, lookup)).rejects.toThrow("prepared_slot_claimed");
    row = null;
    await expect(resumePreparedCanaryComputer(nextOwner, lookup)).rejects.toThrow("prepared_profile_unavailable");
  });

  it.each([
    { status: "deleted" },
    { operation_kind: "delete" },
    { desired_state: "deleted" },
    { infrastructure_binding_token_enforced: false },
    { type: "hermes" },
    { deployment_mode: "self-managed" },
    { managed_provisioner_channel: "default" },
    { proxmox_host: "another-host" },
    { vmid: 1 },
    { ip: "10.240.20.1" },
    { computer_profile: "windows" as const },
  ])("refuses to resume an ineligible row: %j", async override => {
    await expect(resumePreparedCanaryComputer(
      { userId: "operator-a", profile: "omarchy", operator: true }, async () => ({ ...assignedOmarchy, ...override }),
    )).rejects.toThrow("prepared_profile_unavailable");
  });

  it("fails closed when the active owner lookup errors", async () => {
    const lookup = jest.fn().mockRejectedValue(new Error("database_unavailable"));
    await expect(resumePreparedCanaryComputer({ userId: "operator-a", profile: "omarchy", operator: true }, lookup))
      .rejects.toThrow("database_unavailable");
  });

  it("refuses to replace a different prepared binding tag", () => {
    const slot = readPreparedSlot("windows")!;
    const script = preparedCanaryBindingScript("windows", slot, "a".repeat(64));
    expect(script).toContain("grep -Eq '^hivra-bind-[a-f0-9]{32}$'");
    expect(script).toContain("exit 43");
    expect(script).toContain("hivra-bind-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("recognizes the fixture configured on the deployment's own lane", () => {
    delete process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON;
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "default";
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = CONFIG;

    expect(readPreparedSlot("omarchy")).toEqual(expect.objectContaining({ host: "node-b", vmid: 2099 }));
    expect(matchPreparedCanaryComputer({ ...assignedOmarchy, managed_provisioner_channel: "default" }))
      .toEqual({ profile: "omarchy", slot: expect.objectContaining({ vmid: 2099 }) });
    expect(matchPreparedCanaryComputer(assignedOmarchy)).toBeNull();
  });

  it("reads only the profiles its configuration names", () => {
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = JSON.stringify({ omarchy: readPreparedSlot("omarchy") });
    expect(readPreparedSlot("omarchy")).not.toBeNull();
    expect(readPreparedSlot("windows")).toBeNull();
  });

  it("ignores a slot on a host this deployment holds no credentials for", () => {
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = JSON.stringify({
      omarchy: { ...readPreparedSlot("omarchy"), host: "node-z" },
    });
    expect(readPreparedSlot("omarchy")).toBeNull();
  });

  it("asserts the guest name its configuration gives instead of assuming Canary", () => {
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = JSON.stringify({
      omarchy: { ...readPreparedSlot("omarchy"), name: "hivra-omarchy-prod" },
    });
    const script = preparedCanaryLifecycleScript("omarchy", readPreparedSlot("omarchy")!, "start");
    expect(script).toContain("name: hivra-omarchy-prod");
    expect(script).not.toContain("name: hivra-omarchy-canary");
  });

  it("accepts only a Hivra console origin, and none at all when unset", () => {
    const envOf = (vars: Record<string, string | undefined>) => (
      { NODE_ENV: "test" as const, ...vars });
    expect(preparedConsoleOrigin(envOf({}))).toBeNull();
    expect(preparedConsoleOrigin(envOf({ HIVRA_CANARY_CONSOLE_ORIGIN: "https://console-canary.hermesos.cloud" })))
      .toBe("https://console-canary.hermesos.cloud");
    expect(preparedConsoleOrigin(envOf({ HIVRA_PREPARED_CONSOLE_ORIGIN: "https://console.hermesos.cloud/" })))
      .toBe("https://console.hermesos.cloud");
    expect(preparedConsoleOrigin(envOf({ HIVRA_PREPARED_CONSOLE_ORIGIN: "http://console.hermesos.cloud" }))).toBeNull();
    expect(preparedConsoleOrigin(envOf({ HIVRA_PREPARED_CONSOLE_ORIGIN: "https://console.evil.example" }))).toBeNull();
  });
});

describe("prepared computer release script", () => {
  const SLOT = { host: "node-b", node: "node-b", vmid: 2098, ip: "10.240.20.98", claim: "00000000-0000-4000-8000-000000001005" };
  const HASH = "a".repeat(64);
  const OWN = `hivra-bind-${"a".repeat(32)}`;
  const FOREIGN = `hivra-bind-${"b".repeat(32)}`;
  const IDENTITY = `name: hivra-windows-canary\nmeta: hivra-windows-operation%3A${SLOT.claim}`;
  // A stub qm over a config file: set --tags rewrites the tags line, set --delete tags drops it.
  const stubQm = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ROOT/calls"
case "$1" in
  config) cat "$ROOT/config" ;;
  set)
    grep -v '^tags:' "$ROOT/config" > "$ROOT/next" || true
    [ "$3" = --tags ] && echo "tags: $4" >> "$ROOT/next"
    mv "$ROOT/next" "$ROOT/config" ;;
  *) exit 0 ;;
esac
`;

  function runRelease(tags: string | null, hash: string | null = HASH, slot = SLOT) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepared-release-"));
    try {
      fs.mkdirSync(path.join(root, "bin"));
      fs.writeFileSync(path.join(root, "bin/qm"), stubQm, { mode: 0o755 });
      fs.writeFileSync(path.join(root, "bin/flock"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(path.join(root, "config"), `${IDENTITY}\n${tags === null ? "" : `tags: ${tags}\n`}`);
      fs.writeFileSync(path.join(root, "calls"), "");
      const script = preparedCanaryReleaseScript("windows", slot, hash).replaceAll("/run/lock", path.join(root, "lock"));
      const result = spawnSync("bash", ["-s"], {
        input: script, encoding: "utf8",
        env: { ...process.env, ROOT: root, PATH: `${path.join(root, "bin")}:${process.env.PATH}` },
      });
      return {
        code: result.status, stdout: result.stdout, stderr: result.stderr,
        config: fs.readFileSync(path.join(root, "config"), "utf8"),
        calls: fs.readFileSync(path.join(root, "calls"), "utf8").split("\n").filter(Boolean),
      };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  it("removes only the claim's binding tag and never stops or destroys the VM", () => {
    const result = runRelease(`hivra-prepared;${OWN};windows`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HIVRA_PREPARED_BINDING_RELEASED");
    expect(result.config).toContain("tags: hivra-prepared;windows");
    expect(result.config).not.toContain(OWN);
    expect(result.calls.some((call) => /^(stop|shutdown|destroy)\b/.test(call))).toBe(false);
  });

  it("drops the tags line when the binding was the only tag", () => {
    const result = runRelease(OWN);
    expect(result.code).toBe(0);
    expect(result.calls).toContain("set 2098 --delete tags");
    expect(result.config).not.toContain("tags:");
  });

  it("succeeds unchanged on a retried delete whose binding is already gone", () => {
    const result = runRelease("hivra-prepared");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HIVRA_PREPARED_BINDING_RELEASED");
    expect(result.calls.some((call) => call.startsWith("set"))).toBe(false);
  });

  it("refuses a slot bound to another claim and leaves its tags alone", () => {
    for (const tags of [`${OWN};${FOREIGN}`, FOREIGN]) {
      const result = runRelease(tags);
      expect(result.code).toBe(53);
      expect(result.stderr).toContain("bound to another claim");
      expect(result.calls.some((call) => call.startsWith("set"))).toBe(false);
    }
  });

  it("refuses any bound slot when the row holds no binding of its own", () => {
    const result = runRelease(OWN, null);
    expect(result.code).toBe(53);
    expect(result.calls.some((call) => call.startsWith("set"))).toBe(false);
  });

  it("refuses a VM that is not this prepared slot", () => {
    const result = runRelease(OWN, HASH, { ...SLOT, claim: "00000000-0000-4000-8000-000000009999" });
    expect(result.code).toBe(51);
    expect(result.stderr).toContain("identity mismatch");
    expect(result.calls.some((call) => call.startsWith("set"))).toBe(false);
    expect(() => preparedCanaryReleaseScript("windows", SLOT, "not-a-hash")).toThrow("prepared_binding_unavailable");
  });
});

describe("prepared computer delete routing", () => {
  const SLOT_ROW = {
    type: "linux-desktop", managed_provisioner_channel: "canary", proxmox_host: "node-b", vmid: 2098, ip: "10.240.20.98",
  };
  beforeEach(() => {
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
    process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON = CONFIG;
    Object.assign(process.env, HOST_ENV);
  });

  it("releases the configured slot of a Hivra-managed prepared claim", () => {
    expect(preparedComputerForDelete({ ...SLOT_ROW, computer_profile: "windows", deployment_mode: "hivra-managed" }))
      .toEqual({ profile: "windows", slot: expect.objectContaining({ vmid: 2098 }) });
  });

  it("refuses a Hivra-managed prepared claim that matches no configured slot", () => {
    expect(preparedComputerForDelete({ ...SLOT_ROW, vmid: 2097, computer_profile: "windows", deployment_mode: "hivra-managed" }))
      .toBe("unconfigured");
  });

  it("leaves a self-managed Windows computer and ordinary computers to the VM destroy path", () => {
    expect(preparedComputerForDelete({
      ...SLOT_ROW, computer_profile: "windows", deployment_mode: "self-managed",
      proxmox_host: "__hivra_self_managed_no_ambient_authority__",
    })).toBeNull();
    expect(preparedComputerForDelete({ ...SLOT_ROW, computer_profile: null, deployment_mode: "hivra-managed" })).toBeNull();
  });

  it("reports a release that did not print its receipt as failed", async () => {
    const slot = { host: "node-b", node: "node-b", vmid: 2098, ip: "10.240.20.98", claim: "00000000-0000-4000-8000-000000001005" };
    const runHost = jest.fn().mockResolvedValue({ ok: true, stdout: "", stderr: "" });
    const result = await releasePreparedComputerClaim({ infrastructure_binding_token_hash: "a".repeat(64) }, { profile: "windows", slot }, runHost);
    expect(result.ok).toBe(false);
    expect(runHost.mock.calls[0][0]).toContain(`hivra-bind-${"a".repeat(32)}`);
    expect(runHost.mock.calls[0][0]).not.toContain("qm destroy");
    runHost.mockResolvedValue({ ok: true, stdout: "HIVRA_PREPARED_BINDING_RELEASED\n", stderr: "" });
    expect((await releasePreparedComputerClaim({ infrastructure_binding_token_hash: "a".repeat(64) }, { profile: "windows", slot }, runHost)).ok).toBe(true);
  });
});

describe("prepared computer claims", () => {
  it("refuses a claim from an account that is not an operator before touching any slot", async () => {
    const findSlotOwner = jest.fn();
    await expect(resumePreparedCanaryComputer(
      { userId: "customer", profile: "omarchy", operator: false },
      findSlotOwner,
    )).rejects.toThrow("prepared_computer_operator_only");
    expect(findSlotOwner).not.toHaveBeenCalled();
  });
});
