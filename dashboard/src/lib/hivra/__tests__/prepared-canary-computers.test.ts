import { spawnSync } from "node:child_process";
import {
  claimPreparedCanaryComputer,
  matchPreparedCanaryComputer,
  preparedCanaryBindingScript,
  preparedCanaryLifecycleScript,
  preparedConsoleHostPreparationScript,
  readPreparedCanarySlot,
} from "../prepared-canary-computers";

const CONFIG = JSON.stringify({
  omarchy: { host: "node-b", node: "node-b", vmid: 2099, ip: "10.240.20.99", claim: "019d13b0-4f19-7f55-9a22-83e72232d8c1" },
  windows: { host: "node-b", node: "node-b", vmid: 2098, ip: "10.240.20.98", claim: "00000000-0000-4000-8000-000000001005" },
});

describe("prepared Canary computers", () => {
  const priorChannel = process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL;
  const priorConfig = process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON;
  beforeEach(() => {
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
    process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON = CONFIG;
  });
  afterAll(() => {
    if (priorChannel === undefined) delete process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL;
    else process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = priorChannel;
    if (priorConfig === undefined) delete process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON;
    else process.env.HIVRA_CANARY_PREPARED_COMPUTERS_JSON = priorConfig;
  });

  it("keeps the exact profile, VM, IP and claim in server-only configuration", () => {
    expect(readPreparedCanarySlot("windows")).toEqual({
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
    ["restart", 1, "qm shutdown \"$VMID\" --timeout 60 || qm stop"],
    ["stop", 0, "EXPECTED_STATUS=stopped"],
  ] as const)("builds an identity-bound %s lifecycle with persistent onboot=%i", (action, onboot, transition) => {
    const slot = readPreparedCanarySlot("windows");
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
    const script = preparedCanaryLifecycleScript("omarchy", readPreparedCanarySlot("omarchy")!, action);
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

  it.each(["start", "stop", "restart"] as const)("emits a newline-delimited %s receipt", action => {
    const script = preparedCanaryLifecycleScript("omarchy", readPreparedCanarySlot("omarchy")!, action);
    const receipt = script.split("\n").find(line => line.includes("printf 'HIVRA_PREPARED_LIFECYCLE"))!;
    const status = action === "stop" ? "stopped" : "running";
    const result = spawnSync("bash", ["-s"], { encoding: "utf8", input: `CURRENT_STATUS=${status}\n${receipt}\n` });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`HIVRA_PREPARED_LIFECYCLE omarchy ${action} ${status}\n`);
  });

  it("verifies the prepared provider identity before creating an owner row", async () => {
    const insert = jest.fn(async row => ({ ...row, id: "44444444-4444-4444-8444-444444444444",
      infrastructure_binding_token_hash: "a".repeat(64) }));
    const markBindingEnforced = jest.fn(async row => ({ ...row, infrastructure_binding_token_enforced: true }));
    const runHost = jest.fn(async (_script: string, _slot: unknown) => {
      void _slot;
      return {
        ok: true,
        stdout: _script.includes("HIVRA_PREPARED_BINDING_READY")
          ? "HIVRA_PREPARED_BINDING_READY\n" : "HIVRA_PREPARED_COMPUTER_READY\n",
        stderr: "",
      };
    });
    const row = await claimPreparedCanaryComputer({ userId: "owner", profile: "omarchy", name: "MY_OMARCHY" }, {
      findOwnerProfile: async () => null,
      findSlotOwner: async () => null,
      runHost,
      insert: insert as never,
      markBindingEnforced,
    });
    expect(runHost).toHaveBeenNthCalledWith(1,
      expect.stringContaining("hivra-omarchy-operation%3A019d13b0-4f19-7f55-9a22-83e72232d8c1"),
      expect.objectContaining({ host: "node-b", node: "node-b", vmid: 2099 }),
    );
    expect(String(runHost.mock.calls[0][0])).toContain('qm set "$VMID" --onboot 1 --startup order=30,up=15,down=60');
    expect(String(runHost.mock.calls[0][0])).toContain('qm agent "$VMID" ping');
    expect(String(runHost.mock.calls[0][0]).indexOf('qm agent "$VMID" ping'))
      .toBeLessThan(String(runHost.mock.calls[0][0]).indexOf("HIVRA_PREPARED_COMPUTER_READY"));
    expect(String(runHost.mock.calls[1][0])).toContain("hivra-bind-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "owner", computer_profile: "omarchy", vmid: 2099, status: "running" }));
    expect(markBindingEnforced).toHaveBeenCalledTimes(1);
    expect(row.id).toBe("44444444-4444-4444-8444-444444444444");
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
    const slot = readPreparedCanarySlot("windows")!;
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
});
