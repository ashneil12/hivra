// Bake a fresh Proxmox template from an existing Hermes template.
//
// The script full-clones the source template, boots the clone on a temporary
// private IP, pre-pulls the current runtime images, stamps provenance metadata,
// resets first-boot state, shuts the VM down, then converts it to a template.
//
// Usage:
//   npm run ops:proxmox:template-bake -- --new 9004 --apply
//   npm run ops:proxmox:template-bake -- --source 9003 --new 9004 --ip 10.250.20.248 --apply
//   npm run ops:proxmox:template-bake -- --source 9005 --new 9006 --disk-size-gb 30 --apply

import { execFileSync } from "child_process";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import {
  isProxmoxProvisioningConfigured,
  resolveProxmoxTargetConfigurationUnlessHostResolved,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";

type EnvLike = Record<string, string | undefined>;

interface Args {
  sourceTemplate: number;
  newTemplate: number;
  name: string;
  temporaryIp: string;
  diskSizeGb: number;
  thinBase: boolean;
  apply: boolean;
}

const DEFAULT_TEMPLATE_DISK_GB = 30;

function parsePositiveInt(raw: string | undefined, label: string): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${raw || "(missing)"}`);
  }
  return parsed;
}

function defaultTemporaryIp(env: EnvLike): string {
  const prefix = env.PROXMOX_PRIVATE_SUBNET_PREFIX?.trim() || "10.250.20";
  return `${prefix}.248`;
}

export function parseArgs(argv = process.argv.slice(2), env: EnvLike = process.env): Args {
  const sourceIdx = argv.indexOf("--source");
  const newIdx = argv.indexOf("--new");
  const nameIdx = argv.indexOf("--name");
  const ipIdx = argv.indexOf("--ip");
  const diskSizeIdx = argv.indexOf("--disk-size-gb");
  const legacyDiskIdx = argv.indexOf("--disk-gb");
  const diskIdx = diskSizeIdx >= 0 ? diskSizeIdx : legacyDiskIdx;
  const diskLabel = diskSizeIdx >= 0 ? "--disk-size-gb" : "--disk-gb";
  const apply = argv.includes("--apply");
  const thinBase = argv.includes("--thin-base");

  const sourceTemplate = sourceIdx >= 0
    ? parsePositiveInt(argv[sourceIdx + 1], "--source")
    : parsePositiveInt(env.PROXMOX_TEMPLATE_ID || "9003", "PROXMOX_TEMPLATE_ID");
  const newTemplate = parsePositiveInt(argv[newIdx + 1], "--new");
  const diskSizeGb = diskIdx >= 0
    ? parsePositiveInt(argv[diskIdx + 1], diskLabel)
    : parsePositiveInt(
        env.PROXMOX_TEMPLATE_DISK_SIZE_GB || env.PROXMOX_TEMPLATE_DISK_GB || String(DEFAULT_TEMPLATE_DISK_GB),
        "PROXMOX_TEMPLATE_DISK_SIZE_GB",
      );

  const defaultName = thinBase
    ? `hermes-template-thin-base-${newTemplate}`
    : `hermes-template-baked-v0.12.x-ash-${String(newTemplate).slice(-3)}-bankr`;

  return {
    sourceTemplate,
    newTemplate,
    name: nameIdx >= 0
      ? argv[nameIdx + 1] || `hermes-template-baked-${newTemplate}`
      : defaultName,
    temporaryIp: ipIdx >= 0 ? argv[ipIdx + 1] || defaultTemporaryIp(env) : defaultTemporaryIp(env),
    diskSizeGb,
    thinBase,
    apply,
  };
}

function shQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildBakeScript(args: Args, dashboardCommit: string, env: EnvLike = process.env): string {
  const vmSshUser = env.PROXMOX_VM_SSH_USER || "hermes";
  const vmSshKeyPath = env.PROXMOX_VM_SSH_KEY_PATH || "/etc/hivra/keys/vm-orchestrator";
  const nameserver = env.PROXMOX_VM_NAMESERVER || "185.12.64.1 185.12.64.2 1.1.1.1 8.8.8.8";
  const gateway = env.PROXMOX_PRIVATE_GATEWAY || "10.250.20.1";
  const cidr = env.PROXMOX_PRIVATE_CIDR || "24";
  const agentImage = env.HERMES_AGENT_IMAGE || "ghcr.io/ashneil12/vanilla-hermes-agent:stable";
  const webuiImage = env.HERMES_WEBUI_IMAGE || "ghcr.io/ashneil12/hermes-webui:stable";
  const caddyImage = env.HERMES_CADDY_IMAGE || "caddy:2";
  const helperImages = env.HERMES_TEMPLATE_HELPER_IMAGES || "busybox:latest node:22-alpine";

  const pullImagesList = args.thinBase
    ? `"$CADDY_IMAGE"`
    : `"$AGENT_IMAGE" "$WEBUI_IMAGE" "$CADDY_IMAGE"`;
  const digestSection = args.thinBase
    ? `caddy_digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$CADDY_IMAGE" 2>/dev/null || true)"`
    : `agent_digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$AGENT_IMAGE" 2>/dev/null || true)"
webui_digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$WEBUI_IMAGE" 2>/dev/null || true)"
caddy_digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$CADDY_IMAGE" 2>/dev/null || true)"`;
  const agentImageJson = args.thinBase ? "null" : `"$AGENT_IMAGE"`;
  const agentDigestJson = args.thinBase ? "null" : `"$agent_digest"`;
  const webuiImageJson = args.thinBase ? "null" : `"$WEBUI_IMAGE"`;
  const webuiDigestJson = args.thinBase ? "null" : `"$webui_digest"`;
  const thinBaseJsonField = args.thinBase ? `,\n  "thinBase": true` : "";

  const guestScript = `#!/usr/bin/env bash
set -euo pipefail

mkdir -p /etc/hermes

echo "[bake] root filesystem before image refresh"
df -h /

echo "[bake] quiescing background apt/packagekit before Docker image refresh"
for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service packagekit.service; do
  systemctl stop "$unit" >/dev/null 2>&1 || true
  systemctl mask "$unit" >/dev/null 2>&1 || true
done
for _ in $(seq 1 60); do
  if ! pgrep -af 'apt.systemd.daily|unattended-upgrade|packagekitd|apt-get|dpkg|aptitude' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null 2>&1 || true

root_source="$(findmnt -n -o SOURCE / || true)"
if [ -n "$root_source" ]; then
  if command -v growpart >/dev/null 2>&1; then
    root_disk="$(lsblk -no PKNAME "$root_source" 2>/dev/null | head -n1 || true)"
    root_part="$(lsblk -no PARTN "$root_source" 2>/dev/null | head -n1 || true)"
    if [ -n "$root_disk" ] && [ -n "$root_part" ]; then
      growpart "/dev/$root_disk" "$root_part" || true
    fi
  fi
  resize2fs "$root_source" >/dev/null 2>&1 || xfs_growfs / >/dev/null 2>&1 || true
fi

echo "[bake] pruning stale Docker cache before pulling fresh runtime images"
docker system df || true
docker system prune -af || true
docker builder prune -af || true
docker system df || true

for image in ${pullImagesList}; do
  docker pull "$image"
done
if [ -n "\${HELPER_IMAGES:-}" ]; then
  for image in $HELPER_IMAGES; do
    docker pull "$image"
  done
fi

${digestSection}

cat > /etc/hermes/template-version.json <<JSON
{
  "templateVmid": $NEW_TEMPLATE,
  "templateName": "$NEW_NAME",
  "bakedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "dashboardCommit": "$DASHBOARD_COMMIT",
  "agentImage": ${agentImageJson},
  "agentDigest": ${agentDigestJson},
  "webuiImage": ${webuiImageJson},
  "webuiDigest": ${webuiDigestJson},
  "caddyImage": "$CADDY_IMAGE",
  "caddyDigest": "$caddy_digest",
  "helperImages": "$HELPER_IMAGES",
  "bankrRuntime": true${thinBaseJsonField}
}
JSON
chmod 0644 /etc/hermes/template-version.json
cat /etc/hermes/template-version.json

# Keep the Docker image cache, but reset identity and first-boot state before
# this VM becomes a template.
cloud-init clean --logs --machine-id || true
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id || true
rm -f /var/lib/dbus/machine-id || true
sync
`;

  const guestB64 = Buffer.from(guestScript, "utf8").toString("base64");

  return `#!/usr/bin/env bash
set -euo pipefail

SOURCE_TEMPLATE=${shQuote(args.sourceTemplate)}
NEW_TEMPLATE=${shQuote(args.newTemplate)}
NEW_NAME=${shQuote(args.name)}
TEMP_IP=${shQuote(args.temporaryIp)}
DISK_SIZE_GB=${shQuote(args.diskSizeGb)}
CIDR=${shQuote(cidr)}
GATEWAY=${shQuote(gateway)}
NAMESERVER=${shQuote(nameserver)}
VM_SSH_USER=${shQuote(vmSshUser)}
VM_SSH_KEY_PATH=${shQuote(vmSshKeyPath)}
DASHBOARD_COMMIT=${shQuote(dashboardCommit)}
AGENT_IMAGE=${shQuote(agentImage)}
WEBUI_IMAGE=${shQuote(webuiImage)}
CADDY_IMAGE=${shQuote(caddyImage)}
HELPER_IMAGES=${shQuote(helperImages)}
KNOWN_HOSTS="/tmp/hermes-template-$NEW_TEMPLATE-known-hosts"
GUEST_B64=${shQuote(guestB64)}

if qm status "$NEW_TEMPLATE" >/dev/null 2>&1; then
  echo "Template/VMID $NEW_TEMPLATE already exists; refusing to overwrite." >&2
  exit 2
fi

if ! qm config "$SOURCE_TEMPLATE" | grep -q "^template: 1$"; then
  echo "Source $SOURCE_TEMPLATE is not a template." >&2
  exit 3
fi

cleanup_failed() {
  status="$?"
  if [ "$status" != "0" ]; then
    echo "[bake] failed; cleaning up VMID $NEW_TEMPLATE" >&2
    qm stop "$NEW_TEMPLATE" --skiplock 1 >/dev/null 2>&1 || true
    qm destroy "$NEW_TEMPLATE" --purge 1 >/dev/null 2>&1 || true
  fi
  rm -f "$KNOWN_HOSTS"
  exit "$status"
}
trap cleanup_failed EXIT

echo "[bake] full-cloning $SOURCE_TEMPLATE -> $NEW_TEMPLATE"
qm clone "$SOURCE_TEMPLATE" "$NEW_TEMPLATE" --name "$NEW_NAME" --full 1
current_disk_size_gb="$(qm config "$NEW_TEMPLATE" | awk -F 'size=' '/^scsi0:/ { split($2, parts, ","); gsub(/G/, "", parts[1]); print int(parts[1]); exit }')"
if [ -z "$current_disk_size_gb" ]; then
  echo "Could not determine cloned scsi0 disk size for $NEW_TEMPLATE." >&2
  exit 6
fi
if [ "$current_disk_size_gb" -lt "$DISK_SIZE_GB" ]; then
  echo "[bake] expanding scsi0 from \${current_disk_size_gb}G to \${DISK_SIZE_GB}G"
  qm resize "$NEW_TEMPLATE" scsi0 "\${DISK_SIZE_GB}G"
else
  echo "[bake] scsi0 is \${current_disk_size_gb}G; no disk expansion needed"
fi
# Stamp aio=threads on the template so linked clones inherit it. Proxmox's
# io_uring default silently swallows guest UNMAP, leaving fstrim a no-op
# at the host thin-pool layer (verified on a disposable template-bake VM).
SCSI0_DISK="$(qm config "$NEW_TEMPLATE" | sed -n 's/^scsi0: \\([^,]*\\).*/\\1/p' | head -n1)"
if [ -n "$SCSI0_DISK" ]; then
  qm set "$NEW_TEMPLATE" --scsi0 "$SCSI0_DISK,discard=on,aio=threads"
fi
qm set "$NEW_TEMPLATE" --cores 2 --memory 4096 --ipconfig0 "ip=$TEMP_IP/$CIDR,gw=$GATEWAY" --nameserver "$NAMESERVER" --onboot 0
qm start "$NEW_TEMPLATE"

echo "[bake] waiting for SSH at $TEMP_IP"
rm -f "$KNOWN_HOSTS"
for attempt in $(seq 1 90); do
  if ssh -n -i "$VM_SSH_KEY_PATH" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KNOWN_HOSTS" -o ConnectTimeout=5 "$VM_SSH_USER@$TEMP_IP" "sudo -n true" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" = "90" ]; then
    echo "SSH never became ready" >&2
    exit 4
  fi
  sleep 5
done

echo "[bake] pulling runtime images inside template guest"
printf "%s" "$GUEST_B64" | base64 -d | ssh -i "$VM_SSH_KEY_PATH" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KNOWN_HOSTS" "$VM_SSH_USER@$TEMP_IP" \\
  "sudo env NEW_TEMPLATE='$NEW_TEMPLATE' NEW_NAME='$NEW_NAME' DASHBOARD_COMMIT='$DASHBOARD_COMMIT' AGENT_IMAGE='$AGENT_IMAGE' WEBUI_IMAGE='$WEBUI_IMAGE' CADDY_IMAGE='$CADDY_IMAGE' HELPER_IMAGES='$HELPER_IMAGES' bash -s"

echo "[bake] shutting down guest"
qm shutdown "$NEW_TEMPLATE" --timeout 180 || qm stop "$NEW_TEMPLATE" --skiplock 1
for attempt in $(seq 1 60); do
  status="$(qm status "$NEW_TEMPLATE" | awk '{print $2}')"
  [ "$status" = "stopped" ] && break
  sleep 2
done
if [ "$(qm status "$NEW_TEMPLATE" | awk '{print $2}')" != "stopped" ]; then
  echo "VM did not stop cleanly" >&2
  exit 5
fi

echo "[bake] converting $NEW_TEMPLATE to template"
qm template "$NEW_TEMPLATE"
qm set "$NEW_TEMPLATE" --name "$NEW_NAME" --onboot 0
qm config "$NEW_TEMPLATE" | sed -n "s/^name:.*/&/p; s/^template:.*/&/p; s/^scsi0:.*/&/p; s/^ipconfig0:.*/&/p"
echo "[bake] complete template $NEW_TEMPLATE"

trap - EXIT
rm -f "$KNOWN_HOSTS"
`;
}

async function main(): Promise<void> {
  const env = resolveProxmoxTargetConfigurationUnlessHostResolved(process.env).env;
  const args = parseArgs(process.argv.slice(2), env);
  if (!args.apply) {
    throw new Error("Pass --apply to create a new Proxmox template.");
  }
  if (!isProxmoxProvisioningConfigured(env)) {
    throw new Error("Proxmox SSH is not configured in dashboard/.env.local.");
  }

  const dashboardCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  }).trim();

  const result = await runProxmoxHostScript(
    buildBakeScript(args, dashboardCommit, env),
    env,
    { timeoutMs: 20 * 60_000 }
  );

  console.log(result.stdout);
  if (!result.ok) {
    throw new Error(result.stderr || result.error || "Proxmox template bake failed.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[template-bake] fatal:", err);
    process.exit(1);
  });
}
