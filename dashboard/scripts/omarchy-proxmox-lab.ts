// Claim-bound Omarchy Proxmox lab launcher.
//
// This operator fixture follows Omarchy's official v4.0.2 unattended ISO
// contract. It never invents the installer's JSON schema: the caller supplies
// files exported by the official installer. Apply requires an explicit routed
// target and expected hostname, and teardown requires the launch operation ID.

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import {
  isProxmoxProvisioningConfigured,
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";

export const OMARCHY_PROXMOX_LAB = {
  release: "v4.0.2",
  releaseCommit: "346e69e1cec6c4e8924531874af6ba010a1bc99e",
  isoUrl: "https://iso.omarchy.org/omarchy-4.0.2.iso",
  isoSha256: "2ef8e624aa1bec7e277e28056b8535a6c9373ba48d7ede3f1a01cb6d2373cfb8",
  isoFilename: "omarchy-4.0.2.iso",
  minimums: { cpu: 4, memoryMb: 8192, diskGb: 40 },
  machine: "q35",
  firmware: "ovmf",
  display: "virtio",
} as const;

const ALLOWED_CIDATA_FILES = new Set([
  "user_configuration.json",
  "user_credentials.json",
  "defer-provisioning",
  "user_full_name.txt",
  "user_email_address.txt",
  "authorized_keys",
]);

export interface OmarchyCidataFile {
  name: string;
  content: Buffer;
  sha256: string;
}

function assertAuthorizedKeys(content: Buffer): void {
  const authorizedKeys = content.toString("utf8").trim();
  if (!authorizedKeys) return;
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(authorizedKeys)) {
    throw new Error("authorized_keys contains private key material.");
  }
  for (const [index, line] of authorizedKeys.split(/\r?\n/).entries()) {
    if (!/^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.test(line.trim())) {
      throw new Error(`authorized_keys line ${index + 1} is not a supported public key.`);
    }
  }
}

function cidataFile(name: string, content: Buffer): OmarchyCidataFile {
  return { name, content, sha256: createHash("sha256").update(content).digest("hex") };
}

export interface OmarchyLabParams {
  vmid: number;
  name: string;
  operationId: string;
  expectedHostname: string;
  vmStorage: string;
  isoStorage: string;
  bridge: string;
  cpu: number;
  memoryMb: number;
  diskGb: number;
  graphics?: "virtio" | "virtio-gl";
}

function validatedGraphics(value: unknown = OMARCHY_PROXMOX_LAB.display): "virtio" | "virtio-gl" {
  if (value !== "virtio" && value !== "virtio-gl") throw new Error("Invalid --graphics: choose virtio or virtio-gl.");
  return value;
}

function shellQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validToken(value: string, pattern: RegExp, label: string): string {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) throw new Error(`Invalid ${label}: ${value || "(missing)"}`);
  return trimmed;
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const raw = value || "";
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`Invalid ${label}: ${value || "(missing)"}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${label}: ${value || "(missing)"}`);
  return parsed;
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, key)
    || Object.values(record).some((entry) => hasKeyDeep(entry, key));
}

function parseJsonObject(content: Buffer, filename: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${filename} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filename} must contain one JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function buildOmarchyFullDiskConfiguration(params: {
  deferProvisioning: boolean;
  diskDevice: string;
  diskGb: number;
  hostname?: string;
}): string {
  if (!/^\/dev\/(?:sd[a-z]|vd[a-z]|nvme[0-9]+n[0-9]+)$/.test(params.diskDevice)) {
    throw new Error("Omarchy full-disk target must be one whole supported block device.");
  }
  if (!Number.isSafeInteger(params.diskGb) || params.diskGb < OMARCHY_PROXMOX_LAB.minimums.diskGb) {
    throw new Error("Omarchy full-disk configuration requires at least 40 GB.");
  }
  const hostname = params.hostname || "omarchy";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error("Omarchy hostname is invalid.");
  }
  const mib = 1024 * 1024;
  const gib = 1024 * mib;
  const diskBytes = params.diskGb * gib;
  const bootStart = mib;
  const bootSize = 2 * gib;
  const mainStart = bootStart + bootSize;
  const mainSize = diskBytes - mainStart - mib;
  const configuration = {
    app_config: null,
    "archinstall-language": "English",
    auth_config: {},
    audio_config: { audio: "pipewire" },
    bootloader_config: { bootloader: "Limine", uki: false, removable: false },
    custom_commands: [],
    omarchy_install: {
      mode: "full_disk",
      defer_provisioning: params.deferProvisioning,
      target_mount: "/mnt",
      boot: {
        esp_mount: "/boot",
        esp_path: "/EFI/limine",
        efi_binary: "limine_x64.efi",
        enable_fallback: true,
      },
      storage: { kernel: "linux" },
    },
    disk_config: {
      config_type: "default_layout",
      device_modifications: [{
        device: params.diskDevice,
        partitions: [{
          btrfs: [],
          dev_path: null,
          flags: ["boot", "esp"],
          fs_type: "fat32",
          mount_options: [],
          mountpoint: "/boot",
          obj_id: "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d",
          size: { sector_size: { unit: "B", value: 512 }, unit: "B", value: bootSize },
          start: { sector_size: { unit: "B", value: 512 }, unit: "B", value: bootStart },
          status: "create",
          type: "primary",
        }, {
          btrfs: [
            { mountpoint: "/", name: "@" },
            { mountpoint: "/home", name: "@home" },
            { mountpoint: "/var/log", name: "@log" },
            { mountpoint: "/var/cache/pacman/pkg", name: "@pkg" },
          ],
          dev_path: null,
          flags: [],
          fs_type: "btrfs",
          mount_options: ["compress=zstd"],
          mountpoint: null,
          obj_id: "8c2c2b92-1070-455d-b76a-56263bab24aa",
          size: { sector_size: { unit: "B", value: 512 }, unit: "B", value: mainSize },
          start: { sector_size: { unit: "B", value: 512 }, unit: "B", value: mainStart },
          status: "create",
          type: "primary",
        }],
        wipe: true,
      }],
    },
    hostname,
    kernels: ["linux"],
    network_config: { type: "iso" },
    ntp: true,
    parallel_downloads: 8,
    script: null,
    services: ["qemu-guest-agent"],
    swap: true,
    timezone: "UTC",
    locale_config: { kb_layout: "us", sys_enc: "UTF-8", sys_lang: "en_US.UTF-8" },
    mirror_config: {
      custom_repositories: [],
      custom_servers: [
        "https://mirror.omarchy.org/$repo/os/$arch",
        "https://mirror.rackspace.com/archlinux/$repo/os/$arch",
        "https://geo.mirror.pkgbuild.com/$repo/os/$arch",
      ].map((url) => ({ url })),
      mirror_regions: {},
      optional_repositories: [],
    },
    packages: ["base-devel", "git", "qemu-guest-agent", "omarchy-keyring", "omarchy-settings", "omarchy"],
    profile_config: { gfx_driver: null, greeter: null, profile: {} },
    version: "3.0.9",
  };
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

export function buildDeferredOmarchyCidata(params: {
  diskGb: number;
  authorizedKeys?: Buffer;
}): OmarchyCidataFile[] {
  if (params.authorizedKeys) assertAuthorizedKeys(params.authorizedKeys);
  const files = [
    cidataFile("defer-provisioning", Buffer.alloc(0)),
    cidataFile("user_configuration.json", Buffer.from(buildOmarchyFullDiskConfiguration({
      deferProvisioning: true,
      diskDevice: "/dev/sda",
      diskGb: params.diskGb,
      hostname: "omarchy",
    }), "utf8")),
  ];
  if (params.authorizedKeys) files.push(cidataFile("authorized_keys", params.authorizedKeys));
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function assertOfficialCredentials(credentials: Record<string, unknown>): void {
  assertExactKeys(credentials, ["root_enc_password", "users"], "user_credentials.json");
  const users = credentials.users;
  if (!Array.isArray(users) || users.length !== 1 || !users[0] || typeof users[0] !== "object" || Array.isArray(users[0])) {
    throw new Error("user_credentials.json must define exactly one owner.");
  }
  const owner = users[0] as Record<string, unknown>;
  assertExactKeys(owner, ["enc_password", "groups", "sudo", "username"], "user_credentials.json owner");
  const sha512Crypt = /^\$6\$(?:rounds=[1-9][0-9]*\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$/;
  if (typeof credentials.root_enc_password !== "string" || !sha512Crypt.test(credentials.root_enc_password)) {
    throw new Error("user_credentials.json root_enc_password must be a SHA-512 crypt hash.");
  }
  if (typeof owner.enc_password !== "string" || owner.enc_password !== credentials.root_enc_password) {
    throw new Error("user_credentials.json owner and root password hashes must match.");
  }
  if (typeof owner.username !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(owner.username)) {
    throw new Error("user_credentials.json owner username is invalid.");
  }
  if (owner.sudo !== true || !Array.isArray(owner.groups) || owner.groups.some((group) => typeof group !== "string")) {
    throw new Error("user_credentials.json owner must have sudo=true and a string groups list.");
  }
}

export function readAndValidateOmarchyCidata(sourceDirectory: string): OmarchyCidataFile[] {
  const resolved = path.resolve(sourceDirectory);
  if (!statSync(resolved).isDirectory()) throw new Error("The cidata source must be a directory.");
  const names = readdirSync(resolved).sort();
  const unexpected = names.filter((name) => !ALLOWED_CIDATA_FILES.has(name));
  if (unexpected.length > 0) throw new Error(`Unsupported cidata files: ${unexpected.join(", ")}`);
  if (!names.includes("user_configuration.json")) throw new Error("user_configuration.json is required.");

  const hasCredentials = names.includes("user_credentials.json");
  const defersOwner = names.includes("defer-provisioning");
  if (hasCredentials === defersOwner) {
    throw new Error("Provide exactly one of user_credentials.json or defer-provisioning.");
  }

  const files = names.map((name) => {
    const filename = path.join(resolved, name);
    const stats = lstatSync(filename);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`cidata entry must be a regular file: ${name}`);
    if (stats.size > 64 * 1024) throw new Error(`cidata file exceeds 64 KiB: ${name}`);
    if (name === "user_credentials.json" && (stats.mode & 0o077) !== 0) {
      throw new Error("user_credentials.json must not be readable or writable by group or other users.");
    }
    const content = readFileSync(filename);
    return { name, content, sha256: createHash("sha256").update(content).digest("hex") };
  });

  const configuration = parseJsonObject(
    files.find((file) => file.name === "user_configuration.json")!.content,
    "user_configuration.json",
  );
  if (hasKeyDeep(configuration, "disk_encryption")) {
    throw new Error("Encrypted unattended installs are not accepted because cidata would retain a plaintext passphrase.");
  }
  const installation = configuration.omarchy_install;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    throw new Error("user_configuration.json must contain the official omarchy_install object.");
  }
  const installationRecord = installation as Record<string, unknown>;
  if (installationRecord.mode !== "full_disk") {
    throw new Error("Only the official full_disk Omarchy install mode is accepted.");
  }
  if (installationRecord.defer_provisioning !== defersOwner) {
    throw new Error("omarchy_install.defer_provisioning must match the selected owner mode.");
  }
  if (!configuration.disk_config || typeof configuration.disk_config !== "object" || Array.isArray(configuration.disk_config)) {
    throw new Error("user_configuration.json must contain the official disk_config object.");
  }
  if (installationRecord.target_mount !== "/mnt"
    || !installationRecord.boot || typeof installationRecord.boot !== "object" || Array.isArray(installationRecord.boot)
    || !installationRecord.storage || typeof installationRecord.storage !== "object" || Array.isArray(installationRecord.storage)) {
    throw new Error("user_configuration.json must contain the official Omarchy boot and storage handoff.");
  }
  const diskConfig = configuration.disk_config as Record<string, unknown>;
  const modifications = diskConfig.device_modifications;
  if (diskConfig.config_type !== "default_layout" || !Array.isArray(modifications) || modifications.length !== 1
    || !modifications[0] || typeof modifications[0] !== "object" || Array.isArray(modifications[0])) {
    throw new Error("user_configuration.json must contain one official full-disk device layout.");
  }
  const modification = modifications[0] as Record<string, unknown>;
  const partitions = modification.partitions;
  if (modification.wipe !== true || typeof modification.device !== "string"
    || !/^\/dev\/(?:sd[a-z]|vd[a-z]|nvme[0-9]+n[0-9]+)$/.test(modification.device)
    || !Array.isArray(partitions) || partitions.length !== 2) {
    throw new Error("user_configuration.json must contain the official boot and Btrfs partitions.");
  }
  if (typeof configuration.hostname !== "string" || !Array.isArray(configuration.kernels)
    || configuration.kernels.length !== 1 || typeof configuration.kernels[0] !== "string"
    || !Array.isArray(configuration.packages) || !configuration.packages.includes("omarchy")) {
    throw new Error("user_configuration.json must contain the official host, kernel and package configuration.");
  }
  if (hasCredentials) {
    assertOfficialCredentials(
      parseJsonObject(files.find((file) => file.name === "user_credentials.json")!.content, "user_credentials.json"),
    );
  } else if (files.find((file) => file.name === "defer-provisioning")!.content.length !== 0) {
    throw new Error("defer-provisioning must be an empty marker file.");
  }

  const authorizedKeys = files.find((file) => file.name === "authorized_keys")?.content;
  if (authorizedKeys) assertAuthorizedKeys(authorizedKeys);

  return files;
}

function cidataWriteCommands(files: readonly OmarchyCidataFile[]): string {
  return files.map((file) => {
    const base64 = file.content.toString("base64");
    return `printf '%s' ${shellQuote(base64)} | base64 -d > "$CIDATA_DIR/${file.name}"
chmod 0600 "$CIDATA_DIR/${file.name}"`;
  }).join("\n");
}

export function buildOmarchyLabLaunchScript(
  params: OmarchyLabParams,
  files: readonly OmarchyCidataFile[],
): string {
  const graphics = validatedGraphics(params.graphics);
  const cidataFilename = `hivra-omarchy-cidata-${params.vmid}-${params.operationId.slice(0, 8)}.iso`;
  const fileCommands = cidataWriteCommands(files);
  return `#!/usr/bin/env bash
set -euo pipefail

VMID=${shellQuote(params.vmid)}
VM_NAME=${shellQuote(params.name)}
OPERATION_ID=${shellQuote(params.operationId)}
VM_DESCRIPTION="hivra-omarchy-operation:$OPERATION_ID"
EXPECTED_HOSTNAME=${shellQuote(params.expectedHostname)}
VM_STORAGE=${shellQuote(params.vmStorage)}
ISO_STORAGE=${shellQuote(params.isoStorage)}
BRIDGE=${shellQuote(params.bridge)}
CPU=${shellQuote(params.cpu)}
MEMORY_MB=${shellQuote(params.memoryMb)}
DISK_GB=${shellQuote(params.diskGb)}
GRAPHICS=${shellQuote(graphics)}
OMARCHY_ISO_URL=${shellQuote(OMARCHY_PROXMOX_LAB.isoUrl)}
OMARCHY_ISO_SHA256=${shellQuote(OMARCHY_PROXMOX_LAB.isoSha256)}
OMARCHY_ISO_FILENAME=${shellQuote(OMARCHY_PROXMOX_LAB.isoFilename)}
CIDATA_FILENAME=${shellQuote(cidataFilename)}
CLAIM_IDENTITY="$OPERATION_ID|$EXPECTED_HOSTNAME|$VM_NAME|$VM_STORAGE|$ISO_STORAGE|$CIDATA_FILENAME"
CLAIM_DIR=/var/lib/hivra/omarchy-claims
CLAIM_FILE="$CLAIM_DIR/$VMID.claim"
RECEIPT_FILE="/var/lib/hivra/omarchy-receipts/$VMID-$OPERATION_ID.clean"
STAGE_DIR="/run/hivra-omarchy-$VMID-$OPERATION_ID"
CIDATA_DIR="$STAGE_DIR/cidata"
CREATED_VM=0
CIDATA_PATH=""
CIDATA_TMP=""
OMARCHY_ISO_TMP=""

actual_hostname="$(hostname -s)"
if [ "$actual_hostname" != "$EXPECTED_HOSTNAME" ]; then
  echo "HIVRA_OMARCHY_HOST_MISMATCH expected=$EXPECTED_HOSTNAME actual=$actual_hostname" >&2
  exit 2
fi
for command in qm pvesm pvesh curl sha256sum base64 lvs lvremove; do
  command -v "$command" >/dev/null 2>&1 || { echo "HIVRA_OMARCHY_MISSING_COMMAND $command" >&2; exit 5; }
done
if ! command -v genisoimage >/dev/null 2>&1 && ! command -v xorriso >/dev/null 2>&1; then
  echo "HIVRA_OMARCHY_MISSING_COMMAND genisoimage-or-xorriso" >&2
  exit 5
fi
if [ "$GRAPHICS" = virtio-gl ]; then
  # Match the installed Proxmox VirGL prerequisites before claims, downloads,
  # storage allocation, or VM creation. Presence is not renderer acceptance.
  if [ ! -r /usr/lib/x86_64-linux-gnu/libEGL.so.1 ] || [ ! -r /usr/lib/x86_64-linux-gnu/libGL.so.1 ]; then
    echo "HIVRA_OMARCHY_VIRGL_LIBRARIES_MISSING" >&2
    exit 5
  fi
  render_node_available=0
  for render_node in /dev/dri/renderD*; do
    if [ -c "$render_node" ] && [ -r "$render_node" ] && [ -w "$render_node" ]; then
      render_node_available=1
      break
    fi
  done
  if [ "$render_node_available" != 1 ]; then
    echo "HIVRA_OMARCHY_VIRGL_RENDER_NODE_UNAVAILABLE" >&2
    exit 5
  fi
fi

refresh_inventory() {
  if ! QM_INVENTORY="$(qm list 2>/dev/null)"; then
    echo "HIVRA_OMARCHY_QM_INVENTORY_UNKNOWN" >&2
    return 1
  fi
  if printf '%s\n' "$QM_INVENTORY" | awk -v id="$VMID" 'NR > 1 && $1 == id {found=1} END {exit found ? 0 : 1}'; then
    VM_PRESENT=1
  else
    VM_PRESENT=0
  fi
  if ! LV_INVENTORY="$(lvs --noheadings -o vg_name,lv_name 2>/dev/null)"; then
    echo "HIVRA_OMARCHY_LV_INVENTORY_UNKNOWN" >&2
    return 1
  fi
  if printf '%s\n' "$LV_INVENTORY" | awk -v id="$VMID" '$2 ~ ("^vm-" id "-") {found=1} END {exit found ? 0 : 1}'; then
    LV_PRESENT=1
  else
    LV_PRESENT=0
  fi
}

refresh_inventory || exit 3
[ "$VM_PRESENT" = "0" ] || { echo "HIVRA_OMARCHY_VMID_EXISTS $VMID" >&2; exit 3; }
[ "$LV_PRESENT" = "0" ] || { echo "HIVRA_OMARCHY_VMID_HAS_VOLUMES $VMID" >&2; exit 4; }
vm_storage_type="$(pvesm status 2>/dev/null | awk -v name="$VM_STORAGE" '$1 == name && $3 == "active" {print $2; exit}')"
[ "$vm_storage_type" = "lvmthin" ] || {
  echo "HIVRA_OMARCHY_VM_STORAGE_REQUIRES_ACTIVE_LVMTHIN $VM_STORAGE" >&2
  exit 6
}
iso_storage_type="$(pvesm status 2>/dev/null | awk -v name="$ISO_STORAGE" '$1 == name && $3 == "active" {print $2; exit}')"
[ "$iso_storage_type" = "dir" ] || {
  echo "HIVRA_OMARCHY_ISO_STORAGE_REQUIRES_ACTIVE_DIR $ISO_STORAGE" >&2
  exit 6
}
[ -d "/sys/class/net/$BRIDGE/bridge" ] || { echo "HIVRA_OMARCHY_BRIDGE_MISSING $BRIDGE" >&2; exit 7; }

iso_storage_path="$(pvesh get "/storage/$ISO_STORAGE" --output-format yaml | awk '$1 == "path:" {print $2; exit}')"
if [ -z "$iso_storage_path" ] || [ ! -d "$iso_storage_path" ]; then
  echo "HIVRA_OMARCHY_ISO_STORAGE_NOT_DIRECTORY $ISO_STORAGE" >&2
  exit 8
fi
iso_dir="$iso_storage_path/template/iso"
mkdir -p "$iso_dir"
install -d -m 0700 "$CLAIM_DIR"
[ ! -e "$RECEIPT_FILE" ] || { echo "HIVRA_OMARCHY_OPERATION_ALREADY_CLEAN $VMID" >&2; exit 9; }
umask 077
if ! (set -o noclobber; printf '%s\n' "$CLAIM_IDENTITY" > "$CLAIM_FILE") 2>/dev/null; then
  echo "HIVRA_OMARCHY_CLAIM_EXISTS $VMID" >&2
  exit 9
fi

vm_owned_by_operation() {
  config="$(qm config "$VMID" 2>/dev/null)" || return 1
  printf '%s\n' "$config" | grep -Fxq "name: $VM_NAME" || return 1
  printf '%s\n' "$config" | grep -Fxq "description: hivra-omarchy-operation%3A$OPERATION_ID" || return 1
  printf '%s\n' "$config" | grep -Fq "efidisk0: $VM_STORAGE:" || return 1
  printf '%s\n' "$config" | grep -Fq "scsi0: $VM_STORAGE:" || return 1
  printf '%s\n' "$config" | grep -Fq "ide3: $ISO_STORAGE:iso/$CIDATA_FILENAME,"
}

cleanup_failure() {
  status="$?"
  set +e
  [ -n "$CIDATA_TMP" ] && rm -f "$CIDATA_TMP"
  [ -n "$OMARCHY_ISO_TMP" ] && rm -f "$OMARCHY_ISO_TMP"
  case "$STAGE_DIR" in /run/hivra-omarchy-*) rm -rf "$STAGE_DIR" ;; esac
  if [ "$status" != "0" ] && [ "$(cat "$CLAIM_FILE" 2>/dev/null || true)" = "$CLAIM_IDENTITY" ]; then
    inventory_known=0
    owned_for_cleanup=0
    refresh_inventory && inventory_known=1
    if [ "$inventory_known" = "1" ] && [ "$CREATED_VM" = "1" ] && [ "$VM_PRESENT" = "1" ] && vm_owned_by_operation; then
      owned_for_cleanup=1
      if ! printf '%s\n' "$config" | grep -q '^lock:'; then
        qm stop "$VMID" >/dev/null 2>&1 || true
        qm destroy "$VMID" --purge 1 >/dev/null 2>&1 || true
      fi
    fi
    if [ "$inventory_known" = "1" ]; then
      refresh_inventory && inventory_known=1 || inventory_known=0
    fi
    if [ "$inventory_known" = "1" ] && [ "$owned_for_cleanup" = "1" ] && [ "$VM_PRESENT" = "0" ] && [ "$LV_PRESENT" = "1" ]; then
      printf '%s\n' "$LV_INVENTORY" | awk -v id="$VMID" '$2 ~ ("^vm-" id "-") {print $1 "/" $2}' | while read -r lvpath; do
        [ -n "$lvpath" ] && lvremove -f "$lvpath" >/dev/null 2>&1 || true
      done || true
      refresh_inventory && inventory_known=1 || inventory_known=0
    fi
    if [ "$inventory_known" != "1" ]; then
      echo "HIVRA_OMARCHY_FAILURE_INVENTORY_UNKNOWN $VMID" >&2
    elif [ "$VM_PRESENT" = "1" ] || [ "$LV_PRESENT" = "1" ]; then
      echo "HIVRA_OMARCHY_FAILURE_CLEANUP_INCOMPLETE $VMID" >&2
    else
      [ -n "$CIDATA_PATH" ] && rm -f "$CIDATA_PATH"
      secrets_survive=0
      [ -z "$CIDATA_PATH" ] || [ ! -e "$CIDATA_PATH" ] || secrets_survive=1
      [ -z "$CIDATA_TMP" ] || [ ! -e "$CIDATA_TMP" ] || secrets_survive=1
      [ ! -e "$STAGE_DIR" ] || secrets_survive=1
      if [ "$secrets_survive" = "0" ]; then
        rm -f "$CLAIM_FILE"
      else
        echo "HIVRA_OMARCHY_FAILURE_SECRET_CLEANUP_INCOMPLETE $VMID" >&2
      fi
    fi
  fi
  exit "$status"
}
trap cleanup_failure EXIT

omarchy_iso_path="$iso_dir/$OMARCHY_ISO_FILENAME"
if [ -f "$omarchy_iso_path" ]; then
  printf '%s  %s\n' "$OMARCHY_ISO_SHA256" "$omarchy_iso_path" | sha256sum --check --status || {
    echo "HIVRA_OMARCHY_ISO_CHECKSUM_MISMATCH $omarchy_iso_path" >&2
    exit 10
  }
else
  OMARCHY_ISO_TMP="$iso_dir/.$OMARCHY_ISO_FILENAME.$OPERATION_ID.tmp"
  rm -f "$OMARCHY_ISO_TMP"
  curl --fail --location --proto '=https' --tlsv1.2 --output "$OMARCHY_ISO_TMP" "$OMARCHY_ISO_URL"
  printf '%s  %s\n' "$OMARCHY_ISO_SHA256" "$OMARCHY_ISO_TMP" | sha256sum --check --status || {
    rm -f "$OMARCHY_ISO_TMP"
    echo "HIVRA_OMARCHY_ISO_CHECKSUM_MISMATCH downloaded" >&2
    exit 10
  }
  chmod 0644 "$OMARCHY_ISO_TMP"
  mv -f "$OMARCHY_ISO_TMP" "$omarchy_iso_path"
  OMARCHY_ISO_TMP=""
fi

mkdir -p "$CIDATA_DIR"
chmod 0700 "$STAGE_DIR" "$CIDATA_DIR"
${fileCommands}
CIDATA_PATH="$iso_dir/$CIDATA_FILENAME"
CIDATA_TMP="$iso_dir/.$CIDATA_FILENAME.$OPERATION_ID.tmp"
rm -f "$CIDATA_TMP"
if command -v genisoimage >/dev/null 2>&1; then
  genisoimage -quiet -output "$CIDATA_TMP" -volid cidata -joliet -rock "$CIDATA_DIR"
else
  xorriso -as mkisofs -quiet -output "$CIDATA_TMP" -volid cidata -joliet -rock "$CIDATA_DIR"
fi
chmod 0600 "$CIDATA_TMP"
mv -f "$CIDATA_TMP" "$CIDATA_PATH"
CIDATA_TMP=""

CREATED_VM=1
qm create "$VMID" --name "$VM_NAME" \
  --description "$VM_DESCRIPTION" \
  --bios ovmf --machine q35 --cpu host --cores "$CPU" --memory "$MEMORY_MB" \
  --ostype l26 --scsihw virtio-scsi-single \
  --agent enabled=1 \
  --efidisk0 "$VM_STORAGE:0,efitype=4m,pre-enrolled-keys=0" \
  --scsi0 "$VM_STORAGE:$DISK_GB,discard=on,iothread=1" \
  --net0 "virtio,bridge=$BRIDGE" --vga "$GRAPHICS" --serial0 socket \
  --ide2 "$ISO_STORAGE:iso/$OMARCHY_ISO_FILENAME,media=cdrom" \
  --ide3 "$ISO_STORAGE:iso/$CIDATA_FILENAME,media=cdrom" \
  --boot 'order=scsi0;ide2'
qm start "$VMID"

rm -rf "$STAGE_DIR"
trap - EXIT
printf 'HIVRA_OMARCHY_LAB_STARTED {"vmid":%s,"operationId":"%s","hostname":"%s","release":"%s","isoSha256":"%s","cidataRef":"%s"}\n' \
  "$VMID" "$OPERATION_ID" "$actual_hostname" ${shellQuote(OMARCHY_PROXMOX_LAB.release)} "$OMARCHY_ISO_SHA256" "$ISO_STORAGE:iso/$CIDATA_FILENAME"
`;
}

export function buildOmarchyLabTeardownScript(params: Pick<OmarchyLabParams, "vmid" | "name" | "operationId" | "expectedHostname" | "vmStorage" | "isoStorage">): string {
  const cidataFilename = `hivra-omarchy-cidata-${params.vmid}-${params.operationId.slice(0, 8)}.iso`;
  return `#!/usr/bin/env bash
set -euo pipefail
VMID=${shellQuote(params.vmid)}
VM_NAME=${shellQuote(params.name)}
OPERATION_ID=${shellQuote(params.operationId)}
VM_DESCRIPTION="hivra-omarchy-operation:$OPERATION_ID"
EXPECTED_HOSTNAME=${shellQuote(params.expectedHostname)}
VM_STORAGE=${shellQuote(params.vmStorage)}
ISO_STORAGE=${shellQuote(params.isoStorage)}
CIDATA_FILENAME=${shellQuote(cidataFilename)}
CLAIM_IDENTITY="$OPERATION_ID|$EXPECTED_HOSTNAME|$VM_NAME|$VM_STORAGE|$ISO_STORAGE|$CIDATA_FILENAME"
CLAIM_FILE="/var/lib/hivra/omarchy-claims/$VMID.claim"
RECEIPT_DIR=/var/lib/hivra/omarchy-receipts
RECEIPT_FILE="$RECEIPT_DIR/$VMID-$OPERATION_ID.clean"
actual_hostname="$(hostname -s)"
[ "$actual_hostname" = "$EXPECTED_HOSTNAME" ] || { echo "HIVRA_OMARCHY_HOST_MISMATCH" >&2; exit 2; }
for command in qm pvesm pvesh lvs lvremove; do
  command -v "$command" >/dev/null 2>&1 || { echo "HIVRA_OMARCHY_MISSING_COMMAND $command" >&2; exit 3; }
done
vm_storage_type="$(pvesm status 2>/dev/null | awk -v name="$VM_STORAGE" '$1 == name && $3 == "active" {print $2; exit}')"
[ "$vm_storage_type" = "lvmthin" ] || { echo "HIVRA_OMARCHY_VM_STORAGE_REQUIRES_ACTIVE_LVMTHIN" >&2; exit 4; }
iso_storage_type="$(pvesm status 2>/dev/null | awk -v name="$ISO_STORAGE" '$1 == name && $3 == "active" {print $2; exit}')"
[ "$iso_storage_type" = "dir" ] || { echo "HIVRA_OMARCHY_ISO_STORAGE_REQUIRES_ACTIVE_DIR" >&2; exit 4; }
iso_storage_path="$(pvesh get "/storage/$ISO_STORAGE" --output-format yaml | awk '$1 == "path:" {print $2; exit}')"
[ -n "$iso_storage_path" ] && [ -d "$iso_storage_path" ] || { echo "HIVRA_OMARCHY_ISO_STORAGE_NOT_DIRECTORY" >&2; exit 4; }
CIDATA_PATH="$iso_storage_path/template/iso/$CIDATA_FILENAME"

refresh_inventory() {
  if ! QM_INVENTORY="$(qm list 2>/dev/null)"; then
    echo "HIVRA_OMARCHY_QM_INVENTORY_UNKNOWN" >&2
    return 1
  fi
  if printf '%s\n' "$QM_INVENTORY" | awk -v id="$VMID" 'NR > 1 && $1 == id {found=1} END {exit found ? 0 : 1}'; then
    VM_PRESENT=1
  else
    VM_PRESENT=0
  fi
  if ! LV_INVENTORY="$(lvs --noheadings -o vg_name,lv_name 2>/dev/null)"; then
    echo "HIVRA_OMARCHY_LV_INVENTORY_UNKNOWN" >&2
    return 1
  fi
  if printf '%s\n' "$LV_INVENTORY" | awk -v id="$VMID" '$2 ~ ("^vm-" id "-") {found=1} END {exit found ? 0 : 1}'; then
    LV_PRESENT=1
  else
    LV_PRESENT=0
  fi
}

verify_absence() {
  refresh_inventory || return 1
  if [ "$VM_PRESENT" = "1" ]; then echo "HIVRA_OMARCHY_TEARDOWN_VM_SURVIVES" >&2; return 1; fi
  if [ "$LV_PRESENT" = "1" ]; then echo "HIVRA_OMARCHY_TEARDOWN_VOLUME_SURVIVES" >&2; return 1; fi
  if [ -e "$CIDATA_PATH" ]; then echo "HIVRA_OMARCHY_TEARDOWN_CIDATA_SURVIVES" >&2; return 1; fi
}

if [ -e "$RECEIPT_FILE" ]; then
  [ "$(cat "$RECEIPT_FILE" 2>/dev/null || true)" = "$CLAIM_IDENTITY" ] || { echo "HIVRA_OMARCHY_RECEIPT_MISMATCH" >&2; exit 5; }
  verify_absence || exit 6
  current_claim="$(cat "$CLAIM_FILE" 2>/dev/null || true)"
  [ -z "$current_claim" ] || [ "$current_claim" = "$CLAIM_IDENTITY" ] || { echo "HIVRA_OMARCHY_CLAIM_MISMATCH" >&2; exit 7; }
  [ -z "$current_claim" ] || rm -f "$CLAIM_FILE"
  printf 'HIVRA_OMARCHY_LAB_CLEAN {"vmid":%s,"operationId":"%s","survives":false}\n' "$VMID" "$OPERATION_ID"
  exit 0
fi

[ "$(cat "$CLAIM_FILE" 2>/dev/null || true)" = "$CLAIM_IDENTITY" ] || { echo "HIVRA_OMARCHY_CLAIM_MISMATCH" >&2; exit 7; }
refresh_inventory || { echo "HIVRA_OMARCHY_TEARDOWN_INVENTORY_UNKNOWN" >&2; exit 8; }
if [ "$VM_PRESENT" = "1" ]; then
  config="$(qm config "$VMID" 2>/dev/null)"
  printf '%s\n' "$config" | grep -Fxq "name: $VM_NAME" || { echo "HIVRA_OMARCHY_VM_IDENTITY_MISMATCH" >&2; exit 8; }
  printf '%s\n' "$config" | grep -Fxq "description: hivra-omarchy-operation%3A$OPERATION_ID" || { echo "HIVRA_OMARCHY_VM_IDENTITY_MISMATCH" >&2; exit 8; }
  printf '%s\n' "$config" | grep -Fq "efidisk0: $VM_STORAGE:" || { echo "HIVRA_OMARCHY_VM_STORAGE_MISMATCH" >&2; exit 8; }
  printf '%s\n' "$config" | grep -Fq "scsi0: $VM_STORAGE:" || { echo "HIVRA_OMARCHY_VM_STORAGE_MISMATCH" >&2; exit 8; }
  printf '%s\n' "$config" | grep -Fq "ide3: $ISO_STORAGE:iso/$CIDATA_FILENAME," || { echo "HIVRA_OMARCHY_CIDATA_IDENTITY_MISMATCH" >&2; exit 8; }
  printf '%s\n' "$config" | grep -q '^lock:' && { echo "HIVRA_OMARCHY_VM_LOCKED" >&2; exit 9; }
  qm stop "$VMID" >/dev/null 2>&1 || true
  qm destroy "$VMID" --purge 1
  refresh_inventory || { echo "HIVRA_OMARCHY_TEARDOWN_INVENTORY_UNKNOWN" >&2; exit 10; }
  [ "$VM_PRESENT" = "0" ] || { echo "HIVRA_OMARCHY_TEARDOWN_VM_SURVIVES" >&2; exit 10; }
  printf '%s\n' "$LV_INVENTORY" | awk -v id="$VMID" '$2 ~ ("^vm-" id "-") {print $1 "/" $2}' | while read -r lvpath; do
    [ -n "$lvpath" ] && lvremove -f "$lvpath"
  done
elif [ "$LV_PRESENT" = "1" ]; then
  echo "HIVRA_OMARCHY_ORPHAN_VOLUME_REQUIRES_OPERATOR_REVIEW" >&2
  exit 10
fi
rm -f "$CIDATA_PATH"
verify_absence || exit 11
install -d -m 0700 "$RECEIPT_DIR"
umask 077
receipt_tmp="$RECEIPT_DIR/.$VMID-$OPERATION_ID.$$.tmp"
printf '%s\n' "$CLAIM_IDENTITY" > "$receipt_tmp"
mv -n "$receipt_tmp" "$RECEIPT_FILE"
rm -f "$receipt_tmp"
[ "$(cat "$RECEIPT_FILE" 2>/dev/null || true)" = "$CLAIM_IDENTITY" ] || { echo "HIVRA_OMARCHY_RECEIPT_WRITE_FAILED" >&2; exit 12; }
rm -f "$CLAIM_FILE"
[ ! -e "$CLAIM_FILE" ] || { echo "HIVRA_OMARCHY_TEARDOWN_CLAIM_SURVIVES" >&2; exit 13; }
printf 'HIVRA_OMARCHY_LAB_CLEAN {"vmid":%s,"operationId":"%s","survives":false}\n' "$VMID" "$OPERATION_ID"
`;
}

interface CliArgs extends OmarchyLabParams {
  target: string;
  sourceDirectory: string | null;
  authorizedKeyFile: string | null;
  deferProvisioning: boolean;
  apply: boolean;
  teardown: boolean;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function assertOmarchyLabTargetAuthorized(
  targetId: string,
  env: Record<string, string | undefined>,
  vmid?: number,
): void {
  const allowedTargets = (env.HIVRA_OMARCHY_LAB_TARGETS || "")
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedTargets.includes(targetId.toLowerCase())) {
    throw new Error(`Proxmox target ${targetId} is not authorized by HIVRA_OMARCHY_LAB_TARGETS.`);
  }
  const mode = (env.PROXMOX_EXEC_MODE || "ssh").trim().toLowerCase();
  if (mode === "local") {
    if (env.HIVRA_OMARCHY_LAB_ALLOW_LOCAL !== "true") {
      throw new Error("Local Omarchy lab execution requires HIVRA_OMARCHY_LAB_ALLOW_LOCAL=true.");
    }
  } else if (mode === "ssh") {
    if (!env.PROXMOX_SSH_HOST_FINGERPRINT?.trim()) {
      throw new Error("Omarchy lab SSH execution requires a pinned PROXMOX_SSH_HOST_FINGERPRINT.");
    }
  } else {
    throw new Error(`Unsupported Omarchy lab execution mode: ${mode || "(missing)"}.`);
  }
  if (vmid !== undefined) {
    const targetKey = targetId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const startKey = `HIVRA_OMARCHY_LAB_TARGET_${targetKey}_VMID_START`;
    const endKey = `HIVRA_OMARCHY_LAB_TARGET_${targetKey}_VMID_END`;
    const start = parsePositiveInt(env[startKey], startKey);
    const end = parsePositiveInt(env[endKey], endKey);
    if (start > end || vmid < start || vmid > end) {
      throw new Error(`VMID ${vmid} is outside the authorized target range ${start}-${end}.`);
    }
  }
}

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const apply = argv.includes("--apply");
  const teardown = argv.includes("--teardown");
  if (apply && teardown) throw new Error("Choose either --apply or --teardown.");
  const operationId = valueAfter(argv, "--operation-id") || randomUUID();
  validToken(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "--operation-id");
  const vmid = parsePositiveInt(valueAfter(argv, "--vmid"), "--vmid");
  if (vmid < 100 || vmid > 999_999_999) throw new Error(`Invalid --vmid: ${vmid}`);
  if (argv.filter((arg) => arg === "--graphics").length > 1
    || (argv.includes("--graphics") && valueAfter(argv, "--graphics") === undefined)) {
    throw new Error("Invalid --graphics: choose virtio or virtio-gl.");
  }
  return {
    vmid,
    name: validToken(valueAfter(argv, "--name") || "", /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/, "--name"),
    operationId,
    expectedHostname: validToken(valueAfter(argv, "--expected-hostname") || "", /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/, "--expected-hostname"),
    vmStorage: validToken(valueAfter(argv, "--storage") || "", /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, "--storage"),
    isoStorage: validToken(valueAfter(argv, "--iso-storage") || "", /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/, "--iso-storage"),
    bridge: validToken(valueAfter(argv, "--bridge") || "", /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/, "--bridge"),
    cpu: parsePositiveInt(valueAfter(argv, "--cpu") || String(OMARCHY_PROXMOX_LAB.minimums.cpu), "--cpu"),
    memoryMb: parsePositiveInt(valueAfter(argv, "--memory-mb") || String(OMARCHY_PROXMOX_LAB.minimums.memoryMb), "--memory-mb"),
    diskGb: parsePositiveInt(valueAfter(argv, "--disk-gb") || String(OMARCHY_PROXMOX_LAB.minimums.diskGb), "--disk-gb"),
    graphics: validatedGraphics(valueAfter(argv, "--graphics")),
    target: validToken(valueAfter(argv, "--target") || "", /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "--target"),
    sourceDirectory: valueAfter(argv, "--source-dir") || null,
    authorizedKeyFile: valueAfter(argv, "--authorized-key-file") || null,
    deferProvisioning: argv.includes("--defer-provisioning"),
    apply,
    teardown,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.cpu < OMARCHY_PROXMOX_LAB.minimums.cpu) throw new Error("Omarchy requires at least 4 vCPU.");
  if (args.memoryMb < OMARCHY_PROXMOX_LAB.minimums.memoryMb) throw new Error("Omarchy requires at least 8192 MB RAM.");
  if (args.diskGb < OMARCHY_PROXMOX_LAB.minimums.diskGb) throw new Error("Omarchy requires at least 40 GB disk.");

  const target = resolveProxmoxTargetConfiguration(process.env, args.target);
  const params: OmarchyLabParams = args;
  let script: string;
  let files: OmarchyCidataFile[] = [];
  if (args.teardown) {
    script = buildOmarchyLabTeardownScript(params);
  } else {
    if (args.sourceDirectory && args.deferProvisioning) {
      throw new Error("Choose either --source-dir or --defer-provisioning.");
    }
    if (args.authorizedKeyFile && !args.deferProvisioning) {
      throw new Error("--authorized-key-file requires --defer-provisioning.");
    }
    if (args.deferProvisioning) {
      let authorizedKeys: Buffer | undefined;
      if (args.authorizedKeyFile) {
        const stats = lstatSync(args.authorizedKeyFile);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
          throw new Error("--authorized-key-file must be a regular public-key file no larger than 64 KiB.");
        }
        authorizedKeys = readFileSync(args.authorizedKeyFile);
      }
      files = buildDeferredOmarchyCidata({ diskGb: args.diskGb, authorizedKeys });
    } else {
      if (!args.sourceDirectory) throw new Error("--source-dir or --defer-provisioning is required for planning and launch.");
      files = readAndValidateOmarchyCidata(args.sourceDirectory);
    }
    script = buildOmarchyLabLaunchScript(params, files);
  }

  if (!args.apply && !args.teardown) {
    console.log(JSON.stringify({
      mode: "plan",
      target: args.target,
      expectedHostname: args.expectedHostname,
      vmid: args.vmid,
      operationId: args.operationId,
      release: OMARCHY_PROXMOX_LAB.release,
      isoSha256: OMARCHY_PROXMOX_LAB.isoSha256,
      resources: { cpu: args.cpu, memoryMb: args.memoryMb, diskGb: args.diskGb },
      machine: { bios: "ovmf", machine: "q35", display: args.graphics },
      cidata: files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.content.length })),
      protections: [
        "lab-target allowlist and pinned SSH host identity",
        "exact hostname and authorized VMID range",
        "empty VMID and LV set",
        "atomic persistent claim plus exact VM metadata",
        "active lvmthin and directory-backed storage",
        "authoritative VM/LV inventory; unknown fails closed",
        "checksum-pinned ISO",
        "lock-respecting teardown with durable cleanup receipt",
      ],
    }, null, 2));
    return;
  }

  if (!isProxmoxProvisioningConfigured(target.env)) {
    throw new Error(`Proxmox target ${args.target} is not fully configured.`);
  }
  assertOmarchyLabTargetAuthorized(args.target, target.env, args.vmid);
  const result = await runProxmoxHostScript(script, target.env, {
    timeoutMs: args.teardown ? 5 * 60_000 : 90 * 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (!result.ok) throw new Error(result.stderr || result.error || "Omarchy Proxmox operation failed.");
  console.log(result.stdout.trim());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
