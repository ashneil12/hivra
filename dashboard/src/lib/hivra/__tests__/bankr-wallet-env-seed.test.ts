import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { buildVmidBoundGuestSshPrelude } from "@/lib/hivra/vmid-bound-guest-ssh";

import {
  buildBankrEnvFileContent,
  buildBankrEnvGuestScript,
  buildBankrEnvHostScript,
  buildBankrEnvRemoveGuestScript,
  removeBankrWalletEnvFromBox,
  seedBankrWalletEnvOntoBox,
  type BankrEnvGuestAuthority,
  type BankrEnvGuestTarget,
} from "../bankr-wallet-env-seed";

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  __esModule: true,
  runProxmoxHostScript: jest.fn(),
}));

const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;

// Placeholder, not a real Bankr key.
const cfg = {
  walletAddress: "0x000000000000000000000000000000000000ba5e",
  apiKey: "bk_agent_secret",
  walletId: "wlt_123",
  withdrawalDestination: null,
};

const BINDING_TAG = "hivra-bind-0123456789abcdef0123456789abcdef";
const OTHER_TAG = "hivra-bind-fedcba9876543210fedcba9876543210";
const AUTHORITY: BankrEnvGuestAuthority = {
  env: { PROXMOX_NODE: "fixturenode10" },
  infrastructureBindingTag: BINDING_TAG,
  infrastructureBindingTagEnforced: true,
  paths: { vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator" },
};
const BOX = { id: "a", type: "codex", ip: "10.250.20.42", vmid: 1100 };
const TARGET: BankrEnvGuestTarget = {
  vmid: 1100,
  ip: "10.250.20.42",
  bindingTag: BINDING_TAG,
  vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator",
};

describe("buildBankrEnvFileContent", () => {
  it("emits the primary key + every alias both lanes' skills read", () => {
    const content = buildBankrEnvFileContent(cfg);
    expect(content).toContain("BANKR_API_KEY=bk_agent_secret");
    expect(content).toContain("BANKR_AGENT_API_KEY=bk_agent_secret");
    expect(content).toContain("WALLET_ADDRESS=0x000000000000000000000000000000000000ba5e");
    expect(content).toContain("BANKR_WALLET_ADDRESS=");
    expect(content).toContain("BANKR_AGENT_WALLET_ID=wlt_123");
    expect(content).not.toContain("BANKR_AGENT_WITHDRAWAL_DESTINATION");
  });

  it("includes the withdrawal destination when set", () => {
    const content = buildBankrEnvFileContent({
      ...cfg,
      withdrawalDestination: "0x000000000000000000000000000000000000feed",
    });
    expect(content).toContain(
      "BANKR_AGENT_WITHDRAWAL_DESTINATION=0x000000000000000000000000000000000000feed"
    );
  });
});

describe("buildBankrEnvGuestScript", () => {
  const script = buildBankrEnvGuestScript("BANKR_API_KEY=secret'with'quotes\n");

  it("writes ~/.hivra/bankr.env with owner-only permissions", () => {
    expect(script).toContain('> "$BUX/.hivra/bankr.env"');
    expect(script).toContain("umask 077");
    expect(script).toContain('chmod 0600 "$BUX/.hivra/bankr.env"');
  });

  it("base64-wraps the credentials so no secret reaches the shell", () => {
    expect(script).not.toContain("secret'with'quotes");
    const b64 = Buffer.from("BANKR_API_KEY=secret'with'quotes\n", "utf8").toString("base64");
    expect(b64).not.toContain("'");
    expect(script).toContain(`printf '%s' '${b64}' | base64 -d`);
  });

  it("emits the success marker the caller greps for", () => {
    expect(script.trim().endsWith("echo HIVRA_BANKR_ENV_OK")).toBe(true);
  });
});

/**
 * Regression: the host script used to SSH to ubuntu@<stored ip> with
 * StrictHostKeyChecking=no, so after a guest IP collision a user's Bankr key
 * could be written into another tenant's VM. It now checks the VM's owner
 * binding tag and configured IP, then pins SSH to the host key QEMU Guest
 * Agent attests for that VMID.
 */
describe("buildBankrEnvHostScript", () => {
  const host = buildBankrEnvHostScript(TARGET, "echo hi");

  it("never trusts an unverified guest host key", () => {
    expect(host).not.toContain("StrictHostKeyChecking=no");
    expect(host).not.toContain("UserKnownHostsFile=/dev/null");
    expect(host).toContain(buildVmidBoundGuestSshPrelude());
  });

  it("checks the exact VM's binding tag and configured ip before attesting and connecting", () => {
    const tagCheck = host.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"');
    const ipCheck = host.indexOf('grep -Fxq "ip=$GUEST_IP/24"');
    const attest = host.indexOf("qm guest exec");
    const stream = host.indexOf('"${GUEST_SSH[@]}"');
    expect(host).toContain("VMID=1100");
    expect(host).toContain(`EXPECTED_BINDING_TAG='${BINDING_TAG}'`);
    expect(host).toContain("GUEST_IP='10.250.20.42'");
    expect(host).toContain("VM_KEY='/etc/hivra/keys/vm-orchestrator'");
    expect(tagCheck).toBeGreaterThan(0);
    expect(ipCheck).toBeGreaterThan(tagCheck);
    expect(attest).toBeGreaterThan(ipCheck);
    expect(stream).toBeGreaterThan(attest);
  });

  it("streams the base64-wrapped guest script over stdin, never as an argument", () => {
    const outer = Buffer.from("echo hi", "utf8").toString("base64");
    expect(host).toContain(`printf '%s' '${outer}' | "\${GUEST_SSH[@]}" 'base64 -d | sudo -n bash'`);
  });

  it("is valid bash", () => {
    expect(spawnSync("bash", ["-n"], { input: host, encoding: "utf8" }).status).toBe(0);
  });

  it.each([
    ["a missing vmid", { vmid: 0 }],
    ["a non-ipv4 guest ip", { ip: "10.250.20.42; reboot" }],
    ["a malformed binding tag", { bindingTag: "hivra-bind-x' ; reboot ; '" }],
    ["a relative key path", { vmSshKeyPath: "keys/vm" }],
  ])("refuses to build a script for %s", (_label, overrides) => {
    expect(() => buildBankrEnvHostScript({ ...TARGET, ...overrides }, "echo hi")).toThrow(
      "Invalid Hivra wallet env target"
    );
  });
});

/**
 * Runs the generated host script under bash with `qm` and `ssh` stubbed, so
 * the owner/IP checks and the pinned known_hosts are exercised, not just
 * pattern-matched. Only the /run identity dir and the python path are
 * redirected for the sandbox.
 */
describe("wallet env host script, executed against a stubbed Proxmox host", () => {
  const hostKey = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, 7),
  ]).toString("base64");
  let root: string;
  let capture: string;
  let target: BankrEnvGuestTarget;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bankr-env-host-"));
    capture = path.join(root, "capture");
    const bin = path.join(root, "bin");
    fs.mkdirSync(capture);
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, "run"));
    fs.writeFileSync(path.join(root, "vm-key"), "fixture key\n", { mode: 0o600 });
    fs.writeFileSync(
      path.join(bin, "qm"),
      `#!/bin/bash
case "$1" in
  status) echo "status: $QM_STATUS" ;;
  config) printf 'name: box\\ntags: %s\\nipconfig0: ip=%s/24,gw=10.250.20.1\\n' "$QM_TAGS" "$QM_IP" ;;
  guest) printf '{"exitcode":0,"exited":1,"out-data":"ssh-ed25519 %s root@box\\\\n"}' "$QM_HOSTKEY" ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(bin, "ssh"),
      `#!/bin/bash
printf '%s\\n' "$@" > "$CAPTURE/ssh-args"
for arg in "$@"; do
  case "$arg" in UserKnownHostsFile=*) cp "\${arg#UserKnownHostsFile=}" "$CAPTURE/known_hosts" ;; esac
done
cat > "$CAPTURE/ssh-stdin"
echo HIVRA_BANKR_ENV_OK
`,
      { mode: 0o755 }
    );
    target = { ...TARGET, vmSshKeyPath: path.join(root, "vm-key") };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(guestScript: string, vm: { status?: string; tags?: string; ip?: string } = {}) {
    const script = buildBankrEnvHostScript(target, guestScript)
      .replaceAll("/run/hivra-guest-ssh-identity.", `${root}/run/hivra-guest-ssh-identity.`)
      .replaceAll("/usr/bin/python3", "python3");
    return spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        CAPTURE: capture,
        QM_STATUS: vm.status ?? "running",
        QM_TAGS: vm.tags ?? `hivra;${BINDING_TAG}`,
        QM_IP: vm.ip ?? "10.250.20.42",
        QM_HOSTKEY: hostKey,
      },
    });
  }

  it("connects only with the QGA-attested host key and delivers the key file intact", () => {
    const content = buildBankrEnvFileContent(cfg);
    const result = run(buildBankrEnvGuestScript(content));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("HIVRA_BANKR_ENV_OK");
    const args = fs.readFileSync(path.join(capture, "ssh-args"), "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining([
      "StrictHostKeyChecking=yes",
      "HostKeyAlias=hivra-vmid-1100",
      "GlobalKnownHostsFile=/dev/null",
      "ubuntu@10.250.20.42",
      "base64 -d | sudo -n bash",
    ]));
    expect(args).not.toContain("StrictHostKeyChecking=no");
    expect(fs.readFileSync(path.join(capture, "known_hosts"), "utf8")).toBe(
      `hivra-vmid-1100 ssh-ed25519 ${hostKey}\n`
    );
    // The key never appears in any process argument, plain or encoded.
    const joinedArgs = args.join("\n");
    expect(joinedArgs).not.toContain(cfg.apiKey);
    expect(joinedArgs).not.toContain(Buffer.from(content).toString("base64"));
    // The guest receives the script over stdin; running it writes the file 0600.
    const guestScript = Buffer.from(fs.readFileSync(path.join(capture, "ssh-stdin"), "utf8"), "base64").toString("utf8");
    const bux = path.join(root, "bux");
    fs.mkdirSync(bux);
    const guest = spawnSync("bash", ["-s"], { input: guestScript.replace("BUX=/home/bux", `BUX=${bux}`), encoding: "utf8" });
    expect(guest.status).toBe(0);
    expect(fs.readFileSync(path.join(bux, ".hivra/bankr.env"), "utf8")).toBe(content);
    expect(fs.statSync(path.join(bux, ".hivra/bankr.env")).mode & 0o777).toBe(0o600);
    // The per-run identity dir is removed.
    expect(fs.readdirSync(path.join(root, "run"))).toEqual([]);
  });

  it.each([
    ["the VM at this VMID belongs to another owner", { tags: `hivra;${OTHER_TAG}` }, /owner binding tag/],
    ["the VM at this VMID has no tags", { tags: "" }, /owner binding tag/],
    ["the stored ip now belongs to a different VM", { ip: "10.250.20.99" }, /stored guest ip/],
    ["the VM is not running", { status: "stopped" }, /not running/],
  ])("sends nothing when %s", (_label, vm, stderr) => {
    const result = run(buildBankrEnvGuestScript(buildBankrEnvFileContent(cfg)), vm);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(stderr);
    expect(fs.existsSync(path.join(capture, "ssh-args"))).toBe(false);
    expect(fs.existsSync(path.join(capture, "ssh-stdin"))).toBe(false);
  });
});

describe("seedBankrWalletEnvOntoBox", () => {
  beforeEach(() => mockedRunScript.mockReset());

  it("skips non-CLI agent types without touching SSH", async () => {
    const res = await seedBankrWalletEnvOntoBox({ ...BOX, type: "aeon", ip: "10.240.0.1" }, cfg, AUTHORITY);
    expect(res).toEqual({ ok: false, skipped: "unsupported_type" });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("rejects a missing box ip", async () => {
    const res = await seedBankrWalletEnvOntoBox({ ...BOX, ip: null }, cfg, AUTHORITY);
    expect(res.ok).toBe(false);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("runs the pinned host script with the agent's own host connection", async () => {
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "HIVRA_BANKR_ENV_OK\n", stderr: "" });
    const res = await seedBankrWalletEnvOntoBox({ ...BOX, type: "claude-code" }, cfg, AUTHORITY);

    expect(res).toEqual({ ok: true });
    expect(mockedRunScript).toHaveBeenCalledTimes(1);
    const [script, env] = mockedRunScript.mock.calls[0];
    expect(env).toBe(AUTHORITY.env);
    expect(script).toBe(
      buildBankrEnvHostScript(TARGET, buildBankrEnvGuestScript(buildBankrEnvFileContent(cfg)))
    );
  });

  it("reports failure when the marker is absent", async () => {
    mockedRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: "boom", error: "ssh failed" });
    const res = await seedBankrWalletEnvOntoBox(BOX, cfg, AUTHORITY);
    expect(res).toEqual({ ok: false, error: "wallet key write failed: ssh failed" });
  });

  it.each([
    ["no vmid", { ...BOX, vmid: null }, AUTHORITY, "missing or invalid vmid"],
    ["an unenforced owner binding", BOX, { ...AUTHORITY, infrastructureBindingTagEnforced: false }, "no enforced owner binding tag"],
    ["no binding tag", BOX, { ...AUTHORITY, infrastructureBindingTag: "" }, "no enforced owner binding tag"],
    ["no pinned guest key", BOX, { ...AUTHORITY, paths: { vmSshKeyPath: null } }, "no pinned guest SSH key"],
    ["a malformed ip", { ...BOX, ip: "10.250.20" }, AUTHORITY, "missing or invalid box ip"],
  ])("fails closed with %s and never sends the key", async (_label, agent, authority, reason) => {
    const res = await seedBankrWalletEnvOntoBox(agent, cfg, authority);

    expect(res).toEqual({
      ok: false,
      reason: "identity_unverifiable",
      error: `wallet key write failed: this box's identity can't be verified (${reason}), so nothing was sent to it`,
    });
    expect(res.error).not.toContain(cfg.apiKey);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });
});

describe("removeBankrWalletEnvFromBox", () => {
  beforeEach(() => mockedRunScript.mockReset());

  it("deletes the env file, verifies it is gone and carries no key material", () => {
    const script = buildBankrEnvRemoveGuestScript();
    expect(script).toContain('rm -f "$BUX/.hivra/bankr.env"');
    expect(script).toContain('[ ! -e "$BUX/.hivra/bankr.env" ]');
    expect(script.trim().endsWith("echo HIVRA_BANKR_ENV_REMOVED")).toBe(true);
    expect(script).not.toContain("BANKR_API_KEY");
  });

  it("returns ok only when the box reports the removal marker", async () => {
    mockedRunScript.mockResolvedValueOnce({ ok: true, stdout: "HIVRA_BANKR_ENV_REMOVED\n", stderr: "" });
    await expect(removeBankrWalletEnvFromBox(BOX, AUTHORITY)).resolves.toEqual({ ok: true });
    expect(mockedRunScript.mock.calls[0][0]).toBe(buildBankrEnvHostScript(TARGET, buildBankrEnvRemoveGuestScript()));

    mockedRunScript.mockResolvedValueOnce({ ok: true, stdout: "HIVRA_BANKR_ENV_OK\n", stderr: "" });
    await expect(removeBankrWalletEnvFromBox(BOX, AUTHORITY)).resolves.toEqual({
      ok: false,
      error: "wallet key file removal failed, so it may still be on the box: env script failed",
    });
  });

  it("fails closed on an unpinnable box and says the file may still be there", async () => {
    await expect(removeBankrWalletEnvFromBox({ ...BOX, vmid: null }, AUTHORITY)).resolves.toEqual({
      ok: false,
      reason: "identity_unverifiable",
      error:
        "wallet key file removal failed, so it may still be on the box: this box's identity can't be verified (missing or invalid vmid), so nothing was sent to it",
    });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("skips non-CLI agent types without touching SSH", async () => {
    await expect(removeBankrWalletEnvFromBox({ ...BOX, type: "aeon", ip: "10.240.0.1" }, AUTHORITY)).resolves.toEqual({
      ok: false,
      skipped: "unsupported_type",
    });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });
});
