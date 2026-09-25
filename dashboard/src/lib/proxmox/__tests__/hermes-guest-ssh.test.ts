/** @jest-environment node */

import { spawnSync } from "node:child_process";

import { buildVmidBoundGuestSshPrelude } from "@/lib/hivra/vmid-bound-guest-ssh";

import { GENUINE_GUEST_HOST_KEY, createStubProxmoxGuestHost } from "@/test-utils/stub-proxmox-guest-host";

import {
  GUEST_SSH_REFUSED_MARKER,
  buildEnsureQemuGuestAgentChannelScript,
  buildHermesVmidBoundGuestSshPrelude,
  buildPinnedGuestSshReadinessWait,
} from "../hermes-guest-ssh";

const bashSyntax = (script: string) => spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

describe("Hermes VMID-bound guest SSH prelude", () => {
  it("reuses the Hivra lane's QGA-attested host-key pin for the Hermes login user", () => {
    const prelude = buildHermesVmidBoundGuestSshPrelude({ sshUser: "hermes", quiet: true });

    expect(prelude).toContain(buildVmidBoundGuestSshPrelude({ sshUser: "hermes", quiet: true }));
    expect(prelude).toContain('"hermes@$GUEST_IP"');
    expect(prelude).toContain("StrictHostKeyChecking=yes");
    expect(prelude).not.toContain("accept-new");
    expect(prelude).not.toContain("StrictHostKeyChecking=no");
    expect(bashSyntax(prelude)).toMatchObject({ status: 0, stderr: "" });
  });

  it("checks the VM's configured ip and guest agent before attesting the key", () => {
    const prelude = buildHermesVmidBoundGuestSshPrelude({ sshUser: "hermes", agentAttempts: 5 });
    const ipCheck = prelude.indexOf('[ "$hermes_guest_configured_ip" = "$PRIVATE_IP" ]');
    const agentCheck = prelude.indexOf('case ",$hermes_guest_agent," in');
    const agentWait = prelude.indexOf("HERMES_GUEST_AGENT_ATTEMPTS=5");
    const attest = prelude.indexOf("qm guest exec");

    expect(ipCheck).toBeGreaterThan(0);
    expect(agentCheck).toBeGreaterThan(ipCheck);
    expect(agentWait).toBeGreaterThan(agentCheck);
    expect(attest).toBeGreaterThan(agentWait);
    expect(bashSyntax(prelude).status).toBe(0);
  });

  it("names every refusal with one marker", () => {
    expect(buildHermesVmidBoundGuestSshPrelude({ sshUser: "hermes" })).toContain(`printf '${GUEST_SSH_REFUSED_MARKER} %s; nothing was sent to the guest`);
  });

  it.each([
    ["an ssh user that names another host", { sshUser: "hermes@10.250.20.9" }],
    ["an ssh user that injects an option", { sshUser: "-oProxyCommand=x" }],
    ["an ssh user with shell syntax", { sshUser: "hermes'; reboot; '" }],
    ["a negative agent wait", { sshUser: "hermes", agentAttempts: -1 }],
    ["a fractional connect timeout", { sshUser: "hermes", connectTimeoutSeconds: 2.5 }],
  ])("refuses to build a prelude for %s", (_label, options) => {
    expect(() => buildHermesVmidBoundGuestSshPrelude(options)).toThrow(/Invalid/);
  });
});

describe("pinned guest SSH readiness wait", () => {
  it("stops at once on a host key mismatch instead of retrying it as a boot race", () => {
    const wait = buildPinnedGuestSshReadinessWait({ attempts: 3, sleepSeconds: 5 });
    const mismatch = wait.indexOf("Host key verification failed");
    const sleep = wait.indexOf("then sleep 5");

    expect(wait).toContain('"${GUEST_SSH[@]}" "sudo -n true" </dev/null');
    expect(mismatch).toBeGreaterThan(0);
    expect(sleep).toBeGreaterThan(mismatch);
    expect(wait).toContain('echo "VM $VMID is not reachable over SSH at $PRIVATE_IP" >&2');
    expect(bashSyntax(wait).status).toBe(0);
  });

  it.each([
    [{ attempts: 0, sleepSeconds: 5 }],
    [{ attempts: 3, sleepSeconds: 0 }],
  ])("rejects an unbounded or empty wait %p", (params) => {
    expect(() => buildPinnedGuestSshReadinessWait(params)).toThrow(/Invalid/);
  });
});

describe("QEMU Guest Agent channel for a fresh clone", () => {
  const host = createStubProxmoxGuestHost();
  afterAll(() => host.cleanup());

  const qmSetFor = (agent: string | null) =>
    host.run(`set -euo pipefail\nVMID=201\n${buildEnsureQemuGuestAgentChannelScript()}\n`, {
      vms: [{ vmid: 201, ip: "10.250.20.51", status: "stopped", agent }],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });

  it.each([
    ["no agent line", null, ["set 201 --agent enabled=1"]],
    ["a disabled agent", "0", ["set 201 --agent enabled=1"]],
    ["a disabled agent with other options", "0,fstrim_cloned_disks=1,type=virtio", ["set 201 --agent enabled=1,fstrim_cloned_disks=1,type=virtio"]],
    ["a keyed disabled agent", "enabled=off,freeze-fs-on-backup=0", ["set 201 --agent enabled=1,freeze-fs-on-backup=0"]],
    ["an enabled agent", "1", []],
    ["a keyed enabled agent with options", "enabled=1,fstrim_cloned_disks=1", []],
  ])("enables the channel only when it is off, keeping other options: %s", (_label, agent, expected) => {
    const result = qmSetFor(agent);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.qmCalls).toEqual(expected);
  });
});
