// Detach Hermes linked clones from their Proxmox template base disks.
//
// This is the storage-cleanup path that lets old template parents become
// deletable. It moves each VM's scsi0 disk from local-lvm -> local qcow2 ->
// local-lvm. Proxmox performs this as a full copy, and the resulting LVM thin
// volume no longer has an origin/base template dependency.
//
// The script processes one VM at a time so /var/lib/vz only needs enough free
// space for one temporary qcow2 copy.
//
// Usage:
//   npm run ops:proxmox:linked-clone-detach -- --dry-run
//   npm run ops:proxmox:linked-clone-detach -- --apply --parent 9000 --parent 9002
//   npm run ops:proxmox:linked-clone-detach -- --apply --vm 200

import path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import {
  isProxmoxProvisioningConfigured,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";

interface Args {
  apply: boolean;
  dryRun: boolean;
  vmids: number[];
  parentVmids: number[];
}

function parsePositiveInt(raw: string | undefined, label: string): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${raw || "(missing)"}`);
  }
  return parsed;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const vmids: number[] = [];
  const parentVmids: number[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--vm") vmids.push(parsePositiveInt(argv[i + 1], "--vm"));
    if (argv[i] === "--parent") parentVmids.push(parsePositiveInt(argv[i + 1], "--parent"));
  }

  if (!apply && !dryRun) {
    throw new Error("Pass --dry-run to preview or --apply to detach linked clones.");
  }
  if (apply && dryRun) {
    throw new Error("Choose only one of --dry-run or --apply.");
  }

  return { apply, dryRun, vmids, parentVmids };
}

function shArray(values: number[]): string {
  return values.length ? values.map((value) => String(value)).join(" ") : "";
}

function buildDetachScript(args: Args): string {
  return `#!/usr/bin/env bash
set -euo pipefail

MODE=${args.apply ? "apply" : "dry-run"}
SELECT_VMIDS="${shArray(args.vmids)}"
SELECT_PARENTS="${shArray(args.parentVmids)}"

contains_word() {
  needle="$1"
  haystack="$2"
  [ -z "$haystack" ] && return 1
  for item in $haystack; do
    [ "$item" = "$needle" ] && return 0
  done
  return 1
}

is_template() {
  vmid="$1"
  qm config "$vmid" 2>/dev/null | grep -q "^template: 1$"
}

disk_size_gb() {
  vmid="$1"
  qm config "$vmid" | sed -n 's/^scsi0: .*size=\\([0-9][0-9]*\\)G.*/\\1/p' | head -n1
}

local_avail_gb() {
  df -BG --output=avail /var/lib/vz | awk 'NR==2 {gsub(/G/, "", $1); print $1}'
}

tmp_refs="$(mktemp)"
trap 'rm -f "$tmp_refs"' EXIT

lvs --noheadings -o lv_name,origin 2>/dev/null | while read -r lv origin; do
  case "$lv" in
    vm-*-disk-0) ;;
    *) continue ;;
  esac
  [ -n "$origin" ] || continue
  case "$origin" in
    base-*-disk-0) ;;
    *) continue ;;
  esac
  vmid="$(printf '%s' "$lv" | sed -n 's/^vm-\\([0-9][0-9]*\\)-disk-0$/\\1/p')"
  parent="$(printf '%s' "$origin" | sed -n 's/^base-\\([0-9][0-9]*\\)-disk-0$/\\1/p')"
  [ -n "$vmid" ] && [ -n "$parent" ] || continue
  is_template "$vmid" && continue
  if [ -n "$SELECT_VMIDS" ] && ! contains_word "$vmid" "$SELECT_VMIDS"; then continue; fi
  if [ -n "$SELECT_PARENTS" ] && ! contains_word "$parent" "$SELECT_PARENTS"; then continue; fi
  name="$(qm config "$vmid" 2>/dev/null | sed -n 's/^name: //p' | head -n1)"
  status="$(qm status "$vmid" 2>/dev/null | awk '{print $2}' || true)"
  size="$(disk_size_gb "$vmid")"
  printf '%s|%s|%s|%s|%s\\n' "$vmid" "$parent" "$status" "$size" "$name" >> "$tmp_refs"
done

if [ ! -s "$tmp_refs" ]; then
  echo "No linked clone disks matched."
  exit 0
fi

echo "=== linked clone detach targets ==="
sort -n "$tmp_refs" | while IFS='|' read -r vmid parent status size name; do
  if [ -z "$size" ]; then size_label="unknown"; else size_label="$size"; fi
  echo "vmid=$vmid parent=$parent status=$status size=$size_label""G name=$name"
done

if [ "$MODE" = "dry-run" ]; then
  echo "Dry run only. No disks were moved."
  exit 0
fi

sort -n "$tmp_refs" | while IFS='|' read -r vmid parent status size name; do
  [ -n "$size" ] || size=30
  avail="$(local_avail_gb)"
  # Need temporary room for the qcow2 plus some headroom for Caddy/log churn.
  need=$((size + 8))
  if [ "$avail" -lt "$need" ]; then
    echo "Refusing vmid=$vmid: local storage has $avail""G free, need at least $need""G" >&2
    exit 10
  fi

  echo "=== detaching vmid=$vmid parent=$parent status=$status name=$name ==="
  qm disk move "$vmid" scsi0 local --format qcow2 --delete 1
  qm disk move "$vmid" scsi0 local-lvm --delete 1
  origin="$(lvs --noheadings -o origin "/dev/vg0/vm-$vmid-disk-0" 2>/dev/null | awk '{$1=$1; print}')"
  if [ -n "$origin" ]; then
    echo "vmid=$vmid still has origin=$origin after detach" >&2
    exit 11
  fi
  echo "detached vmid=$vmid"
done

echo "All selected linked clones detached."
`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!isProxmoxProvisioningConfigured(process.env)) {
    throw new Error("Proxmox SSH is not configured in dashboard/.env.local.");
  }

  const result = await runProxmoxHostScript(
    buildDetachScript(args),
    process.env,
    { timeoutMs: 90 * 60_000 }
  );
  console.log(result.stdout);
  if (!result.ok) {
    throw new Error(result.stderr || result.error || "Proxmox linked clone detach failed.");
  }
}

main().catch((err) => {
  console.error("[linked-clone-detach] fatal:", err);
  process.exit(1);
});
