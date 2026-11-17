import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowedSitesEnabled, applyOutcome, buildAllowedSitesHostScript, buildEgressPolicy, normalizeSites,
  parseEgressReceipt, parseSite, requiredSites,
} from "../allowed-sites";

const TAG = `hivra-bind-${"a".repeat(32)}`;

describe("allowedSitesEnabled", () => {
  it("is on only when the switch is exactly true", () => {
    expect(allowedSitesEnabled({})).toBe(false);
    expect(allowedSitesEnabled({ NEXT_PUBLIC_HIVRA_ALLOWED_SITES: "1" })).toBe(false);
    expect(allowedSitesEnabled({ NEXT_PUBLIC_HIVRA_ALLOWED_SITES: "true" })).toBe(true);
  });
});

describe("parseSite", () => {
  it.each([
    ["GitHub.com", "github.com"],
    ["https://api.openai.com/v1/chat", "api.openai.com"],
    ["github.com/owner/repo", "github.com"],
    ["example.com.", "example.com"],
    ["8.8.8.8", "8.8.8.8"],
    ["198.41.192.0/24", "198.41.192.0/24"],
  ])("accepts %s as %s", (input, site) => {
    expect(parseSite(input)).toEqual({ ok: true, site });
  });

  it.each([
    ["*.example.com", "wildcards"],
    ["10.0.0.1", "private"],
    ["192.168.1.0/24", "private"],
    ["1.2.3.0/4", "range"],
    ["localhost", "site address"],
    ["not a host", "site address"],
    ["ftp://", "web address"],
  ])("refuses %s", (input, reason) => {
    const parsed = parseSite(input);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toContain(reason);
  });
});

describe("normalizeSites", () => {
  it("drops blanks and repeats, and lists what it refused", () => {
    expect(normalizeSites(["github.com", " ", "GITHUB.COM", "*.x.com", "pypi.org"])).toEqual({
      sites: ["github.com", "pypi.org"],
      rejected: [{ input: "*.x.com", reason: "wildcards aren't supported; list each address" }],
    });
  });
});

describe("requiredSites", () => {
  it("always keeps this deployment, Cloudflare Tunnel and any extras reachable", () => {
    expect(requiredSites({ NEXT_PUBLIC_APP_URL: "https://canary.example.cloud", HIVRA_EGRESS_REQUIRED_EXTRA: "pypi.org, 10.0.0.1 ,files.pythonhosted.org" }))
      .toEqual(["canary.example.cloud", "198.41.192.0/24", "198.41.200.0/24", "pypi.org", "files.pythonhosted.org"]);
  });

  it("goes into every policy", () => {
    expect(buildEgressPolicy({ vmid: 2104, bindingTag: TAG, sites: ["github.com"], env: { NEXT_PUBLIC_APP_URL: "https://hivra.example" } })).toEqual({
      version: 1, vmid: 2104, binding_tag: TAG, sites: ["github.com"], required: ["hivra.example", "198.41.192.0/24", "198.41.200.0/24"],
    });
  });
});

describe("buildAllowedSitesHostScript", () => {
  it("refuses values it would put into shell", () => {
    expect(() => buildAllowedSitesHostScript({ vmid: 1, bindingTag: TAG, mode: "set" })).toThrow();
    expect(() => buildAllowedSitesHostScript({ vmid: 2104, bindingTag: "hivra-bind-x;rm", mode: "set" })).toThrow();
    expect(() => buildAllowedSitesHostScript({ vmid: 2104, bindingTag: TAG, mode: "drop" as "set" })).toThrow();
  });

  /** Runs the script against a fake qm whose config holds `tags`. */
  function run(mode: "set" | "remove", tags: string, options: { enforcer?: "ok" | "fail" | "missing"; stdin?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "egress-push-"));
    const policyDir = join(dir, "egress");
    const enforcer = join(dir, "hivra-vm-egress");
    writeFileSync(join(dir, "qm"), `#!/bin/bash\necho "name: x"\necho "tags: ${tags}"\n`);
    chmodSync(join(dir, "qm"), 0o755);
    if ((options.enforcer ?? "ok") !== "missing") {
      writeFileSync(enforcer, `#!/bin/bash\necho "$@" > "${dir}/enforcer-args"\nexit ${options.enforcer === "fail" ? 1 : 0}\n`);
      chmodSync(enforcer, 0o755);
    }
    const script = buildAllowedSitesHostScript({ vmid: 2104, bindingTag: TAG, mode, paths: { policyDir, enforcer } });
    const stdout = execFileSync("bash", ["-c", script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }, encoding: "utf8", input: options.stdin ?? '{"version":1}',
    });
    return { dir, policyDir, stdout, receipt: parseEgressReceipt(stdout, 2104) };
  }

  it("writes the policy and applies it when the VM carries the binding tag", () => {
    const r = run("set", `other;${TAG}`);
    expect(r.receipt).toEqual({ ok: true, vmid: 2104, reason: "applied" });
    expect(readFileSync(join(r.policyDir, "2104.json"), "utf8")).toBe('{"version":1}\n');
    expect(readFileSync(join(r.dir, "enforcer-args"), "utf8").trim()).toBe("--apply --quiet");
  });

  it("changes nothing on a VM with another binding tag", () => {
    const r = run("set", `hivra-bind-${"b".repeat(32)}`);
    expect(r.receipt).toEqual({ ok: false, vmid: 2104, reason: "binding_mismatch" });
    expect(existsSync(join(r.policyDir, "2104.json"))).toBe(false);
  });

  it("keeps the file for later when the host has no enforcer yet", () => {
    const r = run("set", TAG, { enforcer: "missing" });
    expect(r.receipt?.reason).toBe("saved_not_enforced");
    expect(existsSync(join(r.policyDir, "2104.json"))).toBe(true);
  });

  it("removes the policy when the owner turns the limit off", () => {
    const r = run("remove", TAG, { stdin: "" });
    expect(r.receipt?.reason).toBe("applied");
    expect(existsSync(join(r.policyDir, "2104.json"))).toBe(false);
  });

  it("reports a failed apply", () => {
    expect(run("set", TAG, { enforcer: "fail" }).receipt).toEqual({ ok: false, vmid: 2104, reason: "apply_failed" });
  });
});

describe("parseEgressReceipt and applyOutcome", () => {
  it("takes exactly one well-formed line for the right VM", () => {
    expect(parseEgressReceipt('HIVRA_EGRESS_RESULT {"ok":true,"vmid":7,"reason":"applied"}', 8)).toBeNull();
    expect(parseEgressReceipt("noise", 7)).toBeNull();
    expect(parseEgressReceipt('HIVRA_EGRESS_RESULT {"ok":true,"vmid":7,"reason":"applied"}\nHIVRA_EGRESS_RESULT {"ok":true,"vmid":7,"reason":"applied"}', 7)).toBeNull();
  });

  it("tells the owner what happened", () => {
    expect(applyOutcome({ ok: true, vmid: 7, reason: "applied" })).toEqual({ state: "applied", error: null });
    expect(applyOutcome({ ok: true, vmid: 7, reason: "saved_not_enforced" }).state).toBe("saved");
    expect(applyOutcome({ ok: false, vmid: 7, reason: "binding_mismatch" }).state).toBe("failed");
    expect(applyOutcome(null).state).toBe("failed");
  });
});
