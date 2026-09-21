import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";

export type TailscaleStatusSnapshot = {
  machineName?: string;
  magicDnsName?: string;
  tailnetName?: string;
  ipv4?: string;
  ipv6?: string;
  sshEnabled?: boolean;
};

type TailscaleCommandResult = {
  stdout?: string;
  stderr?: string;
  error?: string;
};

export function buildTailscaleInstallScript(): string {
  return [
    // Idempotent + host-native. On VMs cloned from a template that already
    // bakes in Tailscale this install block is skipped; on older VMs we
    // install it on the host (Ubuntu: systemd + real TUN), never inside a
    // container.
    "if ! command -v tailscale >/dev/null 2>&1; then",
    "  if ! command -v curl >/dev/null 2>&1; then",
    "    if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y curl; fi",
    "  fi",
    "  if ! command -v curl >/dev/null 2>&1; then",
    "    echo 'curl is required to install Tailscale but is not available on this host' >&2",
    "    exit 1",
    "  fi",
    // Download-then-run instead of `curl ... | sh`: a piped install hides a
    // failed download because the pipeline's exit status is sh's (0), so a
    // missing/blocked curl silently 'succeeds' and leaves no tailscaled.
    "  ts_installer=$(mktemp)",
    '  if ! curl -fsSL https://tailscale.com/install.sh -o "$ts_installer"; then',
    '    rm -f "$ts_installer"',
    "    echo 'Failed to download the Tailscale installer' >&2",
    "    exit 1",
    "  fi",
    '  if ! sh "$ts_installer"; then',
    '    rm -f "$ts_installer"',
    "    echo 'Tailscale installation failed' >&2",
    "    exit 1",
    "  fi",
    '  rm -f "$ts_installer"',
    "fi",
    "if ! command -v tailscaled >/dev/null 2>&1; then",
    "  echo 'tailscaled binary was not installed by the Tailscale installer' >&2",
    "  exit 1",
    "fi",
    // Prefer systemd (auto-restart + boot persistence). The userspace
    // fallback is defense-in-depth for the rare host without systemd.
    "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then",
    "  systemctl enable --now tailscaled",
    "else",
    "  mkdir -p /var/lib/tailscale /var/run/tailscale",
    "  if ! { [ -S /var/run/tailscale/tailscaled.sock ] || (command -v pgrep >/dev/null 2>&1 && pgrep -x tailscaled >/dev/null 2>&1); }; then",
    "    nohup tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --tun=userspace-networking > /var/log/hermes-tailscaled.log 2>&1 &",
    "    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do",
    "      if tailscale status --json >/dev/null 2>&1; then",
    "        break",
    "      fi",
    "      sleep 1",
    "    done",
    "  fi",
    "  if ! tailscale status --json >/dev/null 2>&1; then",
    "    echo 'tailscaled did not become ready; see /var/log/hermes-tailscaled.log' >&2",
    "    tail -n 80 /var/log/hermes-tailscaled.log >&2 || true",
    "    exit 1",
    "  fi",
    "fi",
  ].join("\n");
}

export function buildTailscaleEnrollCommand(params: {
  authKeyEnvVar: string;
  machineName?: string;
  tags?: string[];
  enableSsh?: boolean;
}): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(params.authKeyEnvVar)) {
    throw new Error("Invalid auth key env var name");
  }

  const parts = [`tailscale up --auth-key "$${params.authKeyEnvVar}"`];

  if (params.machineName?.trim()) {
    parts.push(`--hostname=${quoteShellArg(params.machineName.trim())}`);
  }

  if (params.tags && params.tags.length > 0) {
    parts.push(`--advertise-tags=${quoteShellArg(params.tags.join(","))}`);
  }

  if (params.enableSsh) {
    parts.push("--ssh");
  }

  return parts.join(" ");
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildTailscaleSetCommand(params: {
  machineName?: string;
  enableSsh?: boolean;
}): string {
  const parts = ["tailscale set"];

  if (params.machineName?.trim()) {
    parts.push(`--hostname=${quoteShellArg(params.machineName.trim())}`);
  }

  if (params.enableSsh === true) {
    parts.push("--ssh");
  } else if (params.enableSsh === false) {
    parts.push("--ssh=false");
  }

  return parts.join(" ");
}

export function buildTailscaleDisableScript(): string {
  return [
    "tailscale logout || true",
    "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then",
    "  systemctl disable --now tailscaled || true",
    "elif command -v pkill >/dev/null 2>&1; then",
    "  pkill -x tailscaled || true",
    "fi",
  ].join("\n");
}

export function parseTailscaleStatusJson(raw: string): TailscaleStatusSnapshot {
  const parsed = JSON.parse(raw) as {
    Self?: {
      HostName?: string;
      DNSName?: string;
      TailscaleIPs?: string[];
      SSHEnabled?: boolean;
    };
    CurrentTailnet?: {
      Name?: string;
    };
  };

  const ips = parsed.Self?.TailscaleIPs || [];
  const ipv4 = ips.find((value) => value.includes("."));
  const ipv6 = ips.find((value) => value.includes(":"));
  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, "");

  return {
    machineName: parsed.Self?.HostName,
    magicDnsName: dnsName,
    tailnetName: parsed.CurrentTailnet?.Name,
    ipv4,
    ipv6,
    sshEnabled: parsed.Self?.SSHEnabled,
  };
}

export function redactTailscaleError(message: string, authKey?: string): string {
  const withoutExactAuthKey = authKey ? message.split(authKey).join("[REDACTED]") : message;
  return redactSensitiveCommandOutput(withoutExactAuthKey, Math.max(withoutExactAuthKey.length, 300));
}

function isGenericRemoteExitError(message: string): boolean {
  return /^(Remote bash|Proxmox host script|Command) exited with code \d+$/i.test(message.trim());
}

function extractGenericExitCode(message: string): number | null {
  const match = message.trim().match(/exited with code\s+(\d+)$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function describeGenericRemoteExit(code: number | null, fallback: string): string {
  // Exit 255 from the Proxmox host-bridge path almost always means the
  // outer pve-host bash succeeded in running the inner `ssh user@guest`
  // command, but that ssh hop itself failed before the remote command
  // ran (host unreachable, sshd not listening, key denied, host-key
  // mismatch). The inner ssh's stderr is supposed to propagate up
  // through the outer bash, but in some failure modes — notably when
  // BatchMode=yes silently rejects auth — no output is captured at all.
  // Surface a hint so operators don't see a bare exit code.
  if (code === 255) {
    return (
      `${fallback}: couldn't reach the host over its management SSH bridge ` +
      `(exit 255, no diagnostic output captured). The VM may be stopped or ` +
      `unreachable on its private IP, or the Proxmox host may be missing the ` +
      `management SSH key. Open the instance console and verify the VM is ` +
      `running, then retry.`
    );
  }
  if (code !== null) {
    return `${fallback}: remote command exited with code ${code} (no diagnostic output captured).`;
  }
  return fallback;
}

export function formatTailscaleCommandError(
  result: TailscaleCommandResult,
  fallback: string,
  authKey?: string
): string {
  const stderr = result.stderr?.trim();
  const error = result.error?.trim();
  const stdout = result.stdout?.trim();

  if (error && isGenericRemoteExitError(error)) {
    // The bare "Remote bash exited with code N" message is uninformative on
    // its own. Prefer any captured stream output (stderr first, stdout next
    // — tailscale up prints failure details on stdout) before falling back
    // to a code-specific hint.
    const informative = stderr || stdout;
    if (informative) {
      return redactTailscaleError(`${informative}\n${error}`, authKey);
    }
    return redactTailscaleError(
      describeGenericRemoteExit(extractGenericExitCode(error), fallback),
      authKey,
    );
  }

  return redactTailscaleError(error || stderr || stdout || fallback, authKey);
}
