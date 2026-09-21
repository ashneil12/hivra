import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(process.cwd(), "provisioner/provision-claude-code-box.sh"), "utf8");
const modeFunction = source.match(/^provider_desktop_prepare_mode\(\) \{[\s\S]*?^\}/m)?.[0];
const modeAssignment = source.match(/^PROVIDER_DESKTOP_PREPARE_ONLY=.*\\\n.*$/m)?.[0];
const chatStart = source.match(/^if \[ "\$AGENT_KIND" != "deepseek-harness" \] && \[ "\$PROVIDER_DESKTOP_PREPARE_ONLY" != 1 \]; then\n  systemctl[\s\S]*?^fi/m)?.[0];
const chatWriteGate = source.match(/# Install the chat unit, templated[^\n]*\n([^\n]*)\nNODE_BIN=/)?.[1];
const baseReturn = source.match(/^if \[ "\$AGENT_KIND" = "deepseek-harness" \] \|\| \[ "\$PROVIDER_DESKTOP_PREPARE_ONLY" = 1 \]; then\n[\s\S]*?^fi/m)?.[0];
const workspaceInstall = source.match(/^if \[ "\$PROVIDER_DESKTOP_PREPARE_ONLY" = 1 \]; then\n  # Provider workspace[\s\S]*?^fi/m)?.[0];

function shell(script: string, args: string[]) {
  return spawnSync("/bin/bash", ["-c", `set -eu\n${script}`, "hivra-test", ...args], {
    encoding: "utf8", timeout: 5_000, env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" },
  });
}

it("parses the actual candidate installer without executing it", () => {
  expect(spawnSync("/bin/bash", ["-n", "provisioner/provision-claude-code-box.sh"]).status).toBe(0);
  expect(modeFunction).toBeDefined();
  expect(modeAssignment).toBeDefined();
  expect(chatStart).toBeDefined();
  expect(chatWriteGate).toBeDefined();
  expect(baseReturn).toBeDefined();
});
it("extracts the verified Node archive without vendor UID while retaining pinned executable modes", () => {
  const extraction = source.match(/^    tar [^\n]*"\$\{NODE_TMP_DIR\}\/node\.tar\.xz"[^\n]*$/m)?.[0];
  expect(extraction).toBeDefined();
  const result = shell(`umask 077\nNODE_TMP_DIR=/owned-node-fixture\ntar() { printf '%s\\n' "$@"; }\n${extraction}`, []);
  expect(result.status).toBe(0);
  expect(result.stdout.split("\n")).toEqual([
    "--no-same-owner", "-xJf", "/owned-node-fixture/node.tar.xz", "-C", "/opt/hivra", "",
  ]);
  expect(source.indexOf('die "Node.js archive checksum verification failed"')).toBeLessThan(source.indexOf(extraction!));
});
it.each(['0', '1'])("installs and root-owns the workspace closure only for private prepare mode %s", mode => {
  expect(workspaceInstall).toBeDefined();
  const result = shell(`PROVIDER_DESKTOP_PREPARE_ONLY="$1"; SRC_DIR=/fixture/source; BUX_DIR=/fixture/bux\ninstall() { printf 'install %s\\n' "$*"; }\nchown() { printf 'chown %s\\n' "$*"; }\nchmod() { printf 'chmod %s\\n' "$*"; }\n${workspaceInstall}`, [mode]);
  expect(result.status).toBe(0);
  if (mode === '0') { expect(result.stdout).toBe(''); return; }
  for (const file of ['workspace-access-policy.cjs', 'workspace-sessions.cjs', 'workspace-control.cjs', 'workspace-router.cjs', 'workspace-handoff.cjs']) {
    expect(result.stdout).toContain(`install -o root -g root -m 0644 /fixture/source/hivra-chat/${file} /fixture/bux/hivra-chat/${file}`);
  }
  expect(result.stdout).toContain('chown root:root /fixture/bux /fixture/bux/hivra-chat\n');
  expect(result.stdout).toContain('chmod 0755 /fixture/bux /fixture/bux/hivra-chat\n');
  expect(result.stdout).toContain('chown root:root /fixture/bux/hivra-chat/server.js\n');
});
it("keeps the actual installer default at ordinary activation when the private environment flag is absent", () => {
  const result = shell(`AGENT_KIND=linux-desktop; COMPUTER_SUBSTRATE=proxmox-kvm\n${modeFunction}\n${modeAssignment}\nprintf '%s' "$PROVIDER_DESKTOP_PREPARE_ONLY"`, []);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("0");
});
it.each([
  ["1", "linux-desktop", "provider-vm", 0],
  ["1", "linux-desktop", "proxmox-kvm", 1],
  ["1", "codex", "provider-vm", 1],
  ["1", "deepseek-harness", "provider-vm", 1],
  ["yes", "linux-desktop", "provider-vm", 1],
  ["", "linux-desktop", "provider-vm", 1],
  ["0", "linux-desktop", "proxmox-kvm", 0],
  ["0", "codex", "provider-vm", 0],
])("limits preparation mode %s to %s/%s", (mode, kind, substrate, status) => {
  const result = shell(`${modeFunction}\nprovider_desktop_prepare_mode "$1" "$2" "$3"`, [String(mode), String(kind), String(substrate)]);
  expect(result.status).toBe(status);
  expect(result.stdout).toBe(status === 0 ? `${mode}\n` : "");
});
it.each([
  ["linux-desktop", "1", false], ["linux-desktop", "0", true], ["codex", "0", true], ["deepseek-harness", "0", false],
])("reserves chat unit installation for its owner in %s, prepare=%s", (kind, mode, writes) => {
  const result = shell(`AGENT_KIND="$1"; PROVIDER_DESKTOP_PREPARE_ONLY="$2"\n${chatWriteGate}\nprintf write-unit\nfi`, [String(kind), String(mode)]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(writes ? "write-unit" : "");
});
it.each([
  ["linux-desktop", "1", false], ["linux-desktop", "0", true], ["codex", "0", true], ["deepseek-harness", "0", false],
])("uses the actual chat activation gate for %s, prepare=%s", (kind, mode, starts) => {
  // Execute only the extracted gate with a harmless command recorder, never
  // the package installer or the machine's systemctl.
  const result = shell(`AGENT_KIND="$1"; PROVIDER_DESKTOP_PREPARE_ONLY="$2"\nok() { :; }\nsystemctl() { printf '%s\\n' "$*"; }\n${chatStart}`, [String(kind), String(mode)]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(starts ? "enable --now bux-hivra-chat.service\n" : "");
});
it.each([
  ["linux-desktop", "1", true], ["linux-desktop", "0", false], ["codex", "0", false], ["deepseek-harness", "0", true],
])("returns before desktop installation and runtime publication for %s, prepare=%s", (kind, mode, returns) => {
  const result = shell(`AGENT_KIND="$1"; PROVIDER_DESKTOP_PREPARE_ONLY="$2"\nok() { :; }\n${baseReturn}\nprintf continued`, [String(kind), String(mode)]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(returns ? "" : "continued");
  const position = source.indexOf(baseReturn!);
  expect(position).toBeLessThan(source.indexOf('REMOTE_DESKTOP_RESULT="$('));
  expect(position).toBeLessThan(source.indexOf('RECEIPT_RESULT="$('));
});
