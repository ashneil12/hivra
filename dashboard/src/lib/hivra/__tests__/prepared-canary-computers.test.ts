import { spawnSync } from "node:child_process";
import {
  claimPreparedCanaryComputer,
  matchPreparedCanaryComputer,
  preparedCanaryBindingScript,
  preparedCanaryLifecycleScript,
  preparedConsoleHostPreparationScript,
  preparedConsoleOrigin,
  preparedProfilesForDeployment,
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

  it("reserves a pending Omarchy owner before dispatching its exact latest release", async () => {
    const release = { release: "v4.0.6", releaseCommit: "b".repeat(40), isoFilename: "omarchy-4.0.6.iso", isoUrl: "https://iso.omarchy.org/omarchy-4.0.6.iso", isoSha256: "c".repeat(64) };
    const reserveRefresh = jest.fn(async row => ({ ...row, id: "44444444-4444-4444-8444-444444444444" }));
    const advanceRefresh = jest.fn(async (_owner, row) => row);
    const runHost = jest.fn(); const insert = jest.fn();
    const row = await claimPreparedCanaryComputer({ userId: "owner", profile: "omarchy", name: "MY_OMARCHY" }, {
      findOwnerProfile: async () => null, findSlotOwner: async () => null, runHost, insert: insert as never,
      latestRelease: async () => release, reserveRefresh, advanceRefresh,
    });
    expect(reserveRefresh).toHaveBeenCalledWith(expect.objectContaining({ user_id: "owner", status: "provisioning", desired_state: "running", operation_kind: "provision" }), release, expect.objectContaining({vmid:2099}));
    expect(row.operation_payload).toEqual({ stage: "prepared_omarchy_refresh", refreshId: row.operation_id });
    expect(row.allocation_operation_id).toBe(row.operation_id);
    expect(advanceRefresh).toHaveBeenCalledWith("owner", row);
    expect(runHost).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
  });

  it("does not reserve or dispatch when the official latest release is unavailable", async () => {
    const reserveRefresh = jest.fn(); const advanceRefresh = jest.fn();
    await expect(claimPreparedCanaryComputer({ userId: "owner", profile: "omarchy", name: "OMARCHY" }, {
      findOwnerProfile: async () => null, findSlotOwner: async () => null,
      latestRelease: async () => { throw new Error("upstream unavailable"); }, reserveRefresh, advanceRefresh,
    })).rejects.toThrow("prepared_omarchy_release_unavailable");
    expect(reserveRefresh).not.toHaveBeenCalled(); expect(advanceRefresh).not.toHaveBeenCalled();
  });

  it("returns the durable pending row when HTTP host dispatch is unconfirmed", async () => {
    const release = { release: "v4.0.6", releaseCommit: "b".repeat(40), isoFilename: "omarchy-4.0.6.iso", isoUrl: "https://iso.omarchy.org/omarchy-4.0.6.iso", isoSha256: "c".repeat(64) };
    const row = await claimPreparedCanaryComputer({ userId: "owner", profile: "omarchy", name: "OMARCHY" }, {
      findOwnerProfile: async () => null, findSlotOwner: async () => null, latestRelease: async () => release,
      reserveRefresh: async row => ({...row,id:"44444444-4444-4444-8444-444444444444"}) as never,
      advanceRefresh: async () => { throw new Error("HTTP timeout"); },
    });
    expect(row.status).toBe("provisioning"); expect(row.operation_id).toEqual(expect.any(String));
  });

  it("opens an existing Omarchy owner's slot without forcing upgrades or calling upstream", async () => {
    const prior = { id: "44444444-4444-4444-8444-444444444444", user_id: "owner", computer_profile: "omarchy" as const,
      proxmox_host: "node-b", vmid: 2099, infrastructure_binding_token_hash: "a".repeat(64), infrastructure_binding_token_enforced: true };
    const runHost = jest.fn();
    await expect(claimPreparedCanaryComputer({ userId: "owner", profile: "omarchy", name: "OMARCHY" }, {
      findOwnerProfile: async () => prior,
      findSlotOwner: async () => null,
      runHost,
      insert: jest.fn() as never,
    })).resolves.toBe(prior);
    expect(runHost).not.toHaveBeenCalled();
  });

  it("reuses the owner's already-bound exact slot without issuing another provider mutation", async () => {
    const prior = { id: "44444444-4444-4444-8444-444444444444", user_id: "owner", computer_profile: "windows" as const,
      proxmox_host: "node-b", vmid: 2098, infrastructure_binding_token_hash: "a".repeat(64), infrastructure_binding_token_enforced: true };
    const runHost = jest.fn();
    await expect(claimPreparedCanaryComputer({ userId: "owner", profile: "windows", name: "WINDOWS" }, {
      findOwnerProfile: async () => prior,
      findSlotOwner: async () => null,
      runHost,
      insert: jest.fn() as never,
      markBindingEnforced: jest.fn(),
    })).resolves.toBe(prior);
    expect(runHost).not.toHaveBeenCalled();
  });

  it("binds a legacy owner row to the exact prepared VM before admitting it", async () => {
    const prior = { id: "44444444-4444-4444-8444-444444444444", user_id: "owner", computer_profile: "windows" as const,
      proxmox_host: "node-b", vmid: 2098, infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: false };
    const runHost = jest.fn(async (_script: string, _slot: unknown) => {
      void _script;
      void _slot;
      return { ok: true, stdout: "HIVRA_PREPARED_BINDING_READY\n", stderr: "" };
    });
    const marked = { ...prior, infrastructure_binding_token_enforced: true };
    const markBindingEnforced = jest.fn(async () => marked);
    await expect(claimPreparedCanaryComputer({ userId: "owner", profile: "windows", name: "WINDOWS" }, {
      findOwnerProfile: async () => prior,
      findSlotOwner: async () => null,
      runHost,
      insert: jest.fn() as never,
      markBindingEnforced,
    })).resolves.toBe(marked);
    expect(String(runHost.mock.calls[0][0])).toContain("hivra-bind-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(markBindingEnforced).toHaveBeenCalledWith(prior);
  });

  it("refuses to replace a different prepared binding tag", () => {
    const slot = readPreparedSlot("windows")!;
    const script = preparedCanaryBindingScript("windows", slot, "a".repeat(64));
    expect(script).toContain("grep -Eq '^hivra-bind-[a-f0-9]{32}$'");
    expect(script).toContain("exit 43");
    expect(script).toContain("hivra-bind-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("does not claim a slot already owned by another user", async () => {
    await expect(claimPreparedCanaryComputer({ userId: "owner", profile: "windows", name: "WINDOWS" }, {
      findOwnerProfile: async () => null,
      findSlotOwner: async () => ({ id: "55555555-5555-4555-8555-555555555555", user_id: "other", computer_profile: "windows", proxmox_host: "node-b", vmid: 2098 }),
      runHost: jest.fn(),
      insert: jest.fn() as never,
      markBindingEnforced: jest.fn(),
    })).rejects.toThrow("prepared_slot_claimed");
  });

  // A deployment serves the fixture it configures, on the delivery lane it
  // provisions on: production's lane is "default", and it recognises the row it
  // wrote there. The Canary channel gate is gone with it.
  it("serves a deployment's own prepared slot with no Canary channel gate", () => {
    delete process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON;
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "default";
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = CONFIG;

    expect(readPreparedSlot("omarchy")).toEqual(expect.objectContaining({ host: "node-b", vmid: 2099 }));
    expect([...preparedProfilesForDeployment()].sort()).toEqual(["omarchy", "windows"]);
    expect(matchPreparedCanaryComputer({
      type: "linux-desktop", computer_profile: "omarchy", managed_provisioner_channel: "default",
      proxmox_host: "node-b", vmid: 2099, ip: "10.240.20.99",
    })).toEqual({ profile: "omarchy", slot: expect.objectContaining({ vmid: 2099 }) });
    // Its own row on the Canary lane is not its fixture.
    expect(matchPreparedCanaryComputer({
      type: "linux-desktop", computer_profile: "omarchy", managed_provisioner_channel: "canary",
      proxmox_host: "node-b", vmid: 2099, ip: "10.240.20.99",
    })).toBeNull();
  });

  it("serves only the profiles its configuration names", () => {
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = JSON.stringify({
      omarchy: { host: "node-b", node: "node-b", vmid: 2099, ip: "10.240.20.99", claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1" },
    });
    expect(preparedProfilesForDeployment()).toEqual(["omarchy"]);
    expect(readPreparedSlot("windows")).toBeNull();
  });

  it("ignores a slot on a host this deployment holds no credentials for", () => {
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = JSON.stringify({
      omarchy: { host: "node-z", node: "node-z", vmid: 2099, ip: "10.240.20.99", claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1" },
    });
    expect(readPreparedSlot("omarchy")).toBeNull();
    expect(preparedProfilesForDeployment()).toEqual([]);
  });

  it("asserts the guest name its configuration gives instead of assuming Canary", () => {
    process.env.HIVRA_PREPARED_COMPUTERS_JSON = JSON.stringify({
      omarchy: { host: "node-b", node: "node-b", vmid: 2099, ip: "10.240.20.99",
        claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1", name: "hivra-omarchy-prod" },
    });
    const script = preparedCanaryLifecycleScript("omarchy", readPreparedSlot("omarchy")!, "start");
    expect(script).toContain("name: hivra-omarchy-prod");
    expect(script).not.toContain("name: hivra-omarchy-canary");
  });

  it("writes the pending reservation on the deployment's own delivery lane", async () => {
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "default";
    const reserveRefresh = jest.fn(async row => ({ ...row, id: "44444444-4444-4444-8444-444444444444" }));
    await claimPreparedCanaryComputer({ userId: "owner", profile: "omarchy", name: "MY_OMARCHY" }, {
      findOwnerProfile: async () => null, findSlotOwner: async () => null,
      latestRelease: async () => ({ release: "v4.0.6", releaseCommit: "b".repeat(40), isoFilename: "omarchy-4.0.6.iso", isoUrl: "https://iso.omarchy.org/omarchy-4.0.6.iso", isoSha256: "c".repeat(64) }),
      reserveRefresh, advanceRefresh: async (_owner,row) => row,
    });
    expect(reserveRefresh).toHaveBeenCalledWith(expect.objectContaining({ managed_provisioner_channel: "default" }), expect.anything(), expect.anything());
  });

  it("refuses to claim when this deployment's lane is unreadable instead of writing a canary row", async () => {
    // Regression: the claim used to fall back to "canary" and insert a row that the
    // same deployment's lifecycle and console paths then refuse, on a live VM.
    retainedCanaryDeployment();
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "not-a-lane";
    const priorTarget = process.env.VERCEL_TARGET_ENV;
    delete process.env.VERCEL_TARGET_ENV;
    const insert = jest.fn();
    const runHost = jest.fn();
    try {
      await expect(claimPreparedCanaryComputer({ userId: "owner", profile: "omarchy", name: "MY_OMARCHY" }, {
        findOwnerProfile: async () => null,
        findSlotOwner: async () => null,
        runHost: runHost as never,
        insert: insert as never,
        markBindingEnforced: jest.fn() as never,
      })).rejects.toThrow("prepared_profile_unavailable");
    } finally {
      if (priorTarget === undefined) delete process.env.VERCEL_TARGET_ENV;
      else process.env.VERCEL_TARGET_ENV = priorTarget;
    }
    expect(runHost).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
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
