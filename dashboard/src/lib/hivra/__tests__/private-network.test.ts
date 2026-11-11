/** @jest-environment node */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildOutboundBlockInstallScript,
  buildOutboundBlockRemoveScript,
  buildOutboundBlockRules,
  buildPrivateNetworkPolicy,
  buildTailscaleVersionFloorScript,
  extractPrivateAccessFailureCode,
  isPrivateNetworkV2Enabled,
  meetsMinimumVersion,
  NETBIRD_INTERFACE,
  normalizeNetbirdManagementUrl,
  parseClientVersion,
  privateAccessFailureMessage,
  TAILSCALE_MIN_VERSION,
} from "../private-network";

describe("version floor", () => {
  it("keeps the floor in one constant", () => {
    expect(TAILSCALE_MIN_VERSION).toBe("1.104.4");
  });

  it.each([
    ["1.104.4", true], ["1.104.6", true], ["1.105.0-t1a2b3c", true], ["2.0.0", true],
    ["1.104.3", false], ["1.99.9", false], ["1.104", false], ["", false], ["garbage", false],
  ])("meetsMinimumVersion(%j) is %s", (version, expected) => {
    expect(meetsMinimumVersion(version)).toBe(expected);
  });

  it("reads the first line of `tailscale version`", () => {
    expect(parseClientVersion("1.104.6\n  tailscale commit: abc\n  go version: go1.25\n")).toBe("1.104.6");
    expect(parseClientVersion("not a version")).toBeNull();
  });

  function runFloor(version: string, upgradeTo?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivra-floor-"));
    const stub = (v: string) => `#!/bin/sh\nprintf '%s\\n' '${v}' 'commit: x'\n`;
    try {
      fs.writeFileSync(path.join(dir, "tailscale"), stub(version), { mode: 0o755 });
      // A stand-in apt-get: records its arguments, and "upgrades" tailscale when asked to.
      const upgrade = upgradeTo ? `cp '${dir}/tailscale.new' '${dir}/tailscale'\n` : "";
      if (upgradeTo) fs.writeFileSync(path.join(dir, "tailscale.new"), stub(upgradeTo), { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "apt-get"), `#!/bin/sh\necho "$@" >> '${dir}/apt.log'\n${upgrade}`, { mode: 0o755 });
      const result = spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${buildTailscaleVersionFloorScript()}\necho JOINED`],
        { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv });
      const aptLog = fs.existsSync(path.join(dir, "apt.log")) ? fs.readFileSync(path.join(dir, "apt.log"), "utf8") : "";
      return Object.assign(result, { aptLog });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it("tries one upgrade below the floor and joins if that fixes it", () => {
    const result = runFloor("1.100.0", "1.104.6");
    expect(result.aptLog).toContain("install -y --only-upgrade tailscale");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("JOINED");
  });

  it("still refuses when the upgrade does not help, and does not try to upgrade a current client", () => {
    const stuck = runFloor("1.100.0");
    expect(stuck.aptLog).toContain("--only-upgrade");
    expect(extractPrivateAccessFailureCode(stuck.stdout)).toBe("client_too_old");
    expect(runFloor("1.104.6").aptLog).toBe("");
  });

  it.each(["1.104.4", "1.104.6", "1.110.0-t1234"])("lets %s continue", version => {
    const result = runFloor(version);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("JOINED");
  });

  it.each(["1.104.3", "1.90.0", "0.99.1"])("refuses %s with client_too_old", version => {
    const result = runFloor(version);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("JOINED");
    expect(extractPrivateAccessFailureCode(result.stdout)).toBe("client_too_old");
  });

  it("refuses an unreadable version", () => {
    const result = runFloor("weird");
    expect(result.status).toBe(1);
    expect(extractPrivateAccessFailureCode(result.stdout)).toBe("client_version_unreadable");
  });

  it("says why in plain words", () => {
    expect(privateAccessFailureMessage("client_too_old")).toContain("1.104.4");
    expect(privateAccessFailureMessage("nope")).toBeNull();
  });
});

describe("outbound block", () => {
  const rules = buildOutboundBlockRules();

  it("uses its own table, answers replies and drops everything else leaving the private interface", () => {
    expect(rules).toContain("table inet hivra_private_access {");
    expect(rules).toContain("type filter hook output priority 0; policy accept;");
    expect(rules).toContain('oifname "tailscale0" ct state established,related accept');
    expect(rules).toContain('oifname "tailscale0" drop');
    // Only an output chain: inbound connections are untouched.
    expect(rules).not.toMatch(/hook (input|forward)/);
    // Nothing that is not the private interface is matched, so normal internet is untouched.
    expect(rules.match(/oifname "([a-z0-9]+)"/g)?.every(line => line === 'oifname "tailscale0"')).toBe(true);
    expect(rules.indexOf("established,related accept")).toBeLessThan(rules.indexOf('oifname "tailscale0" drop'));
  });

  it("can target NetBird's interface and refuses odd interface names", () => {
    expect(buildOutboundBlockRules(NETBIRD_INTERFACE)).toContain('oifname "wt0" drop');
    expect(() => buildOutboundBlockRules('x"; flush ruleset; "')).toThrow();
  });

  it("persists across reboot with a systemd unit and fails closed", () => {
    const script = buildOutboundBlockInstallScript();
    expect(script).toContain("/etc/hivra/private-access.nft");
    expect(script).toContain("hivra-private-access-block.service");
    expect(script).toContain("WantedBy=multi-user.target");
    expect(script).toContain("RemainAfterExit=yes");
    expect(script).toContain("systemctl enable hivra-private-access-block.service");
    expect(script).toContain("HIVRA_PRIVATE_ACCESS_FAILURE outbound_block_failed");
    expect(script).not.toMatch(/flush ruleset/);
  });

  it("loads after nftables.service and is required by the client's service, with no useless Wants", () => {
    const script = buildOutboundBlockInstallScript();
    expect(script).toContain("After=nftables.service");
    expect(script).not.toContain("Wants=network-pre.target");
    expect(script).not.toContain("Before=network-pre.target");
    expect(script).toContain("/etc/systemd/system/tailscaled.service.d/hivra-private-access.conf");
    expect(script).toMatch(/Requires=hivra-private-access-block\.service\nAfter=hivra-private-access-block\.service/);
    // start, never restart: a restart would restart the client that requires the unit.
    expect(script).toContain("systemctl start hivra-private-access-block.service");
    expect(script).not.toContain("systemctl restart hivra-private-access-block.service");
    expect(buildOutboundBlockInstallScript(NETBIRD_INTERFACE)).toContain("/etc/systemd/system/netbird.service.d/hivra-private-access.conf");
  });

  it("gives an apt failure its own code", () => {
    expect(buildOutboundBlockInstallScript()).toContain("HIVRA_PRIVATE_ACCESS_FAILURE apt_failed");
  });

  it("removes both drop-ins on disconnect", () => {
    const script = buildOutboundBlockRemoveScript();
    expect(script).toContain("/etc/systemd/system/tailscaled.service.d/hivra-private-access.conf");
    expect(script).toContain("/etc/systemd/system/netbird.service.d/hivra-private-access.conf");
  });

  it("is valid shell and the heredocs close", () => {
    for (const script of [buildOutboundBlockInstallScript(), buildOutboundBlockInstallScript(NETBIRD_INTERFACE),
      buildOutboundBlockRemoveScript()]) {
      const result = spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  it("removes the table, unit and rules file on disconnect, and tolerates their absence", () => {
    const script = buildOutboundBlockRemoveScript();
    expect(script).toContain("nft delete table inet hivra_private_access");
    expect(script).toContain("rm -f /etc/systemd/system/hivra-private-access-block.service /etc/hivra/private-access.nft");
    expect(script).toContain("|| true");
  });
});

describe("ready-made policy", () => {
  function parse(text: string) {
    const stripped = text.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
    return JSON.parse(stripped);
  }

  it("lets the owner's devices reach tag:hivra on 22 only, and tag:hivra reach nothing", () => {
    const policy = parse(buildPrivateNetworkPolicy("tailscale"));
    expect(policy.tagOwners["tag:hivra"]).toEqual(["autogroup:admin"]);
    expect(policy.acls).toEqual([{ action: "accept", src: ["autogroup:member"], dst: ["tag:hivra:22"] }]);
    expect(policy.acls.some((rule: { src: string[] }) => rule.src.includes("tag:hivra"))).toBe(false);
    expect(policy.tests).toEqual(expect.arrayContaining([
      { src: "REPLACE-ME@example.com", accept: ["tag:hivra:22"] },
      expect.objectContaining({ src: "tag:hivra", deny: expect.arrayContaining(["tag:hivra:22"]) }),
    ]));
    const denied = policy.tests.find((entry: { src: string }) => entry.src === "tag:hivra").deny as string[];
    expect(denied.some(target => /^\d+\.\d+\.\d+\.\d+:22$/.test(target))).toBe(true);
  });

  it("uses a Headscale user in place of autogroup:member", () => {
    const text = buildPrivateNetworkPolicy("headscale");
    expect(text).not.toContain("autogroup");
    expect(text).toContain("Headscale user");
    expect(parse(text).acls[0].src).toEqual(["REPLACE-ME@"]);
  });

  it("tells people to merge, and makes the placeholder login unmistakable", () => {
    for (const kind of ["tailscale", "headscale"] as const) {
      const text = buildPrivateNetworkPolicy(kind);
      expect(text).toContain("MERGE these entries into your existing policy file");
      expect(text).toContain("REPLACE-ME@");
      expect(text).not.toContain("you@");
    }
  });

  it("never mentions SSH features, Funnel, exit nodes or routes", () => {
    expect(buildPrivateNetworkPolicy("tailscale")).not.toMatch(/ssh"|funnel|exit|nodeAttrs|autoApprovers/i);
  });
});

describe("NetBird address and flag", () => {
  it("accepts https origins only and defaults to NetBird's cloud", () => {
    expect(normalizeNetbirdManagementUrl("")).toBe("https://api.netbird.io");
    expect(normalizeNetbirdManagementUrl("https://netbird.example.test:33073/")).toBe("https://netbird.example.test:33073");
    expect(normalizeNetbirdManagementUrl("http://netbird.example.test")).toBeNull();
    expect(normalizeNetbirdManagementUrl("https://u:p@netbird.example.test")).toBeNull();
    expect(normalizeNetbirdManagementUrl("https://netbird.example.test/x?y#z")).toBeNull();
  });

  it("is off unless the flag is exactly 1", () => {
    const previous = process.env.NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2;
    try {
      delete process.env.NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2;
      expect(isPrivateNetworkV2Enabled()).toBe(false);
      process.env.NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2 = "1";
      expect(isPrivateNetworkV2Enabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2;
      else process.env.NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2 = previous;
    }
  });
});
