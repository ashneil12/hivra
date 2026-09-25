/** @jest-environment node */

import { spawnSync } from "node:child_process";

import { buildVmidBoundGuestSshPrelude } from "../vmid-bound-guest-ssh";

describe("VMID-bound guest SSH", () => {
  it("derives an exact Ed25519 host key through QEMU Guest Agent and disables TOFU", () => {
    const prelude = buildVmidBoundGuestSshPrelude();
    expect(prelude).toContain('qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub');
    expect(prelude).toContain("StrictHostKeyChecking=yes");
    expect(prelude).toContain("HostKeyAlgorithms=ssh-ed25519");
    expect(prelude).toContain('HostKeyAlias="$GUEST_SSH_HOST_ALIAS"');
    expect(prelude).toContain('UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS"');
    expect(prelude).not.toContain("StrictHostKeyChecking=no");
    expect(prelude).not.toContain("StrictHostKeyChecking=accept-new");

    const syntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: prelude });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("accepts only a successful, structurally exact VMID-attested Ed25519 key", () => {
    const prelude = buildVmidBoundGuestSshPrelude();
    const parser = prelude.match(/\/usr\/bin\/python3 -c '\n([\s\S]+?)\n'\)"/)?.[1];
    expect(parser).toBeTruthy();

    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519", "ascii"),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 7),
    ]).toString("base64");
    const valid = spawnSync("/usr/bin/python3", ["-c", parser!], {
      encoding: "utf8",
      input: JSON.stringify({ exited: 1, exitcode: 0, "out-data": `ssh-ed25519 ${blob} guest\n` }),
    });
    expect(valid).toMatchObject({ status: 0, stdout: `ssh-ed25519 ${blob}\n`, stderr: "" });

    for (const document of [
      { exited: 1, exitcode: 1, "out-data": `ssh-ed25519 ${blob}\n` },
      { exited: 1, exitcode: 0, "out-data": `ssh-rsa ${blob}\n` },
      { exited: 1, exitcode: 0, "out-data": "ssh-ed25519 not-base64\n" },
      { exited: 1, exitcode: 0, "out-data": `ssh-ed25519 ${Buffer.alloc(32).toString("base64")}\n` },
    ]) {
      const refused = spawnSync("/usr/bin/python3", ["-c", parser!], {
        encoding: "utf8",
        input: JSON.stringify(document),
      });
      expect(refused.status).not.toBe(0);
    }
  });

  it("keeps the Hivra lane's ubuntu login by default and takes a validated login user, timeout and quiet mode", () => {
    expect(buildVmidBoundGuestSshPrelude()).toContain('-o ConnectTimeout=10 "ubuntu@$GUEST_IP")');
    const hermes = buildVmidBoundGuestSshPrelude({ sshUser: "hermes", connectTimeoutSeconds: 5, quiet: true });
    expect(hermes).toContain('-o ConnectTimeout=5 -o LogLevel=ERROR "hermes@$GUEST_IP")');
    expect(() => buildVmidBoundGuestSshPrelude({ sshUser: "root@10.250.20.9" })).toThrow("Invalid guest SSH user");
    expect(() => buildVmidBoundGuestSshPrelude({ connectTimeoutSeconds: 0 })).toThrow("Invalid guest SSH connect timeout");
  });

  it("names the reason and exits before any connection when the key can't be attested", () => {
    const prelude = buildVmidBoundGuestSshPrelude();
    expect(prelude).toContain("VMID-bound SSH refused: VM %s SSH host key could not be read through QEMU Guest Agent; nothing was sent to the guest");
    expect(prelude).toContain("VMID-bound SSH refused: VM %s did not attest a valid Ed25519 SSH host key; nothing was sent to the guest");
    expect(prelude.indexOf("did not attest a valid Ed25519 SSH host key")).toBeLessThan(prelude.indexOf("GUEST_SSH=("));
  });
});
