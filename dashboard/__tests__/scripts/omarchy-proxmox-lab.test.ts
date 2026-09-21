import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  OMARCHY_PROXMOX_LAB,
  assertOmarchyLabTargetAuthorized,
  buildOmarchyFullDiskConfiguration,
  buildOmarchyLabLaunchScript,
  buildOmarchyLabTeardownScript,
  parseArgs,
  readAndValidateOmarchyCidata,
} from "../../scripts/omarchy-proxmox-lab";

function fixture(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "omarchy-cidata-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  }
  return directory;
}

function executable(filename: string, content: string): void {
  writeFileSync(filename, content, { mode: 0o755 });
}

const params = {
  vmid: 2099,
  name: "hivra-omarchy-lab",
  operationId: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
  expectedHostname: "canary-pve",
  vmStorage: "local-lvm",
  isoStorage: "local",
  bridge: "vmbr0",
  cpu: 4,
  memoryMb: 8192,
  diskGb: 40,
};

const passwordHash = `$6$hivrafixture$${"A".repeat(86)}`;

function officialConfiguration(deferProvisioning: boolean, extra: Record<string, unknown> = {}): string {
  const configuration = JSON.parse(buildOmarchyFullDiskConfiguration({
    deferProvisioning,
    diskDevice: "/dev/sda",
    diskGb: 40,
  })) as Record<string, unknown>;
  return JSON.stringify({ ...configuration, ...extra });
}

function officialCredentials(): string {
  return JSON.stringify({
    root_enc_password: passwordHash,
    users: [{ enc_password: passwordHash, groups: [], sudo: true, username: "tester" }],
  });
}

describe("Omarchy Proxmox lab", () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it("pins the official release artifact and minimum KVM shape", () => {
    expect(OMARCHY_PROXMOX_LAB).toMatchObject({
      release: "v4.0.2",
      releaseCommit: "346e69e1cec6c4e8924531874af6ba010a1bc99e",
      isoSha256: "2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8",
      minimums: { cpu: 4, memoryMb: 8192, diskGb: 40 },
      machine: "q35",
      firmware: "ovmf",
    });
  });

  it("derives the complete v4.0.2 full-disk contract for a disposable KVM", () => {
    const configuration = JSON.parse(buildOmarchyFullDiskConfiguration({
      deferProvisioning: true,
      diskDevice: "/dev/sda",
      diskGb: 40,
      hostname: "omarchy",
    })) as {
      omarchy_install: Record<string, unknown>;
      disk_config: { device_modifications: Array<{ device: string; wipe: boolean; partitions: Array<{ size: { value: number } }> }> };
      packages: string[];
      services: string[];
    };
    expect(configuration.omarchy_install).toMatchObject({
      mode: "full_disk",
      defer_provisioning: true,
      target_mount: "/mnt",
      storage: { kernel: "linux" },
    });
    expect(configuration.disk_config.device_modifications[0]).toMatchObject({ device: "/dev/sda", wipe: true });
    expect(configuration.disk_config.device_modifications[0].partitions).toHaveLength(2);
    expect(configuration.disk_config.device_modifications[0].partitions[0].size.value).toBe(2 * 1024 ** 3);
    expect(configuration.disk_config.device_modifications[0].partitions[1].size.value).toBe(40 * 1024 ** 3 - 2 * 1024 ** 3 - 2 * 1024 ** 2);
    expect(configuration.packages).toEqual(expect.arrayContaining(["omarchy-keyring", "omarchy-settings", "omarchy"]));
    expect(configuration.packages).toContain("qemu-guest-agent");
    expect(configuration.services).toContain("qemu-guest-agent");
  });

  it("prepares the pinned Sunshine unit without opening an implicit network route", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omarchy-sunshine-test-"));
    directories.push(root);
    const fakeBin = path.join(root, "bin");
    const unitDirectory = path.join(root, "units");
    const commandLog = path.join(root, "commands.log");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(path.join(unitDirectory, "app-dev.lizardbyte.app.Sunshine.service"), "fixture\n");
    executable(path.join(fakeBin, "id"), "#!/bin/sh\nprintf '%s\\n' 1000\n");
    executable(path.join(fakeBin, "pacman"), `#!/bin/sh
printf 'pacman %s\\n' "$*" >> "$HIVRA_TEST_COMMAND_LOG"
if [ "$1" = "-Q" ] && [ "$2" = "omarchy" ]; then printf '%s\\n' 'omarchy 4.0.2-1'; exit 0; fi
if [ "$1" = "-Q" ] && [ "$2" = "sunshine" ]; then printf '%s\\n' 'sunshine 2026.516.143833-4'; exit 0; fi
exit 0
`);
    executable(path.join(fakeBin, "systemctl"), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$HIVRA_TEST_COMMAND_LOG"
case "$*" in *is-enabled*) printf '%s\\n' enabled;; *is-active*) printf '%s\\n' active;; esac
`);
    executable(path.join(fakeBin, "journalctl"), "#!/bin/sh\nprintf '%s\\n' 'Info: Found H.264 encoder: libx264 [software]'\n");
    executable(path.join(fakeBin, "curl"), "#!/bin/sh\nprintf '%s' 307\n");
    executable(path.join(fakeBin, "sudo"), `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$HIVRA_TEST_COMMAND_LOG"
"$@"
`);
    executable(path.join(fakeBin, "ufw"), `#!/bin/sh
printf 'ufw %s\\n' "$*" >> "$HIVRA_TEST_COMMAND_LOG"
case "$*" in
  "status verbose") printf '%s\\n' 'Status: active' 'Default: deny (incoming), allow (outgoing), disabled (routed)' ;;
  "status numbered") printf '%s\\n' 'Status: active' ;;
esac
`);
    const script = path.join(process.cwd(), "scripts/prepare-omarchy-sunshine.sh");
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HIVRA_SYSTEMD_USER_UNIT_DIR: unitDirectory,
        HIVRA_TEST_COMMAND_LOG: commandLog,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("HIVRA_OMARCHY_SUNSHINE_READY"),
      stderr: "",
    });
    expect(result.stdout).toContain('"firewallCidrs":0');
    expect(readFileSync(commandLog, "utf8")).toContain("systemctl --user enable --now app-dev.lizardbyte.app.Sunshine.service");
    expect(readFileSync(commandLog, "utf8")).not.toContain("ufw allow");
  });

  it("refuses to start Sunshine when UFW is inactive", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omarchy-sunshine-inactive-"));
    directories.push(root);
    const fakeBin = path.join(root, "bin");
    const unitDirectory = path.join(root, "units");
    const commandLog = path.join(root, "commands.log");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(path.join(unitDirectory, "app-dev.lizardbyte.app.Sunshine.service"), "fixture\n");
    executable(path.join(fakeBin, "id"), "#!/bin/sh\nprintf '%s\\n' 1000\n");
    executable(path.join(fakeBin, "pacman"), `#!/bin/sh
if [ "$1" = "-Q" ] && [ "$2" = "omarchy" ]; then printf '%s\\n' 'omarchy 4.0.2-1'; exit 0; fi
if [ "$1" = "-Q" ] && [ "$2" = "sunshine" ]; then printf '%s\\n' 'sunshine 2026.516.143833-4'; exit 0; fi
exit 0
`);
    executable(path.join(fakeBin, "systemctl"), `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$HIVRA_TEST_COMMAND_LOG"
case "$*" in *is-enabled*) printf '%s\\n' disabled;; *is-active*) printf '%s\\n' inactive;; esac
`);
    executable(path.join(fakeBin, "sudo"), "#!/bin/sh\n\"$@\"\n");
    executable(path.join(fakeBin, "ufw"), "#!/bin/sh\nprintf '%s\\n' 'Status: inactive'\n");
    const script = path.join(process.cwd(), "scripts/prepare-omarchy-sunshine.sh");
    const result = spawnSync("bash", [script, "--allow-cidr", "203.0.113.10/32"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HIVRA_SYSTEMD_USER_UNIT_DIR: unitDirectory,
        HIVRA_TEST_COMMAND_LOG: commandLog,
      },
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toMatchObject({
      status: 6,
      stderr: expect.stringContaining("UFW must be active before Sunshine can start"),
    });
    expect(result.stdout).not.toContain("HIVRA_OMARCHY_SUNSHINE_READY");
    expect(existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "").not.toContain("enable --now");
  });

  it("binds the Sunshine start after exact firewall verification", () => {
    const sunshine = readFileSync(path.join(process.cwd(), "scripts/prepare-omarchy-sunshine.sh"), "utf8");
    expect(sunshine).toContain('grep -Fxq "Status: active"');
    expect(sunshine).toContain("verify_firewall_rules");
    expect(sunshine).toContain("Sunshine firewall verification failed");
    expect(sunshine.indexOf('firewall_rules_after="$(sudo ufw status numbered)"'))
      .toBeLessThan(sunshine.indexOf('systemctl --user enable --now "$SUNSHINE_UNIT"'));
    expect(sunshine.indexOf('systemctl --user enable --now "$SUNSHINE_UNIT"'))
      .toBeLessThan(sunshine.indexOf("HIVRA_OMARCHY_SUNSHINE_READY"));
  });

  it("proves every approved CIDR rule before starting Sunshine", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omarchy-sunshine-fenced-"));
    directories.push(root);
    const fakeBin = path.join(root, "bin");
    const unitDirectory = path.join(root, "units");
    const commandLog = path.join(root, "commands.log");
    const firewallRules = path.join(root, "rules");
    const firewallCount = path.join(root, "allow-count");
    const serviceState = path.join(root, "service-active");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(firewallRules, "");
    writeFileSync(firewallCount, "0");
    writeFileSync(path.join(unitDirectory, "app-dev.lizardbyte.app.Sunshine.service"), "fixture\n");
    executable(path.join(fakeBin, "id"), "#!/bin/sh\nprintf '%s\\n' 1000\n");
    executable(path.join(fakeBin, "pacman"), `#!/bin/sh
if [ "$1" = "-Q" ] && [ "$2" = "omarchy" ]; then printf '%s\\n' 'omarchy 4.0.2-1'; exit 0; fi
if [ "$1" = "-Q" ] && [ "$2" = "sunshine" ]; then printf '%s\\n' 'sunshine 2026.516.143833-4'; exit 0; fi
exit 0
`);
    executable(path.join(fakeBin, "systemctl"), `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$HIVRA_TEST_COMMAND_LOG"
case "$*" in
  *"enable --now"*) touch "$HIVRA_TEST_SERVICE_STATE" ;;
  *"is-enabled"*) [[ -e "$HIVRA_TEST_SERVICE_STATE" ]] && printf '%s\\n' enabled || printf '%s\\n' disabled ;;
  *"is-active"*) [[ -e "$HIVRA_TEST_SERVICE_STATE" ]] && printf '%s\\n' active || printf '%s\\n' inactive ;;
esac
`);
    executable(path.join(fakeBin, "journalctl"), "#!/bin/sh\nprintf '%s\\n' 'Info: Found H.264 encoder: libx264 [software]'\n");
    executable(path.join(fakeBin, "curl"), "#!/bin/sh\nprintf '%s' 307\n");
    executable(path.join(fakeBin, "sudo"), "#!/bin/sh\n\"$@\"\n");
    executable(path.join(fakeBin, "ufw"), `#!/usr/bin/env bash
printf 'ufw %s\\n' "$*" >> "$HIVRA_TEST_COMMAND_LOG"
case "$*" in
  "status verbose") printf '%s\\n' 'Status: active' 'Default: deny (incoming), allow (outgoing), disabled (routed)' ;;
  "status numbered")
    printf '%s\\n' 'Status: active'
    cat "$HIVRA_TEST_FIREWALL_RULES"
    [[ -z "\${HIVRA_TEST_EXTRA_FIREWALL_RULE:-}" ]] || printf '%s\\n' "$HIVRA_TEST_EXTRA_FIREWALL_RULE"
    if [[ -n "\${HIVRA_TEST_LATE_ADMIN_RULE:-}" && "$(cat "$HIVRA_TEST_FIREWALL_COUNT")" -gt 0 ]]; then
      printf '47990/tcp %s IN Anywhere\\n' "$HIVRA_TEST_LATE_ADMIN_RULE"
    fi
    ;;
  allow*)
    count="$(cat "$HIVRA_TEST_FIREWALL_COUNT")"; count=$((count + 1)); printf '%s' "$count" > "$HIVRA_TEST_FIREWALL_COUNT"
    if [[ -n "\${HIVRA_TEST_UFW_FAIL_AFTER:-}" && "$count" -ge "$HIVRA_TEST_UFW_FAIL_AFTER" ]]; then exit 9; fi
    source="\${6%/32}"
    printf '%s\\n' "\${10}/\${4} ALLOW IN \$source # hivra-sunshine" >> "$HIVRA_TEST_FIREWALL_RULES"
    ;;
esac
`);
    const script = path.join(process.cwd(), "scripts/prepare-omarchy-sunshine.sh");
    const result = spawnSync("bash", [script, "--allow-cidr", "203.0.113.10/32"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HIVRA_SYSTEMD_USER_UNIT_DIR: unitDirectory,
        HIVRA_TEST_COMMAND_LOG: commandLog,
        HIVRA_TEST_FIREWALL_RULES: firewallRules,
        HIVRA_TEST_FIREWALL_COUNT: firewallCount,
        HIVRA_TEST_SERVICE_STATE: serviceState,
        HIVRA_TEST_EXTRA_FIREWALL_RULE: [
          "[ 3] 10.251.0.1 53/udp ALLOW IN 172.16.0.0/12 # allow-docker-dns",
          "[ 5] 22 ALLOW IN Anywhere",
        ].join("\n"),
      },
    });

    if (result.status !== 0) throw new Error(JSON.stringify({ status: result.status, stdout: result.stdout,
      stderr: result.stderr, rules: readFileSync(firewallRules, "utf8"), commands: readFileSync(commandLog, "utf8") }));
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr,
      rules: readFileSync(firewallRules, "utf8"), commands: readFileSync(commandLog, "utf8") }).toMatchObject({
      status: 0,
      stdout: expect.stringContaining('"firewallCidrs":1'),
      stderr: "",
    });
    const commands = readFileSync(commandLog, "utf8");
    expect(readFileSync(firewallRules, "utf8").trim().split("\n")).toHaveLength(9);
    expect(commands.indexOf("ufw status numbered")).toBeLessThan(commands.indexOf("systemctl --user enable --now"));

    rmSync(serviceState, { force: true });
    writeFileSync(firewallRules, "");
    writeFileSync(firewallCount, "0");
    writeFileSync(commandLog, "");
    const failed = spawnSync("bash", [script, "--allow-cidr", "203.0.113.10/32"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HIVRA_SYSTEMD_USER_UNIT_DIR: unitDirectory,
        HIVRA_TEST_COMMAND_LOG: commandLog,
        HIVRA_TEST_FIREWALL_RULES: firewallRules,
        HIVRA_TEST_FIREWALL_COUNT: firewallCount,
        HIVRA_TEST_SERVICE_STATE: serviceState,
        HIVRA_TEST_UFW_FAIL_AFTER: "3",
      },
    });
    const failedCommands = readFileSync(commandLog, "utf8");
    expect(failed.status).toBe(9);
    expect(failed.stdout).not.toContain("HIVRA_OMARCHY_SUNSHINE_READY");
    expect(failedCommands.match(/ufw --force delete allow/g)).toHaveLength(2);
    expect(failedCommands).not.toContain("systemctl --user enable --now");

    for (const extraRule of [
      "[ 99] 47900:48100/tcp ALLOW IN Anywhere",
      "[ 99] Sunshine ALLOW IN Anywhere",
      "[ 99] 47990/tcp ALLOW IN Anywhere",
      "[ 99] 47990/tcp ALLOW IN 203.0.113.10 # hivra-sunshine",
      "[ 99] 47989,47990/tcp ALLOW IN 203.0.113.10 # hivra-sunshine",
      "[ 99] 47990/tcp (v6) ALLOW IN Anywhere (v6)",
      "[ 99] 47990/tcp LIMIT IN Anywhere",
      "[ 99] 47990/tcp (v6) LIMIT IN Anywhere (v6)",
      "[ 99] Sunshine LIMIT IN Anywhere",
    ]) {
      rmSync(serviceState, { force: true });
      writeFileSync(firewallRules, "");
      writeFileSync(firewallCount, "0");
      writeFileSync(commandLog, "");
      const ambiguousIngress = spawnSync("bash", [script, "--allow-cidr", "203.0.113.10/32"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HIVRA_SYSTEMD_USER_UNIT_DIR: unitDirectory,
          HIVRA_TEST_COMMAND_LOG: commandLog,
          HIVRA_TEST_FIREWALL_RULES: firewallRules,
          HIVRA_TEST_FIREWALL_COUNT: firewallCount,
          HIVRA_TEST_SERVICE_STATE: serviceState,
          HIVRA_TEST_EXTRA_FIREWALL_RULE: extraRule,
        },
      });
      expect({ extraRule, status: ambiguousIngress.status, stderr: ambiguousIngress.stderr }).toMatchObject({
        extraRule,
        status: 6,
        stderr: expect.stringContaining("Unscoped or ambiguous inbound firewall rule overlaps Sunshine"),
      });
      expect(ambiguousIngress.stdout).not.toContain("HIVRA_OMARCHY_SUNSHINE_READY");
      expect(readFileSync(commandLog, "utf8")).not.toContain("systemctl --user enable --now");
      expect(readFileSync(commandLog, "utf8")).not.toContain("ufw allow");
    }

    for (const action of ["ALLOW", "LIMIT"]) {
      writeFileSync(firewallRules, "");
      writeFileSync(firewallCount, "0");
      writeFileSync(commandLog, "");
      const lateAdminRule = spawnSync("bash", [script, "--allow-cidr", "203.0.113.10/32"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`,
          HIVRA_SYSTEMD_USER_UNIT_DIR: unitDirectory, HIVRA_TEST_COMMAND_LOG: commandLog,
          HIVRA_TEST_FIREWALL_RULES: firewallRules, HIVRA_TEST_FIREWALL_COUNT: firewallCount,
          HIVRA_TEST_SERVICE_STATE: serviceState, HIVRA_TEST_LATE_ADMIN_RULE: action },
      });
      expect(lateAdminRule.status).toBe(6);
      expect(lateAdminRule.stderr).toContain("Sunshine administration");
      expect(lateAdminRule.stdout).not.toContain("HIVRA_OMARCHY_SUNSHINE_READY");
      const lateCommands = readFileSync(commandLog, "utf8");
      expect(lateCommands).not.toContain("systemctl --user enable --now");
      expect(lateCommands.match(/ufw --force delete allow/g)).toHaveLength(9);
    }
  });

  it("rolls back partial firewall rules and never starts Sunshine", () => {
    const sunshine = readFileSync(path.join(process.cwd(), "scripts/prepare-omarchy-sunshine.sh"), "utf8");
    expect(sunshine).toContain("rollback_partial_preparation");
    expect(sunshine).toContain("sudo ufw --force delete allow in proto");
    expect(sunshine.indexOf("added_firewall_rules+=("))
      .toBeLessThan(sunshine.indexOf('systemctl --user enable --now "$SUNSHINE_UNIT"'));
  });

  it("rejects broad public Sunshine exposure before touching the guest", () => {
    const script = path.join(process.cwd(), "scripts/prepare-omarchy-sunshine.sh");
    for (const cidr of ["0.0.0.0/0", "0.0.0.0/1", "203.0.113.0/24"]) {
      const result = spawnSync("bash", [script, "--allow-cidr", cidr], { encoding: "utf8" });
      expect({ cidr, status: result.status, stderr: result.stderr }).toMatchObject({
        cidr,
        status: 2,
        stderr: expect.stringContaining("client /32 or an RFC1918 private relay subnet"),
      });
    }
  });

  it("accepts official exported JSON with exactly one owner mode", () => {
    const directory = fixture({
      "user_configuration.json": officialConfiguration(false),
      "user_credentials.json": officialCredentials(),
      authorized_keys: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture fixture",
    });
    directories.push(directory);

    expect(readAndValidateOmarchyCidata(directory).map((file) => file.name)).toEqual([
      "authorized_keys",
      "user_configuration.json",
      "user_credentials.json",
    ]);
  });

  it("accepts the official empty deferred-owner marker", () => {
    const directory = fixture({
      "user_configuration.json": officialConfiguration(true),
      "defer-provisioning": "",
    });
    directories.push(directory);
    expect(readAndValidateOmarchyCidata(directory).map((file) => file.name)).toEqual([
      "defer-provisioning",
      "user_configuration.json",
    ]);
  });

  it("rejects a superficial full_disk marker without the real installer layout", () => {
    const directory = fixture({
      "user_configuration.json": JSON.stringify({
        omarchy_install: { mode: "full_disk", defer_provisioning: true },
        disk_config: { config_type: "default_layout" },
      }),
      "defer-provisioning": "",
    });
    directories.push(directory);
    expect(() => readAndValidateOmarchyCidata(directory)).toThrow(/boot and storage handoff/i);
  });

  it("rejects encryption, private keys, secret side channels, and ambiguous owner modes", () => {
    const encrypted = fixture({
      "user_configuration.json": officialConfiguration(true, { disk_encryption: { passphrase: "secret" } }),
      "defer-provisioning": "",
    });
    const privateKey = fixture({
      "user_configuration.json": officialConfiguration(false),
      "user_credentials.json": officialCredentials(),
      authorized_keys: "-----BEGIN OPENSSH PRIVATE KEY-----",
    });
    const tailscale = fixture({
      "user_configuration.json": officialConfiguration(true),
      "defer-provisioning": "",
      tailscale_authkey: "tskey-secret",
    });
    const ambiguous = fixture({
      "user_configuration.json": officialConfiguration(false),
      "user_credentials.json": officialCredentials(),
      "defer-provisioning": "",
    });
    directories.push(encrypted, privateKey, tailscale, ambiguous);

    expect(() => readAndValidateOmarchyCidata(encrypted)).toThrow(/plaintext passphrase/i);
    expect(() => readAndValidateOmarchyCidata(privateKey)).toThrow(/private key material/i);
    expect(() => readAndValidateOmarchyCidata(tailscale)).toThrow(/Unsupported cidata files/i);
    expect(() => readAndValidateOmarchyCidata(ambiguous)).toThrow(/exactly one/i);
  });

  it("rejects empty or plaintext credentials and a non-empty defer marker", () => {
    const empty = fixture({
      "user_configuration.json": officialConfiguration(false),
      "user_credentials.json": "{}",
    });
    const plaintext = fixture({
      "user_configuration.json": officialConfiguration(false),
      "user_credentials.json": JSON.stringify({
        root_enc_password: "password",
        users: [{ enc_password: "password", groups: [], sudo: true, username: "tester" }],
      }),
    });
    const marker = fixture({
      "user_configuration.json": officialConfiguration(true),
      "defer-provisioning": "not-empty",
    });
    directories.push(empty, plaintext, marker);

    expect(() => readAndValidateOmarchyCidata(empty)).toThrow(/exactly/i);
    expect(() => readAndValidateOmarchyCidata(plaintext)).toThrow(/SHA-512 crypt/i);
    expect(() => readAndValidateOmarchyCidata(marker)).toThrow(/empty marker/i);
  });

  it("builds an exact-host, claim-bound, checksum-pinned launch with failure cleanup", () => {
    const directory = fixture({ "user_configuration.json": officialConfiguration(true), "defer-provisioning": "" });
    directories.push(directory);
    const files = readAndValidateOmarchyCidata(directory);
    const script = buildOmarchyLabLaunchScript(params, files);

    expect(script).toContain('actual_hostname="$(hostname -s)"');
    expect(script).toContain("HIVRA_OMARCHY_HOST_MISMATCH");
    expect(script).toContain("HIVRA_OMARCHY_VMID_HAS_VOLUMES");
    expect(script).toContain(OMARCHY_PROXMOX_LAB.isoSha256);
    expect(script).toContain("--bios ovmf --machine q35 --cpu host");
    expect(script).toContain("--agent enabled=1");
    expect(script).toContain('--description "$VM_DESCRIPTION"');
    expect(script).toContain('description: hivra-omarchy-operation%3A$OPERATION_ID');
    expect(script).toContain("--ide3 \"$ISO_STORAGE:iso/$CIDATA_FILENAME,media=cdrom\"");
    expect(script).toContain("qm destroy \"$VMID\" --purge 1");
    expect(script).toContain("HIVRA_OMARCHY_FAILURE_CLEANUP_INCOMPLETE");
    expect(script).toContain("/var/lib/hivra/omarchy-claims");
    expect(script).toContain("HIVRA_OMARCHY_OPERATION_ALREADY_CLEAN");
    expect(script).toContain("set -o noclobber");
    expect(script).toContain("HIVRA_OMARCHY_VM_STORAGE_REQUIRES_ACTIVE_LVMTHIN");
    expect(script).toContain("HIVRA_OMARCHY_ISO_STORAGE_REQUIRES_ACTIVE_DIR");
    expect(script).toContain('pvesh get "/storage/$ISO_STORAGE" --output-format yaml');
    expect(script).not.toContain('pvesm config "$ISO_STORAGE"');
    expect(script).toContain("vm_owned_by_operation");
    expect(script.indexOf('HIVRA_OMARCHY_OPERATION_ALREADY_CLEAN')).toBeLessThan(script.indexOf('set -o noclobber'));
    expect(script.indexOf('HIVRA_OMARCHY_OPERATION_ALREADY_CLEAN')).toBeLessThan(script.indexOf('qm create "$VMID"'));
    expect(script.indexOf("CREATED_VM=1\nqm create")).toBeGreaterThan(0);
    expect(script).not.toContain("disk_encryption");
    expect(script).not.toContain("--skiplock");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  it("defaults to unaccelerated virtio and accepts only an explicit graphics opt-in", () => {
    const base = ["--vmid", String(params.vmid), "--name", params.name,
      "--expected-hostname", params.expectedHostname, "--storage", params.vmStorage,
      "--iso-storage", params.isoStorage, "--bridge", params.bridge, "--target", "lab1"];
    expect(parseArgs(base).graphics).toBe("virtio");
    expect(parseArgs([...base, "--graphics", "virtio-gl"]).graphics).toBe("virtio-gl");
    for (const value of ["none", "auto", "virtio-gl,memory=512", "virtio-gl;reboot", ""]) {
      expect(() => parseArgs([...base, "--graphics", value])).toThrow(/Invalid --graphics/);
      expect(() => buildOmarchyLabLaunchScript({ ...params, graphics: value as "virtio" }, [])).toThrow(/Invalid --graphics/);
    }
    expect(() => parseArgs([...base, "--graphics"])).toThrow(/Invalid --graphics/);
    expect(() => parseArgs([...base, "--graphics", "virtio-gl", "--graphics", "invalid"])).toThrow(/Invalid --graphics/);
    expect(() => parseArgs([...base, "--graphics", "virtio", "--graphics", "virtio"])).toThrow(/Invalid --graphics/);
    expect(buildOmarchyLabLaunchScript(params, [])).toContain("GRAPHICS='virtio'");
    const script = buildOmarchyLabLaunchScript({ ...params, graphics: "virtio-gl" }, []);
    expect(script).toContain("GRAPHICS='virtio-gl'");
    expect(script).toContain('--vga "$GRAPHICS"');
    expect(script.slice(0, script.indexOf("refresh_inventory()"))).not.toMatch(/hostpci|modprobe|apt(?:-get)? |qm set|qm stop/);
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
    const preflight = script.indexOf('if [ "$GRAPHICS" = virtio-gl ]; then');
    for (const mutation of ['install -d -m 0700 "$CLAIM_DIR"', 'curl --fail', 'qm create "$VMID"']) {
      expect(preflight).toBeLessThan(script.indexOf(mutation));
    }
  });

  it.each([
    ["virtio", false, false, false, null],
    ["virtio-gl", false, true, true, "HIVRA_OMARCHY_VIRGL_LIBRARIES_MISSING"],
    ["virtio-gl", true, false, true, "HIVRA_OMARCHY_VIRGL_LIBRARIES_MISSING"],
    ["virtio-gl", true, true, false, "HIVRA_OMARCHY_VIRGL_RENDER_NODE_UNAVAILABLE"],
    ["virtio-gl", true, true, true, null],
  ] as const)("preflights %s EGL=%s GL=%s render=%s before allocation", (graphics, egl, gl, render, failure) => {
    const root = fixture({ ...(egl ? { "egl.so": "fixture" } : {}), ...(gl ? { "gl.so": "fixture" } : {}) });
    directories.push(root);
    const script = buildOmarchyLabLaunchScript({ ...params, graphics }, []);
    const start = script.indexOf('if [ "$GRAPHICS" = virtio-gl ]; then');
    const end = script.indexOf("refresh_inventory()", start);
    const preflight = script.slice(start, end)
      .replaceAll("/usr/lib/x86_64-linux-gnu/libEGL.so.1", path.join(root, "egl.so"))
      .replaceAll("/usr/lib/x86_64-linux-gnu/libGL.so.1", path.join(root, "gl.so"))
      .replaceAll("/dev/dri/renderD*", render ? "/dev/null" : path.join(root, "ordinary-file"));
    writeFileSync(path.join(root, "ordinary-file"), "not a render device");
    const result = spawnSync("bash", ["-s"], { input: `set -euo pipefail\nGRAPHICS='${graphics}'\n${preflight}\nprintf 'PREFLIGHT_PASS\\n'`, encoding: "utf8" });
    expect(result.status).toBe(failure ? 5 : 0);
    expect(result.stderr.trim()).toBe(failure || "");
    expect(result.stdout.trim()).toBe(failure ? "" : "PREFLIGHT_PASS");
  });

  it("tears down only exact VM metadata and emits a durable idempotent receipt", () => {
    const script = buildOmarchyLabTeardownScript(params);
    expect(script).toContain("HIVRA_OMARCHY_CLAIM_MISMATCH");
    expect(script).toContain("HIVRA_OMARCHY_VM_IDENTITY_MISMATCH");
    expect(script).toContain("HIVRA_OMARCHY_VM_LOCKED");
    expect(script).toContain("qm destroy \"$VMID\" --purge 1");
    expect(script).toContain("HIVRA_OMARCHY_TEARDOWN_VM_SURVIVES");
    expect(script).toContain("HIVRA_OMARCHY_TEARDOWN_VOLUME_SURVIVES");
    expect(script).toContain("HIVRA_OMARCHY_TEARDOWN_CIDATA_SURVIVES");
    expect(script).toContain("HIVRA_OMARCHY_ORPHAN_VOLUME_REQUIRES_OPERATOR_REVIEW");
    expect(script).toContain("/var/lib/hivra/omarchy-receipts");
    expect(script.indexOf('mv -n "$receipt_tmp" "$RECEIPT_FILE"')).toBeLessThan(script.lastIndexOf('rm -f "$CLAIM_FILE"'));
    expect(script).toContain("HIVRA_OMARCHY_LAB_CLEAN");
    expect(script).not.toContain("--skiplock");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);
  });

  it("refuses wrong-storage teardown without destroying the VM or losing the credential ISO", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omarchy-fake-host-"));
    directories.push(root);
    const fakeBin = path.join(root, "bin");
    const stateRoot = path.join(root, "state");
    const storageRoot = path.join(root, "storage");
    const commandLog = path.join(root, "commands.log");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(path.join(stateRoot, "omarchy-claims"), { recursive: true });
    mkdirSync(path.join(storageRoot, "local", "template", "iso"), { recursive: true });
    mkdirSync(path.join(storageRoot, "other", "template", "iso"), { recursive: true });

    const cidataFilename = `hivra-omarchy-cidata-${params.vmid}-${params.operationId.slice(0, 8)}.iso`;
    const credentialIso = path.join(storageRoot, "local", "template", "iso", cidataFilename);
    writeFileSync(credentialIso, "credential-bearing-cidata", { mode: 0o600 });
    const launchIdentity = [
      params.operationId,
      params.expectedHostname,
      params.name,
      params.vmStorage,
      params.isoStorage,
      cidataFilename,
    ].join("|");
    writeFileSync(path.join(stateRoot, "omarchy-claims", `${params.vmid}.claim`), `${launchIdentity}\n`, { mode: 0o600 });

    executable(path.join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' 'canary-pve'\n");
    executable(path.join(fakeBin, "pvesm"), `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s\\n' 'Name Type Status Total Used Available %' 'local-lvm lvmthin active 1 0 1 0' 'local dir active 1 0 1 0' 'other dir active 1 0 1 0'
fi
`);
    executable(path.join(fakeBin, "pvesh"), `#!/bin/sh
storage="\${2##*/}"
printf '%s\\n' '---' "path: $FAKE_STORAGE_ROOT/$storage"
`);
    executable(path.join(fakeBin, "qm"), `#!/bin/sh
printf 'qm %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
if [ "$1" = "status" ]; then exit 0; fi
if [ "$1" = "config" ]; then
  printf '%s\\n' 'name: hivra-omarchy-lab' 'description: hivra-omarchy-operation%3A${params.operationId}' 'efidisk0: local-lvm:vm-2099-disk-0' 'scsi0: local-lvm:vm-2099-disk-1' 'ide3: local:iso/${cidataFilename},media=cdrom'
  exit 0
fi
exit 0
`);
    executable(path.join(fakeBin, "lvs"), "#!/bin/sh\nexit 0\n");
    executable(path.join(fakeBin, "lvremove"), `#!/bin/sh\nprintf 'lvremove %s\\n' "$*" >> "$FAKE_COMMAND_LOG"\n`);

    const script = buildOmarchyLabTeardownScript({ ...params, isoStorage: "other" })
      .replaceAll("/var/lib/hivra", stateRoot);
    const result = spawnSync("bash", [], {
      input: script,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        FAKE_STORAGE_ROOT: storageRoot,
        FAKE_COMMAND_LOG: commandLog,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("HIVRA_OMARCHY_CLAIM_MISMATCH");
    expect(existsSync(credentialIso)).toBe(true);
    expect(existsSync(commandLog) ? readFileSync(commandLog, "utf8") : "").not.toContain("destroy");
  });

  it("retains cleanup authority when Proxmox or LVM inventory is unknown", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omarchy-inventory-failure-"));
    directories.push(root);
    const fakeBin = path.join(root, "bin");
    const stateRoot = path.join(root, "state");
    const storageRoot = path.join(root, "storage");
    const commandLog = path.join(root, "commands.log");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(path.join(stateRoot, "omarchy-claims"), { recursive: true });
    mkdirSync(path.join(storageRoot, "local", "template", "iso"), { recursive: true });
    const cidataFilename = `hivra-omarchy-cidata-${params.vmid}-${params.operationId.slice(0, 8)}.iso`;
    const credentialIso = path.join(storageRoot, "local", "template", "iso", cidataFilename);
    const claimFile = path.join(stateRoot, "omarchy-claims", `${params.vmid}.claim`);
    const identity = [
      params.operationId,
      params.expectedHostname,
      params.name,
      params.vmStorage,
      params.isoStorage,
      cidataFilename,
    ].join("|");
    writeFileSync(credentialIso, "credential-bearing-cidata", { mode: 0o600 });
    writeFileSync(claimFile, `${identity}\n`, { mode: 0o600 });
    executable(path.join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' 'canary-pve'\n");
    executable(path.join(fakeBin, "pvesm"), `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s\\n' 'Name Type Status Total Used Available %' 'local-lvm lvmthin active 1 0 1 0' 'local dir active 1 0 1 0'
fi
`);
    executable(path.join(fakeBin, "pvesh"), `#!/bin/sh
storage="\${2##*/}"
printf '%s\\n' '---' "path: $FAKE_STORAGE_ROOT/$storage"
`);
    executable(path.join(fakeBin, "lvremove"), `#!/bin/sh\nprintf 'lvremove %s\\n' "$*" >> "$FAKE_COMMAND_LOG"\n`);
    const script = buildOmarchyLabTeardownScript(params).replaceAll("/var/lib/hivra", stateRoot);
    const execute = () => spawnSync("bash", [], {
      input: script,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        FAKE_STORAGE_ROOT: storageRoot,
        FAKE_COMMAND_LOG: commandLog,
      },
    });

    executable(path.join(fakeBin, "qm"), `#!/bin/sh
printf 'qm %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
[ "$1" = "list" ] && exit 42
exit 0
`);
    executable(path.join(fakeBin, "lvs"), "#!/bin/sh\nexit 0\n");
    const qmFailure = execute();
    expect(qmFailure.status).not.toBe(0);
    expect(qmFailure.stderr).toContain("HIVRA_OMARCHY_QM_INVENTORY_UNKNOWN");
    expect(qmFailure.stdout).not.toContain("HIVRA_OMARCHY_LAB_CLEAN");
    expect(existsSync(claimFile)).toBe(true);
    expect(existsSync(credentialIso)).toBe(true);

    executable(path.join(fakeBin, "qm"), `#!/bin/sh
printf 'qm %s\\n' "$*" >> "$FAKE_COMMAND_LOG"
[ "$1" = "list" ] && { printf '%s\\n' 'VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID'; exit 0; }
exit 0
`);
    executable(path.join(fakeBin, "lvs"), "#!/bin/sh\nexit 42\n");
    const lvsFailure = execute();
    expect(lvsFailure.status).not.toBe(0);
    expect(lvsFailure.stderr).toContain("HIVRA_OMARCHY_LV_INVENTORY_UNKNOWN");
    expect(lvsFailure.stdout).not.toContain("HIVRA_OMARCHY_LAB_CLEAN");
    expect(existsSync(claimFile)).toBe(true);
    expect(existsSync(credentialIso)).toBe(true);
    expect(readFileSync(commandLog, "utf8")).not.toContain("destroy");
  });

  it("requires an allowlisted target, pinned SSH identity, and exact VMID range", () => {
    const env = {
      HIVRA_OMARCHY_LAB_TARGETS: "lab1, lab2",
      PROXMOX_EXEC_MODE: "ssh",
      PROXMOX_SSH_HOST_FINGERPRINT: "SHA256:fixture",
      HIVRA_OMARCHY_LAB_TARGET_LAB1_VMID_START: "2000",
      HIVRA_OMARCHY_LAB_TARGET_LAB1_VMID_END: "2099",
    };
    expect(() => assertOmarchyLabTargetAuthorized("lab1", env, 2050)).not.toThrow();
    expect(() => assertOmarchyLabTargetAuthorized("prod", env, 2050)).toThrow(/not authorized/i);
    expect(() => assertOmarchyLabTargetAuthorized("lab1", { ...env, PROXMOX_SSH_HOST_FINGERPRINT: "" }, 2050)).toThrow(/fingerprint/i);
    expect(() => assertOmarchyLabTargetAuthorized("lab1", env, 2100)).toThrow(/outside/i);
    expect(() => assertOmarchyLabTargetAuthorized("lab1", { ...env, PROXMOX_EXEC_MODE: "local" }, 2050)).toThrow(/ALLOW_LOCAL/i);
    expect(() => assertOmarchyLabTargetAuthorized("lab2", {
      ...env,
      PROXMOX_VMID_START: "2000",
      PROXMOX_VMID_END: "2099",
    }, 2050)).toThrow(/HIVRA_OMARCHY_LAB_TARGET_LAB2_VMID_START/i);
  });

  it("rejects partial integer arguments", () => {
    const base = [
      "--vmid", "2099oops", "--name", params.name, "--expected-hostname", params.expectedHostname,
      "--storage", params.vmStorage, "--iso-storage", params.isoStorage, "--bridge", params.bridge,
      "--target", "lab1",
    ];
    expect(() => parseArgs(base)).toThrow(/Invalid --vmid/i);
    const invalidOperation = [...base];
    invalidOperation[1] = "2099";
    invalidOperation.push("--operation-id", "------------------------------------");
    expect(() => parseArgs(invalidOperation)).toThrow(/Invalid --operation-id/i);
  });
});
