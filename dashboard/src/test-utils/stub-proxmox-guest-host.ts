/**
 * A sandboxed stand-in for a Proxmox host, for executing generated host
 * scripts that SSH into a guest.
 *
 * `qm` answers from per-VM fixtures (config, status, QEMU Guest Agent and the
 * Ed25519 host key the guest agent reports). `ssh` emulates OpenSSH's host-key
 * policy against the key the machine answering at the guest IP actually
 * presents, which is how a spoofed neighbour is modelled: it only records what
 * it was sent when OpenSSH would have completed the connection. `sleep` and
 * `timeout` are shims so retry loops run instantly.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StubGuestVm {
  vmid: number;
  ip: string;
  status?: "running" | "stopped";
  /** The `agent:` config value. Omit for `agent: 1`, pass null to leave it out. */
  agent?: string | null;
  /** Whether the guest agent answers. Defaults to true for a running VM. */
  agentUp?: boolean;
  tags?: string;
  /** Base64 Ed25519 key blob the guest agent reports. Defaults to the genuine key. */
  attestedHostKey?: string;
  /** Raw `out-data` the guest agent returns for the host key file, overriding the key. */
  attestedHostKeyLine?: string;
}

export interface StubRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Everything a completed SSH connection received on stdin. Empty when nothing was sent. */
  delivered: string;
  /** One line per completed SSH connection: `<destination> <remote command>`. */
  sshCalls: string[];
  /** Every `ssh` invocation's arguments, including refused ones. */
  sshArgs: string[][];
}

export function ed25519KeyBlob(fill: number): string {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519", "ascii"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, fill),
  ]).toString("base64");
}

/** The key the genuine guest holds. */
export const GENUINE_GUEST_HOST_KEY = ed25519KeyBlob(7);
/** The key a spoofing neighbour's sshd presents. */
export const SPOOFED_GUEST_HOST_KEY = ed25519KeyBlob(9);

const QM_STUB = String.raw`#!/bin/bash
vm_dir() { printf '%s/vms/%s' "$STUB_ROOT" "$1"; }
case "$1" in
  status)
    d="$(vm_dir "$2")"
    [ -d "$d" ] || { echo "Configuration file 'nodes/stub/qemu-server/$2.conf' does not exist" >&2; exit 2; }
    echo "status: $(cat "$d/status")"
    ;;
  config)
    d="$(vm_dir "$2")"
    [ -d "$d" ] || { echo "Configuration file 'nodes/stub/qemu-server/$2.conf' does not exist" >&2; exit 2; }
    sed '/^\[/,$d' "$STUB_ROOT/qemu-server/$2.conf"
    ;;
  guest)
    d="$(vm_dir "$3")"
    [ -d "$d" ] || { echo "Configuration file 'nodes/stub/qemu-server/$3.conf' does not exist" >&2; exit 2; }
    [ "$(cat "$d/status")" = running ] || { echo "VM $3 not running" >&2; exit 255; }
    [ -f "$d/agent-up" ] || { echo "QEMU guest agent is not running" >&2; exit 255; }
    printf '%s\n' "$*" >> "$STUB_ROOT/capture/qga-calls"
    case "$2" in
      cmd) exit 0 ;;
      exec)
        line="$(cat "$d/hostkey-line")"
        printf '{"exitcode":0,"exited":1,"out-data":"%s\\n"}\n' "$line"
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`;

const SSH_STUB = String.raw`#!/bin/bash
printf '%s\x1f' "$@" >> "$STUB_ROOT/capture/ssh-argv"
printf '\n' >> "$STUB_ROOT/capture/ssh-argv"
strict="" known="" alias="" dest="" no_stdin=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      case "$1" in
        StrictHostKeyChecking=*) [ -n "$strict" ] || strict="${"$"}{1#*=}" ;;
        UserKnownHostsFile=*) [ -n "$known" ] || known="${"$"}{1#*=}" ;;
        HostKeyAlias=*) [ -n "$alias" ] || alias="${"$"}{1#*=}" ;;
      esac
      ;;
    -i) shift ;;
    -n) no_stdin=1 ;;
    -*) ;;
    *) dest="$1"; shift; break ;;
  esac
  shift
done
name="${"$"}{alias:-${"$"}{dest#*@}}"
if [ -n "$known" ] && [ -f "$known" ] && grep -Fqx "$name ssh-ed25519 $SERVER_HOSTKEY" "$known"; then
  :
elif [ -n "$known" ] && [ -f "$known" ] && grep -q "^$name " "$known"; then
  echo "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@" >&2
  echo "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" >&2
  echo "Host key verification failed." >&2
  exit 255
elif [ "$strict" = "accept-new" ] || [ "$strict" = "no" ]; then
  :
else
  echo "No ED25519 host key is known for $name and you have requested strict checking." >&2
  echo "Host key verification failed." >&2
  exit 255
fi
[ -n "$no_stdin" ] || cat >> "$STUB_ROOT/capture/delivered"
printf '%s %s\n' "$dest" "$*" >> "$STUB_ROOT/capture/ssh-calls"
case "$*" in
  "sudo -n true") ;;
  *) printf '%s\n' "$SSH_STDOUT" ;;
esac
`;

export interface StubProxmoxGuestHost {
  root: string;
  vmKeyPath: string;
  run(script: string, options: { vms: StubGuestVm[]; serverHostKey: string; sshStdout?: string }): StubRunResult;
  cleanup(): void;
}

export function createStubProxmoxGuestHost(): StubProxmoxGuestHost {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxmox-guest-host-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "qm"), QM_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), SSH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "timeout"), '#!/bin/bash\nshift\nexec "$@"\n', { mode: 0o755 });
  const vmKeyPath = path.join(root, "vm-key");
  fs.writeFileSync(vmKeyPath, "fixture key\n", { mode: 0o600 });

  function reset(vms: StubGuestVm[]): void {
    for (const dir of ["vms", "qemu-server", "capture", "run"]) {
      fs.rmSync(path.join(root, dir), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, dir));
    }
    for (const vm of vms) {
      const status = vm.status ?? "running";
      const dir = path.join(root, "vms", String(vm.vmid));
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "status"), status);
      if (vm.agentUp ?? status === "running") fs.writeFileSync(path.join(dir, "agent-up"), "");
      fs.writeFileSync(
        path.join(dir, "hostkey-line"),
        vm.attestedHostKeyLine ?? `ssh-ed25519 ${vm.attestedHostKey ?? GENUINE_GUEST_HOST_KEY} root@guest`
      );
      const config = [
        ...(vm.agent === null ? [] : [`agent: ${vm.agent ?? "1"}`]),
        "cores: 2",
        `ipconfig0: ip=${vm.ip}/24,gw=10.250.20.1`,
        `name: hermes-fixture-${vm.vmid}`,
        ...(vm.tags ? [`tags: ${vm.tags}`] : []),
        "",
        // Snapshot sections carry their own (stale) ipconfig0; only the main section counts.
        "[pre-update]",
        "ipconfig0: ip=10.250.20.250/24,gw=10.250.20.1",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(root, "qemu-server", `${vm.vmid}.conf`), config);
    }
  }

  function read(file: string): string {
    const full = path.join(root, "capture", file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  }

  return {
    root,
    vmKeyPath,
    run(script, { vms, serverHostKey, sshStdout = "4242" }) {
      reset(vms);
      const sandboxed = script
        .replaceAll("/run/hivra-guest-ssh-identity.", `${root}/run/hivra-guest-ssh-identity.`)
        .replaceAll("/usr/bin/python3", "python3")
        .replaceAll("/etc/pve/qemu-server", `${root}/qemu-server`);
      const result = spawnSync("bash", ["-s"], {
        input: sandboxed,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STUB_ROOT: root,
          SERVER_HOSTKEY: serverHostKey,
          SSH_STDOUT: sshStdout,
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        delivered: read("delivered"),
        sshCalls: read("ssh-calls").split("\n").filter(Boolean),
        sshArgs: read("ssh-argv")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\x1f").filter((arg, index, all) => index < all.length - 1 || arg !== "")),
      };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
