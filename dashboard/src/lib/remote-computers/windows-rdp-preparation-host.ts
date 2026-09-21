import "server-only";

import { Buffer } from "node:buffer";

import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPV4_SOURCE_CIDR = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const MARKER = "HIVRA_WINDOWS_RDP_PREPARATION_V1 ";
const HOST_TIMEOUT_MS = 90_000;

export type WindowsRdpPreparationRequest = {
  computerId: string;
  operationId: string;
  vmid: number;
  guestPrivateIpv4: string;
  gatewaySourceCidrs: string[];
};

type Dependencies = {
  resolveContext: (userId: string, agent: RemoteDesktopAgentRow) => Promise<HivraAgentExecutionContext>;
  runHostScript: typeof runProxmoxHostScript;
};

type Result =
  | { ok: true; targetId: string; vmid: number; changed: boolean; accessReady: false }
  | { ok: false; code: "invalid_target" | "authority_unavailable" | "transport_failed" | "invalid_result" };

function privateIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(part => part > 255)) return false;
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

function validRequest(value: WindowsRdpPreparationRequest): boolean {
  return UUID.test(value.computerId) && UUID.test(value.operationId)
    && Number.isSafeInteger(value.vmid) && value.vmid >= 100
    && privateIpv4(value.guestPrivateIpv4)
    && Array.isArray(value.gatewaySourceCidrs) && value.gatewaySourceCidrs.length >= 1
    && value.gatewaySourceCidrs.length <= 32
    && value.gatewaySourceCidrs.every(safeSourceCidr)
    && value.gatewaySourceCidrs.every((entry, index) => index === 0 || value.gatewaySourceCidrs[index - 1] < entry);
}

// No credential crosses this program. It prepares only the OS listener and its
// private, service-bound firewall boundary; session credentials are a distinct
// future authority and accessReady therefore remains false.
export const WINDOWS_RDP_PREPARATION_PROGRAM = String.raw`$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Fail([string]$Code) {
  [Console]::Error.WriteLine('HIVRA_PREPARATION_FAILURE ' + $Code)
  exit 1
}
function ReadConsoleAutologon {
  # Read only the boot flag, never enumerate or access credential values.
  $key = Get-Item -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction Stop
  try {
    $flag = $key.GetValue('AutoAdminLogon', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $flag -and $key.GetValueKind('AutoAdminLogon') -ne [Microsoft.Win32.RegistryValueKind]::String) { Fail 'console_autologon_invalid' }
  }
  finally { $key.Close() }
  if ($null -ne $flag -and ($flag -isnot [string] -or $flag -cnotin @('0','1'))) { Fail 'console_autologon_invalid' }
  return $flag
}
function PrivateCidr([string]$Value) {
  # Windows returns an exact /32 RemoteAddress as a bare IPv4 address.
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
function ExposesRdp($Rule) {
  $matches = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop | Where-Object {
    $protocol = [string]$_.Protocol
    $ports = @([string]$_.LocalPort -split ',' | ForEach-Object { $_.Trim() })
    ($protocol -eq 'TCP' -or $protocol -eq '6' -or $protocol -eq 'Any') -and
    @($ports | Where-Object {
      $_ -eq '3389' -or $_ -eq 'Any' -or
      ($_ -match '^(?<first>[0-9]+)-(?<last>[0-9]+)$' -and [int]$Matches.first -le 3389 -and [int]$Matches.last -ge 3389)
    }).Count -gt 0
  })
  return $matches.Count -gt 0
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
  $serviceMatches = $service -eq 'Any' -or $service -eq 'TermService'
  $programMatches = $program -eq 'Any' -or $program -match '(?i)(^|\\|/)svchost\.exe$'
  return $serviceMatches -and $programMatches
}
function OwnedRuleMatches($Rule, [string[]]$ExpectedCidrs, [string]$ExpectedProgram) {
  if ($null -eq $Rule -or [string]$Rule.Name -ne 'Hivra-RDP-Private-Access-v1' -or
      [string]$Rule.DisplayName -ne 'Hivra RDP private access' -or [string]$Rule.Direction -ne 'Inbound' -or
      [string]$Rule.Action -ne 'Allow' -or [string]$Rule.Profile -ne 'Any' -or
      [string]$Rule.EdgeTraversalPolicy -ne 'Block') { return $false }
  $ports = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop)
  $services = @($Rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
  $addresses = @($Rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
  $applications = @($Rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
  if ($ports.Count -ne 1 -or [string]$ports[0].Protocol -ne 'TCP' -or [string]$ports[0].LocalPort -ne '3389' -or
      $services.Count -ne 1 -or [string]$services[0].Service -ne 'TermService' -or $addresses.Count -ne 1 -or
      $applications.Count -ne 1) { return $false }
  $actualProgram = if ([string]$applications[0].Program -eq 'Any') { 'Any' } else {
    [Environment]::ExpandEnvironmentVariables([string]$applications[0].Program)
  }
  if (-not [String]::Equals($actualProgram, $ExpectedProgram, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $actual = @($addresses[0].RemoteAddress | ForEach-Object { PrivateCidr([string]$_) } | Sort-Object -Unique)
  return [string]::Join([Environment]::NewLine, $actual) -ceq [string]::Join([Environment]::NewLine, $ExpectedCidrs)
}
try {
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__HIVRA_REQUEST_BASE64__')) | ConvertFrom-Json
  $expectedNames = @('computerId','operationId','vmid','guestPrivateIpv4','gatewaySourceCidrs')
  if ($null -eq $request -or @($request.PSObject.Properties.Name).Count -ne $expectedNames.Count) { Fail 'input_shape' }
  foreach ($name in $expectedNames) { if ($null -eq $request.PSObject.Properties[$name]) { Fail 'input_shape' } }
  if ([string]$request.computerId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
      [string]$request.operationId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
      [int]$request.vmid -lt 100) { Fail 'binding_invalid' }
  $expectedIp = [Net.IPAddress]::Parse([string]$request.guestPrivateIpv4)
  if ($expectedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { Fail 'guest_ip_invalid' }
  $octets = $expectedIp.GetAddressBytes()
  if (-not ($octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168))) { Fail 'guest_ip_not_private' }
  $observedIps = @(Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction Stop | Where-Object { $_.IPAddress -eq $expectedIp.ToString() })
  if ($observedIps.Count -ne 1) { Fail 'guest_ip_mismatch' }
  $sourceCidrs = @($request.gatewaySourceCidrs | ForEach-Object { PrivateCidr([string]$_) } | Sort-Object -Unique)
  if ($sourceCidrs.Count -ne @($request.gatewaySourceCidrs).Count -or $sourceCidrs.Count -lt 1 -or $sourceCidrs.Count -gt 32 -or
      [string]::Join([Environment]::NewLine, $sourceCidrs) -cne [string]::Join([Environment]::NewLine, @($request.gatewaySourceCidrs))) { Fail 'firewall_source_shape' }

  $owned = @(Get-NetFirewallRule -Name 'Hivra-RDP-Private-Access-v1' -ErrorAction SilentlyContinue)
  $expectedProgram = Join-Path $env:SystemRoot 'System32\svchost.exe'
  $ownedExact = $owned.Count -eq 1 -and (OwnedRuleMatches $owned[0] $sourceCidrs $expectedProgram)
  $ownedLegacy = $owned.Count -eq 1 -and (OwnedRuleMatches $owned[0] $sourceCidrs 'Any')
  if ($owned.Count -gt 1 -or ($owned.Count -eq 1 -and -not $ownedExact -and -not $ownedLegacy)) { Fail 'owned_firewall_conflict' }
  $builtinNames = @('RemoteDesktop-Shadow-In-TCP','RemoteDesktop-UserMode-In-TCP','RemoteDesktop-UserMode-In-UDP')
  $unknownConflicts = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop | Where-Object {
    $_.Name -ne 'Hivra-RDP-Private-Access-v1' -and $_.Name -notin $builtinNames -and
    (ExposesRdp $_) -and (CouldMatchTermService $_)
  })
  if ($unknownConflicts.Count -ne 0) { Fail 'unknown_firewall_conflict' }

  # Validate before any mutation. Do not replace malformed/unknown policies.
  $consoleAutologon = ReadConsoleAutologon

  $changed = $false
  if ($consoleAutologon -ceq '1') {
    # A fresh boot must not start a competing console account. Existing sessions
    # stay untouched; this changes the next boot, without logging anyone off.
    Set-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoAdminLogon -Type String -Value '0' -ErrorAction Stop
    if ((ReadConsoleAutologon) -cne '0') { Fail 'console_autologon_unconfirmed' }
    $changed = $true
  }
  $enabledBuiltins = @(Get-NetFirewallRule -Name $builtinNames -ErrorAction SilentlyContinue | Where-Object { [string]$_.Enabled -eq 'True' })
  if ($enabledBuiltins.Count -gt 0) {
    $enabledBuiltins | Disable-NetFirewallRule -ErrorAction Stop | Out-Null
    $changed = $true
  }
  if ($ownedLegacy) {
    $application = @($owned[0] | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    if ($application.Count -ne 1) { Fail 'owned_firewall_conflict' }
    $application[0] | Set-NetFirewallApplicationFilter -Program '%SystemRoot%\system32\svchost.exe' -ErrorAction Stop | Out-Null
    $owned = @(Get-NetFirewallRule -Name 'Hivra-RDP-Private-Access-v1' -ErrorAction Stop)
    if ($owned.Count -ne 1 -or -not (OwnedRuleMatches $owned[0] $sourceCidrs $expectedProgram)) { Fail 'owned_firewall_program_mismatch' }
    $changed = $true
  }
  if ($owned.Count -eq 1 -and [string]$owned[0].Enabled -ne 'True') {
    $owned[0] | Enable-NetFirewallRule -ErrorAction Stop | Out-Null
    $changed = $true
  }
  if ($owned.Count -eq 0) {
    New-NetFirewallRule -Name 'Hivra-RDP-Private-Access-v1' -DisplayName 'Hivra RDP private access' -Group 'Hivra' -Description 'Allow Hivra gateway RDP only from the prepared private source.' -Enabled True -Profile Any -Direction Inbound -Action Allow -EdgeTraversalPolicy Block -Protocol TCP -LocalPort 3389 -RemoteAddress $sourceCidrs -Service TermService -Program '%SystemRoot%\system32\svchost.exe' -ErrorAction Stop | Out-Null
    $changed = $true
  }

  $terminalPath = 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server'
  $rdpPath = 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
  $terminal = Get-ItemProperty -Path $terminalPath -ErrorAction Stop
  $rdp = Get-ItemProperty -Path $rdpPath -ErrorAction Stop
  if ([int]$terminal.fDenyTSConnections -ne 0) { Set-ItemProperty -Path $terminalPath -Name fDenyTSConnections -Type DWord -Value 0 -ErrorAction Stop; $changed = $true }
  if ([int]$rdp.UserAuthentication -ne 1) { Set-ItemProperty -Path $rdpPath -Name UserAuthentication -Type DWord -Value 1 -ErrorAction Stop; $changed = $true }
  if ([int]$rdp.PortNumber -ne 3389) { Set-ItemProperty -Path $rdpPath -Name PortNumber -Type DWord -Value 3389 -ErrorAction Stop; $changed = $true }
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='TermService'" -ErrorAction Stop
  if ($null -eq $service) { Fail 'rdp_service_missing' }
  if ([string]$service.StartMode -eq 'Disabled') { Set-Service -Name TermService -StartupType Manual -ErrorAction Stop; $changed = $true }
  if ([string]$service.State -ne 'Running') { Start-Service -Name TermService -ErrorAction Stop; $changed = $true }

  $result = [ordered]@{
    protocol = 'hivra-windows-rdp-preparation-v1'
    computerId = [string]$request.computerId
    operationId = [string]$request.operationId
    vmid = [int]$request.vmid
    guestPrivateIpv4 = $expectedIp.ToString()
    gatewaySourceCidrs = $sourceCidrs
    changed = [bool]$changed
    accessReady = $false
  }
  [Console]::Out.WriteLine('${MARKER}' + ($result | ConvertTo-Json -Compress -Depth 3))
} catch {
  [Console]::Error.WriteLine('HIVRA_PREPARATION_FAILURE preparation_failed')
  exit 1
}`;

export function buildWindowsRdpPreparationHostScript(
  request: WindowsRdpPreparationRequest,
  infrastructureBindingTag: string,
): string {
  if (!validRequest(request) || !/^hivra-bind-[a-f0-9]{32}$/.test(infrastructureBindingTag)) {
    throw new Error("Invalid Windows RDP preparation.");
  }
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const program = WINDOWS_RDP_PREPARATION_PROGRAM.replace("__HIVRA_REQUEST_BASE64__", payload);
  const encodedProgram = Buffer.from(program, "utf16le").toString("base64");
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${request.vmid}
GUEST_IP=${shellQuote(request.guestPrivateIpv4)}
EXPECTED_BINDING_TAG=${shellQuote(infrastructureBindingTag)}
qm() { command timeout --kill-after=5 20 qm "$@"; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout --kill-after=5 70 qm "$@"; }
run_vmid_bound_guest_exec powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${shellQuote(encodedProgram)}
`;
}

function parseResult(stdout: string, request: WindowsRdpPreparationRequest): { changed: boolean } | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) return null;
  let value: unknown;
  try { value = JSON.parse(lines[0].slice(MARKER.length)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 8
    && row.protocol === "hivra-windows-rdp-preparation-v1"
    && row.computerId === request.computerId && row.operationId === request.operationId
    && row.vmid === request.vmid && row.guestPrivateIpv4 === request.guestPrivateIpv4
    && JSON.stringify(row.gatewaySourceCidrs) === JSON.stringify(request.gatewaySourceCidrs)
    && typeof row.changed === "boolean" && row.accessReady === false
    ? { changed: row.changed } : null;
}

export async function prepareWindowsRdpGuest(
  userId: string,
  rawAgent: RemoteDesktopAgentRow,
  request: WindowsRdpPreparationRequest,
  dependencies: Partial<Dependencies> = {},
): Promise<Result> {
  const agent = structuredClone(rawAgent);
  const requested = structuredClone(request);
  if (!validRequest(requested) || !userId || agent.user_id !== userId || agent.id !== requested.computerId
      || agent.type !== "linux-desktop" || agent.computer_profile !== "windows"
      || agent.computer_substrate !== "proxmox-kvm" || agent.status !== "running"
      || agent.desired_state !== "running" || agent.operation_id !== requested.operationId
      || agent.operation_kind !== "desktop_prepare" || agent.vmid !== requested.vmid
      || agent.ip !== requested.guestPrivateIpv4 || agent.infrastructure_binding_token_enforced !== true
      || typeof agent.infrastructure_binding_token_hash !== "string"
      || !/^[a-f0-9]{64}$/.test(agent.infrastructure_binding_token_hash)) {
    return { ok: false, code: "invalid_target" };
  }
  const deps = {
    resolveContext: resolveHivraAgentExecutionContext,
    runHostScript: runProxmoxHostScript,
    ...dependencies,
  };
  let context: HivraAgentExecutionContext;
  try { context = await deps.resolveContext(userId, agent); }
  catch { return { ok: false, code: "authority_unavailable" }; }
  const expectedTag = "hivra-bind-" + agent.infrastructure_binding_token_hash.slice(0, 32);
  if (!context.infrastructureBindingTagEnforced || context.infrastructureBindingTag !== expectedTag) {
    return { ok: false, code: "authority_unavailable" };
  }
  let script: string;
  try { script = buildWindowsRdpPreparationHostScript(requested, expectedTag); }
  catch { return { ok: false, code: "invalid_target" }; }
  try {
    const response = await deps.runHostScript(script, { ...context.env }, {
      timeoutMs: HOST_TIMEOUT_MS, maxOutputBytes: 32_768, earlyFinishMarker: MARKER,
    });
    if (!response.ok) return { ok: false, code: "transport_failed" };
    const result = parseResult(response.stdout, requested);
    return result
      ? { ok: true, targetId: context.host, vmid: requested.vmid, changed: result.changed, accessReady: false }
      : { ok: false, code: "invalid_result" };
  } catch {
    return { ok: false, code: "transport_failed" };
  }
}
