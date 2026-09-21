import "server-only";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";

import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { shellQuote } from "@/lib/hivra/proxmox-target";

export const WINDOWS_RDP_PREPARED_MARKER = "HIVRA_WINDOWS_RDP_PREPARED_V1 ";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPV4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/;
const IPV4_SOURCE_CIDR = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const SHA256 = /^[a-f0-9]{64}$/;

// This program is deliberately read-only. Enabling RDP, creating credentials,
// and adding the scoped firewall rule belong to a separate, auditable guest
// preparation operation. Inspection alone cannot make Windows launchable.
const POWERSHELL_INSPECTION_PROGRAM = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
function Fail([string]$Code) {
  [Console]::Error.WriteLine('HIVRA_CAPABILITY_FAILURE ' + $Code)
  exit 1
}
function HashText([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','')).ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function HashBytes([byte[]]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Value)).Replace('-','')).ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function PrivateCidr([string]$Value) {
  # Windows normalizes a single-host RemoteAddress such as 10.240.20.1/32
  # back to 10.240.20.1 when the firewall filter is read.
  if ($Value -match '^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$') { $Value = $Value + '/32' }
  if ($Value -notmatch '^(?<ip>(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3})/(?<prefix>[0-9]|[12][0-9]|3[0-2])$') { Fail 'firewall_source_invalid' }
  $parts = $Matches.ip.Split('.') | ForEach-Object { [int]$_ }
  if (@($parts | Where-Object { $_ -gt 255 }).Count -ne 0) { Fail 'firewall_source_invalid' }
  $prefix = [int]$Matches.prefix
  $private = $parts[0] -eq 10 -and $prefix -ge 8
  $private = $private -or ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31 -and $prefix -ge 12)
  $private = $private -or ($parts[0] -eq 192 -and $parts[1] -eq 168 -and $prefix -ge 16)
  if (-not $private) { Fail 'firewall_source_public' }
  $address = [uint32](($parts[0] -shl 24) -bor ($parts[1] -shl 16) -bor ($parts[2] -shl 8) -bor $parts[3])
  $mask = if ($prefix -eq 0) { [uint32]0 } else { [uint32]::MaxValue -shl (32 - $prefix) }
  if (($address -band $mask) -ne $address) { Fail 'firewall_source_noncanonical' }
  return $Value
}
function PortIncludesRdp([string]$Value) {
  foreach ($candidate in @($Value -split ',' | ForEach-Object { $_.Trim() })) {
    if ($candidate -eq '3389' -or $candidate -eq 'Any') { return $true }
    if ($candidate -match '^(?<first>[0-9]+)-(?<last>[0-9]+)$' -and
        [int]$Matches.first -le 3389 -and [int]$Matches.last -ge 3389) { return $true }
  }
  return $false
}
function CouldMatchTermService($Rule) {
  # App-container capability rules are bound to an owning package identity.
  # Their apparent Program=Any/LocalPort=Any filters cannot be used by the
  # system TermService process.
  if (-not [string]::IsNullOrWhiteSpace([string]$Rule.Owner)) { return $false }
  $services = @($Rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
  $applications = @($Rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  if ($services.Count -ne 1 -or $applications.Count -ne 1) { return $true }
  $service = [string]$services[0].Service
  $program = [string]$applications[0].Program
  return ($service -eq 'Any' -or $service -eq 'TermService') -and
    ($program -eq 'Any' -or $program -match '(?i)(^|\\|/)svchost\.exe$')
}
try {
  $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__HIVRA_EXPECTED_BASE64__')) | ConvertFrom-Json
  if ($null -eq $expected -or @($expected.PSObject.Properties.Name).Count -ne 4) { Fail 'inspection_input_shape' }
  foreach ($name in @('computerId','vmid','guestPrivateIpv4','inspectionRevision')) {
    if ($null -eq $expected.PSObject.Properties[$name]) { Fail 'inspection_input_shape' }
  }
  if ([string]$expected.computerId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { Fail 'computer_identity_invalid' }
  if ([int]$expected.vmid -lt 100) { Fail 'vm_identity_invalid' }
  $expectedIp = [Net.IPAddress]::Parse([string]$expected.guestPrivateIpv4)
  if ($expectedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { Fail 'guest_ip_invalid' }
  $octets = $expectedIp.GetAddressBytes()
  $privateIp = $octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168)
  if (-not $privateIp) { Fail 'guest_ip_not_private' }
  $observedIps = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop | Where-Object { $_.IPAddress -eq $expectedIp.ToString() })
  if ($observedIps.Count -ne 1) { Fail 'guest_ip_mismatch' }

  $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
  if ([int]$os.ProductType -ne 1 -or [string]::IsNullOrWhiteSpace([string]$os.Caption)) { Fail 'windows_workstation_invalid' }
  if ([string]$os.Version -notmatch '^10\.0\.[0-9]+(?:\.[0-9]+)?$' -or [string]$os.BuildNumber -notmatch '^[0-9]{4,6}$') { Fail 'windows_version_invalid' }
  $licensed = @(Get-CimInstance -ClassName SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" -ErrorAction Stop | Where-Object { [int]$_.LicenseStatus -eq 1 })
  if ($licensed.Count -lt 1) { Fail 'windows_not_licensed' }

  $machineGuid = [string](Get-ItemPropertyValue -Path 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop)
  if ($machineGuid -notmatch '^[0-9a-fA-F-]{32,36}$') { Fail 'machine_identity_invalid' }
  $lastBoot = ([DateTime]$os.LastBootUpTime).ToUniversalTime()
  $machineIdentitySha256 = HashText($machineGuid.ToLowerInvariant())
  $bootIdentitySha256 = HashText($machineIdentitySha256 + [Environment]::NewLine + $lastBoot.ToString('O'))

  # Inspect only the boot flag, never enumerate or access credential values.
  $winlogon = Get-Item -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction Stop
  try {
    $consoleAutologon = $winlogon.GetValue('AutoAdminLogon', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $consoleAutologon -and $winlogon.GetValueKind('AutoAdminLogon') -ne [Microsoft.Win32.RegistryValueKind]::String) { Fail 'console_autologon_invalid' }
  }
  finally { $winlogon.Close() }
  if ($null -ne $consoleAutologon -and ($consoleAutologon -isnot [string] -or $consoleAutologon -cnotin @('0','1'))) { Fail 'console_autologon_invalid' }
  if ($consoleAutologon -ceq '1') { Fail 'console_autologon_enabled' }

  $terminalServer = Get-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server' -ErrorAction Stop
  $rdpTcp = Get-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -ErrorAction Stop
  if ([int]$terminalServer.fDenyTSConnections -ne 0) { Fail 'rdp_disabled' }
  if ([int]$rdpTcp.UserAuthentication -ne 1) { Fail 'rdp_nla_disabled' }
  if ([int]$rdpTcp.PortNumber -ne 3389) { Fail 'rdp_port_mismatch' }
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='TermService'" -ErrorAction Stop
  if ($null -eq $service -or [string]$service.State -ne 'Running' -or [string]$service.StartMode -eq 'Disabled' -or [uint32]$service.ProcessId -eq 0) { Fail 'rdp_service_unready' }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3389 -ErrorAction Stop | Where-Object { [uint32]$_.OwningProcess -eq [uint32]$service.ProcessId -and ($_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' -or $_.LocalAddress -eq $expectedIp.ToString()) })
  if ($listeners.Count -lt 1) { Fail 'rdp_listener_unready' }

  $terminal = Get-CimInstance -Namespace 'root/cimv2/TerminalServices' -ClassName Win32_TSGeneralSetting -Filter "TerminalName='RDP-tcp'" -ErrorAction Stop
  $sha1 = ([string]$terminal.SSLCertificateSHA1Hash).Replace(' ','').ToUpperInvariant()
  if ($sha1 -notmatch '^[0-9A-F]{40}$') { Fail 'rdp_certificate_binding_invalid' }
  $certificates = @(Get-ChildItem -LiteralPath 'Cert:\LocalMachine\Remote Desktop' -ErrorAction Stop | Where-Object { $_.Thumbprint -eq $sha1 })
  if ($certificates.Count -ne 1) { Fail 'rdp_certificate_missing' }
  $certificate = $certificates[0]
  $now = [DateTime]::UtcNow
  if (-not $certificate.HasPrivateKey -or $certificate.NotBefore.ToUniversalTime() -gt $now -or $certificate.NotAfter.ToUniversalTime() -le $now) { Fail 'rdp_certificate_invalid' }
  $certificateFingerprint = 'sha256:' + (HashBytes($certificate.RawData))

  $rules = @(Get-NetFirewallRule -Name 'Hivra-RDP-Private-Access-v1' -ErrorAction Stop | Where-Object {
    [string]$_.Enabled -eq 'True' -and [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Allow'
  })
  if ($rules.Count -ne 1 -or [string]$rules[0].DisplayName -ne 'Hivra RDP private access' -or
      [string]$rules[0].Profile -ne 'Any' -or [string]$rules[0].EdgeTraversalPolicy -ne 'Block') { Fail 'rdp_firewall_rule_mismatch' }
  $ports = @($rules[0] | Get-NetFirewallPortFilter -ErrorAction Stop)
  if ($ports.Count -ne 1 -or [string]$ports[0].Protocol -ne 'TCP' -or [string]$ports[0].LocalPort -ne '3389') { Fail 'rdp_firewall_port_mismatch' }
  $services = @($rules[0] | Get-NetFirewallServiceFilter -ErrorAction Stop)
  if ($services.Count -ne 1 -or [string]$services[0].Service -ne 'TermService') { Fail 'rdp_firewall_service_mismatch' }
  $applications = @($rules[0] | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  $expectedProgram = Join-Path $env:SystemRoot 'System32\svchost.exe'
  $actualProgram = if ($applications.Count -eq 1) {
    [Environment]::ExpandEnvironmentVariables([string]$applications[0].Program)
  } else { '' }
  if (-not [String]::Equals($actualProgram, $expectedProgram, [StringComparison]::OrdinalIgnoreCase)) { Fail 'rdp_firewall_program_mismatch' }
  $addresses = @($rules[0] | Get-NetFirewallAddressFilter -ErrorAction Stop)
  if ($addresses.Count -ne 1) { Fail 'rdp_firewall_source_missing' }
  $sourceCidrs = @($addresses[0].RemoteAddress | ForEach-Object { PrivateCidr([string]$_) } | Sort-Object -Unique)
  if ($sourceCidrs.Count -lt 1 -or $sourceCidrs.Count -gt 32) { Fail 'rdp_firewall_source_missing' }
  # Fresh, bounded associations from the same default PersistentStore used
  # by the original rule/port queries. Never reuse this map across inspections.
  $allPortFilters = @(Get-NetFirewallPortFilter -ErrorAction Stop)
  if ($allPortFilters.Count -lt 1 -or $allPortFilters.Count -gt 8192) { Fail 'rdp_firewall_filter_association_unverified' }
  $portMap = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
  foreach ($portFilter in $allPortFilters) {
    $id = [string]$portFilter.InstanceID
    if ([string]::IsNullOrWhiteSpace($id) -or $id.Length -gt 1024 -or $portMap.ContainsKey($id)) { Fail 'rdp_firewall_filter_association_unverified' }
    $portMap.Add($id, $portFilter)
  }
  $conflicts = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop | Where-Object {
    $_.Name -ne 'Hivra-RDP-Private-Access-v1' -and
      [string]::IsNullOrWhiteSpace([string]$_.Owner)
  } | ForEach-Object {
    $rule = $_
    $id = [string]$rule.InstanceID
    if ([string]::IsNullOrWhiteSpace($id) -or [string]$rule.Name -cne $id -or -not $portMap.ContainsKey($id)) { Fail 'rdp_firewall_filter_association_unverified' }
    $portFilter = $portMap[$id]
    if ([string]$portFilter.InstanceID -cne $id) { Fail 'rdp_firewall_filter_association_unverified' }
    # Port/protocol filtering is cheap and excludes unrelated rules before
    # their service/application CIM associations are queried. Keep every
    # RDP-capable Any/range rule and the fail-closed association checks.
    $rdpPorts = @($portFilter | Where-Object {
      ([string]$_.Protocol -eq 'TCP' -or [string]$_.Protocol -eq '6' -or [string]$_.Protocol -eq 'Any') -and
      (PortIncludesRdp([string]$_.LocalPort))
    })
    if ($rdpPorts.Count -gt 0 -and (CouldMatchTermService $rule)) { $rule.Name }
  })
  if ($conflicts.Count -ne 0) { Fail 'rdp_firewall_conflict' }

  $descriptor = [ordered]@{
    protocol = 'hivra-windows-rdp-prepared-v1'
    computerId = [string]$expected.computerId
    vmid = [int]$expected.vmid
    profile = 'windows'
    guestPrivateIpv4 = $expectedIp.ToString()
    inspectionRevision = [string]$expected.inspectionRevision
    machineIdentitySha256 = $machineIdentitySha256
    bootIdentitySha256 = $bootIdentitySha256
    lastBootAt = $lastBoot.ToString('O')
    windowsCaption = [string]$os.Caption
    windowsVersion = [string]$os.Version
    windowsBuild = [string]$os.BuildNumber
    licenseStatus = 'licensed'
    rdpServiceState = 'running'
    rdpServiceStartMode = ([string]$service.StartMode).ToLowerInvariant()
    rdpPort = 3389
    nla = $true
    listenerVerified = $true
    certificateFingerprint = $certificateFingerprint
    route = [ordered]@{ status = 'configured-not-proven'; sourceCidrs = $sourceCidrs; exclusive = $true }
    privateNetworkReachable = $false
    observedAt = $now.ToString('O')
  }
  [Console]::Out.WriteLine('${WINDOWS_RDP_PREPARED_MARKER}' + ($descriptor | ConvertTo-Json -Compress -Depth 4))
} catch {
  [Console]::Error.WriteLine('HIVRA_CAPABILITY_FAILURE inspection_failed')
  exit 1
}`;

export const WINDOWS_RDP_INSPECTION_REVISION = createHash("sha256")
  .update(POWERSHELL_INSPECTION_PROGRAM)
  .digest("hex");

const WINDOWS_INSPECTION_FAILURES = new Set([
  "inspection_input_shape", "computer_identity_invalid", "vm_identity_invalid",
  "guest_ip_invalid", "guest_ip_not_private", "guest_ip_mismatch",
  "windows_workstation_invalid", "windows_version_invalid", "windows_not_licensed",
  "machine_identity_invalid", "rdp_disabled", "rdp_nla_disabled", "rdp_port_mismatch",
  "console_autologon_enabled", "console_autologon_invalid",
  "rdp_service_unready", "rdp_listener_unready", "rdp_certificate_binding_invalid",
  "rdp_certificate_missing", "rdp_certificate_invalid", "rdp_firewall_rule_mismatch",
  "rdp_firewall_port_mismatch", "rdp_firewall_service_mismatch", "rdp_firewall_program_mismatch",
  "rdp_firewall_source_missing", "rdp_firewall_conflict", "firewall_source_invalid",
  "rdp_firewall_filter_association_unverified",
  "firewall_source_public", "firewall_source_noncanonical", "inspection_failed",
]);

/** Read fixed diagnostic tokens only, never return PowerShell/CLIXML content. */
export function parseWindowsRdpInspectionFailure(stderr: string): string | null {
  // Encoded PowerShell may place stderr next to CLIXML tags or escaped CR/LF,
  // rather than on a plain newline-delimited stream.
  const matches = [...stderr.matchAll(/(?:^|\r?\n|>)HIVRA_CAPABILITY_FAILURE ([a-z0-9_]+)(?=\r?\n|<|_x000D_|_x000A_|$)/g)];
  if (matches.length === 1 && WINDOWS_INSPECTION_FAILURES.has(matches[0][1])) {
    return `guest_${matches[0][1]}`;
  }
  for (const code of ["result_invalid", "result_too_large", "dispatch", "dispatch_stdin"]) {
    if (new RegExp(`(?:^|\\n)HIVRA_QGA_FAILURE ${code}(?:\\r?\\n|$)`).test(stderr)) return `qga_${code}`;
  }
  const exit = stderr.match(/(?:^|\n)HIVRA_QGA_FAILURE guest_exit_([0-9]{1,3})(?:\r?\n|$)/)?.[1];
  if (exit && Number(exit) <= 255) return `qga_guest_exit_${exit}`;
  const phase = stderr.match(/(?:^|\n)HIVRA_WINDOWS_INSPECTION_HOST_FAILURE (vm_state|vm_config|binding_tag|guest_ip_binding|guest_exec)(?:\r?\n|$)/)?.[1];
  return phase ? `host_phase_${phase}` : null;
}

function privateIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  const octets = value.split(".").map(Number);
  if (octets.some(octet => octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function safeSourceCidr(value: string): boolean {
  if (!IPV4_SOURCE_CIDR.test(value)) return false;
  const [address, rawPrefix] = value.split("/");
  const octets = address.split(".").map(Number);
  if (octets.some(octet => octet < 0 || octet > 255)) return false;
  const prefix = Number(rawPrefix);
  const ip = octets.reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  if (((ip & mask) >>> 0) !== ip || !privateIpv4(address)) return false;
  if (octets[0] === 10) return prefix >= 8;
  if (octets[0] === 172) return prefix >= 12;
  return prefix >= 16;
}

const Route = z.object({
  status: z.literal("configured-not-proven"),
  sourceCidrs: z.array(z.string().regex(IPV4_SOURCE_CIDR).refine(safeSourceCidr))
    .min(1).max(32)
    .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value)),
  exclusive: z.literal(true),
}).strict();

const Descriptor = z.object({
  protocol: z.literal("hivra-windows-rdp-prepared-v1"),
  computerId: z.string().uuid(),
  vmid: z.number().int().min(100),
  profile: z.literal("windows"),
  guestPrivateIpv4: z.string().regex(IPV4).refine(privateIpv4),
  inspectionRevision: z.literal(WINDOWS_RDP_INSPECTION_REVISION),
  machineIdentitySha256: z.string().regex(SHA256),
  bootIdentitySha256: z.string().regex(SHA256),
  lastBootAt: z.string().datetime({ offset: true }),
  windowsCaption: z.string().min(1).max(160).regex(/^[\x20-\x7e]+$/),
  windowsVersion: z.string().regex(/^10\.0\.[0-9]+(?:\.[0-9]+)?$/),
  windowsBuild: z.string().regex(/^[0-9]{4,6}$/),
  licenseStatus: z.literal("licensed"),
  rdpServiceState: z.literal("running"),
  rdpServiceStartMode: z.enum(["auto", "manual"]),
  rdpPort: z.literal(3389),
  nla: z.literal(true),
  listenerVerified: z.literal(true),
  certificateFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  route: Route,
  privateNetworkReachable: z.literal(false),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

export type PreparedWindowsRdpDescriptor = z.infer<typeof Descriptor>;

export function buildPreparedWindowsRdpCapabilityInspectionScript(input: {
  computerId: string;
  vmid: number;
  guestIp: string;
  infrastructureBindingTag: string;
}): string {
  if (!UUID.test(input.computerId) || !Number.isSafeInteger(input.vmid) || input.vmid < 100
    || !privateIpv4(input.guestIp) || !/^hivra-bind-[a-f0-9]{32}$/.test(input.infrastructureBindingTag)) {
    throw new Error("Invalid prepared Windows RDP inspection binding.");
  }
  const expected = Buffer.from(JSON.stringify({
    computerId: input.computerId,
    vmid: input.vmid,
    guestPrivateIpv4: input.guestIp,
    inspectionRevision: WINDOWS_RDP_INSPECTION_REVISION,
  }), "utf8").toString("base64");
  const program = POWERSHELL_INSPECTION_PROGRAM.replace("__HIVRA_EXPECTED_BASE64__", expected);
  const payload = Buffer.from(program, "utf8").toString("base64");
  if (payload.length > 32768) throw new Error("Windows RDP inspection payload exceeds its transport bound.");
  const bootstrap = String.raw`$ErrorActionPreference = 'Stop'
try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -lt 1 -or $raw.Length -gt 32768 -or $raw -notmatch '\A[A-Za-z0-9+/]+={0,2}\z') { throw 'payload' }
  $program = [Text.UTF8Encoding]::new($false, $true).GetString([Convert]::FromBase64String($raw))
  $block = [ScriptBlock]::Create($program)
} catch { [Console]::Error.WriteLine('HIVRA_CAPABILITY_FAILURE inspection_failed'); exit 1 }
& $block`;
  const encodedProgram = Buffer.from(bootstrap, "utf16le").toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
HIVRA_WINDOWS_INSPECTION_PHASE=vm_state
trap 'printf "HIVRA_WINDOWS_INSPECTION_HOST_FAILURE %s\\n" "$HIVRA_WINDOWS_INSPECTION_PHASE" >&2' ERR
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
EXPECTED_BINDING_TAG=${shellQuote(input.infrastructureBindingTag)}
[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ]
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = 'running' ]
HIVRA_WINDOWS_INSPECTION_PHASE=vm_config
VM_CONFIG="$(qm config "$VMID")"
HIVRA_WINDOWS_INSPECTION_PHASE=binding_tag
TAGS="$(printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
HIVRA_WINDOWS_INSPECTION_PHASE=guest_ip_binding
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
HIVRA_WINDOWS_INSPECTION_PHASE=guest_exec
printf '%s' ${shellQuote(payload)} | run_vmid_bound_guest_exec_stdin powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${shellQuote(encodedProgram)}
`;
}

export function parsePreparedWindowsRdpCapability(
  stdout: string,
  expected: { computerId: string; vmid: number; guestIp: string },
): PreparedWindowsRdpDescriptor | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(WINDOWS_RDP_PREPARED_MARKER));
  if (lines.length !== 1) return null;
  let raw: unknown;
  try { raw = JSON.parse(lines[0].slice(WINDOWS_RDP_PREPARED_MARKER.length)); }
  catch { return null; }
  const parsed = Descriptor.safeParse(raw);
  if (!parsed.success) return null;
  const descriptor = parsed.data;
  if (descriptor.computerId !== expected.computerId || descriptor.vmid !== expected.vmid
    || descriptor.guestPrivateIpv4 !== expected.guestIp) return null;
  const observedAt = Date.parse(descriptor.observedAt);
  const lastBootAt = Date.parse(descriptor.lastBootAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(lastBootAt)
    || Math.abs(Date.now() - observedAt) > 2 * 60_000
    || lastBootAt > observedAt) return null;
  return descriptor;
}
