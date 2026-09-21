import "server-only";

import { Buffer } from "node:buffer";
import { z } from "zod";

import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";

const MARKER = "HIVRA_WINDOWS_RDP_ACCOUNT_REVOKED_V1 ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IPV4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/;
const USERNAME = /^hivra-[0-9a-f]{14}$/;

function privateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  return octets.length === 4 && octets.every(value => value >= 0 && value <= 255)
    && (octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168));
}

const Request = z.object({
  computerId: z.string().regex(UUID),
  sessionId: z.string().regex(UUID),
  activationId: z.string().regex(UUID),
  capabilityGeneration: z.string().regex(UUID),
  vmid: z.number().int().min(100),
  guestPrivateIpv4: z.string().regex(IPV4).refine(privateIpv4),
  guestBootIdentitySha256: z.string().regex(SHA256),
  username: z.string().regex(USERNAME),
}).strict();

export type WindowsRdpAccountRevocationRequest = z.infer<typeof Request>;

export const WINDOWS_RDP_ACCOUNT_REVOCATION_PROGRAM = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Fail([string]$Code) {
  [Console]::Error.WriteLine('HIVRA_WINDOWS_RDP_ACCOUNT_FAILURE ' + $Code)
  exit 1
}
function HashText([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
try {
  $raw = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 8192) { Fail 'input_too_large' }
  $request = $raw | ConvertFrom-Json
  $expectedNames = @('computerId','sessionId','activationId','capabilityGeneration','vmid','guestPrivateIpv4','guestBootIdentitySha256','username')
  if ($null -eq $request -or @($request.PSObject.Properties.Name).Count -ne $expectedNames.Count) { Fail 'input_shape' }
  foreach ($name in $expectedNames) { if ($null -eq $request.PSObject.Properties[$name]) { Fail 'input_shape' } }
  foreach ($name in @('computerId','sessionId','activationId','capabilityGeneration')) {
    if ([string]$request.$name -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { Fail 'binding_invalid' }
  }
  if ([int]$request.vmid -lt 100 -or [string]$request.guestBootIdentitySha256 -cnotmatch '^[a-f0-9]{64}$') { Fail 'binding_invalid' }
  $expectedUsername = 'hivra-' + ([string]$request.sessionId).Replace('-','').Substring(0,14)
  if ([string]$request.username -cne $expectedUsername -or [string]$request.username -cnotmatch '^hivra-[0-9a-f]{14}$') { Fail 'username_invalid' }

  $expectedIp = [Net.IPAddress]::Parse([string]$request.guestPrivateIpv4)
  if ($expectedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { Fail 'guest_ip_invalid' }
  $octets = $expectedIp.GetAddressBytes()
  if (-not ($octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168))) { Fail 'guest_ip_public' }
  $observedIps = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop | Where-Object { $_.IPAddress -eq $expectedIp.ToString() })
  if ($observedIps.Count -ne 1) { Fail 'guest_ip_mismatch' }

  $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  $machineGuid = [string](Get-ItemPropertyValue -Path 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop)
  if ($machineGuid -notmatch '^[0-9a-fA-F-]{32,36}$') { Fail 'machine_identity_invalid' }
  $lastBoot = ([DateTime]$os.LastBootUpTime).ToUniversalTime()
  $machineIdentitySha256 = HashText($machineGuid.ToLowerInvariant())
  $bootIdentitySha256 = HashText($machineIdentitySha256 + [Environment]::NewLine + $lastBoot.ToString('O'))
  if ($bootIdentitySha256 -cne [string]$request.guestBootIdentitySha256) { Fail 'guest_boot_changed' }

  $description = 'Hivra RDP activation ' + [string]$request.activationId + ' boot ' + $bootIdentitySha256
  $existing = @(Get-LocalUser -Name $expectedUsername -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 1 -or ($existing.Count -eq 1 -and [string]$existing[0].Description -cne $description)) { Fail 'account_conflict' }
  $removed = $false
  if ($existing.Count -eq 1) {
    $user = $existing[0]
    $administrators = Get-LocalGroup -SID 'S-1-5-32-544' -ErrorAction Stop
    $adminMembers = @($administrators | Get-LocalGroupMember -ErrorAction Stop | Where-Object { [string]$_.SID -eq [string]$user.SID })
    if ($adminMembers.Count -ne 0) { Fail 'account_is_administrator' }
    Disable-LocalUser -Name $expectedUsername -ErrorAction Stop
    $remoteDesktop = Get-LocalGroup -SID 'S-1-5-32-555' -ErrorAction Stop
    $remoteMembers = @($remoteDesktop | Get-LocalGroupMember -ErrorAction Stop | Where-Object { [string]$_.SID -eq [string]$user.SID })
    if ($remoteMembers.Count -gt 1) { Fail 'rdp_membership_invalid' }
    if ($remoteMembers.Count -eq 1) { Remove-LocalGroupMember -SID 'S-1-5-32-555' -Member $user -Confirm:$false -ErrorAction Stop }
    Remove-LocalUser -Name $expectedUsername -Confirm:$false -ErrorAction Stop
    $removed = $true
  }
  if (@(Get-LocalUser -Name $expectedUsername -ErrorAction SilentlyContinue).Count -ne 0) { Fail 'account_removal_unproven' }

  $result = [ordered]@{
    protocol = 'hivra-windows-rdp-account-revoked-v1'
    computerId = [string]$request.computerId
    sessionId = [string]$request.sessionId
    activationId = [string]$request.activationId
    capabilityGeneration = [string]$request.capabilityGeneration
    vmid = [int]$request.vmid
    guestPrivateIpv4 = $expectedIp.ToString()
    guestBootIdentitySha256 = $bootIdentitySha256
    username = $expectedUsername
    accountRemoved = [bool]$removed
    credentialReady = $false
  }
  [Console]::Out.WriteLine('${MARKER}' + ($result | ConvertTo-Json -Compress -Depth 3))
} catch {
  [Console]::Error.WriteLine('HIVRA_WINDOWS_RDP_ACCOUNT_FAILURE revocation_failed')
  exit 1
}`;

export function buildWindowsRdpAccountRevocationBundle(
  input: WindowsRdpAccountRevocationRequest,
  infrastructureBindingTag: string,
): { script: string; stdin: string } {
  const request = Request.safeParse(input);
  if (!request.success || !/^hivra-bind-[a-f0-9]{32}$/.test(infrastructureBindingTag)) {
    throw new Error("Invalid Windows RDP account revocation.");
  }
  const encodedProgram = Buffer.from(WINDOWS_RDP_ACCOUNT_REVOCATION_PROGRAM, "utf16le").toString("base64");
  const script = `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${request.data.vmid}
GUEST_IP=${shellQuote(request.data.guestPrivateIpv4)}
EXPECTED_BINDING_TAG=${shellQuote(infrastructureBindingTag)}
qm() { command timeout --kill-after=5 20 qm "$@"; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout --kill-after=5 70 qm "$@"; }
run_vmid_bound_guest_exec_stdin powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${shellQuote(encodedProgram)}
`;
  return { script, stdin: JSON.stringify(request.data) };
}

export function parseWindowsRdpAccountRevocationReceipt(
  stdout: string,
  expected: WindowsRdpAccountRevocationRequest,
): { username: string; accountRemoved: boolean; credentialReady: false } | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) return null;
  let value: unknown;
  try { value = JSON.parse(lines[0].slice(MARKER.length)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 11
    && row.protocol === "hivra-windows-rdp-account-revoked-v1"
    && row.computerId === expected.computerId && row.sessionId === expected.sessionId
    && row.activationId === expected.activationId && row.capabilityGeneration === expected.capabilityGeneration
    && row.vmid === expected.vmid && row.guestPrivateIpv4 === expected.guestPrivateIpv4
    && row.guestBootIdentitySha256 === expected.guestBootIdentitySha256
    && row.username === expected.username && typeof row.accountRemoved === "boolean"
    && row.credentialReady === false
    ? { username: expected.username, accountRemoved: row.accountRemoved, credentialReady: false }
    : null;
}

