import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildPreparedWindowsRdpCapabilityInspectionScript,
  parsePreparedWindowsRdpCapability,
  parseWindowsRdpInspectionFailure,
  WINDOWS_RDP_INSPECTION_REVISION,
  WINDOWS_RDP_PREPARED_MARKER,
} from "@/lib/remote-computers/windows-rdp-capability";

jest.mock("server-only", () => ({}));

const COMPUTER_ID = "00000000-0000-4000-8000-000000001009";
const EXPECTED = { computerId: COMPUTER_ID, vmid: 410, guestIp: "10.240.40.10" };

function inspectionProgram(script: string): string {
  return Buffer.from(script.match(/printf '%s' '([^']+)' \| run_vmid_bound_guest_exec_stdin/)![1], "base64").toString("utf8");
}

describe("Windows inspection safe failure diagnostics", () => {
  it.each([
    ["HIVRA_CAPABILITY_FAILURE rdp_disabled\n", "guest_rdp_disabled"],
    ["HIVRA_CAPABILITY_FAILURE console_autologon_enabled\n", "guest_console_autologon_enabled"],
    ["HIVRA_CAPABILITY_FAILURE console_autologon_invalid\n", "guest_console_autologon_invalid"],
    ['#< CLIXML\n<Objs><S S="Error">HIVRA_CAPABILITY_FAILURE inspection_failed_x000D__x000A_</S></Objs>', "guest_inspection_failed"],
    ["HIVRA_QGA_FAILURE result_invalid\nHIVRA_QGA_FAILURE guest_exit_125\n", "qga_result_invalid"],
    ["HIVRA_QGA_FAILURE dispatch\n", "qga_dispatch"],
    ["HIVRA_QGA_FAILURE guest_exit_1\n", "qga_guest_exit_1"],
    ["HIVRA_WINDOWS_INSPECTION_HOST_FAILURE binding_tag\n", "host_phase_binding_tag"],
  ])("extracts only a fixed diagnostic from %s", (stderr, expected) => {
    expect(parseWindowsRdpInspectionFailure(stderr)).toBe(expected);
  });
  it.each([
    "credential secret", "HIVRA_CAPABILITY_FAILURE private_secret\n",
    "HIVRA_CAPABILITY_FAILURE rdp_disabled_extra\n", "HIVRA_QGA_FAILURE guest_exit_999\n",
    "HIVRA_WINDOWS_INSPECTION_HOST_FAILURE private_secret\n",
    "HIVRA_CAPABILITY_FAILURE rdp_disabled\nHIVRA_CAPABILITY_FAILURE inspection_failed\n",
  ])("does not disclose or interpret unknown/ambiguous output", stderr => {
    expect(parseWindowsRdpInspectionFailure(stderr)).toBeNull();
  });
});

describe("Windows host guard diagnostics", () => {
  const script = buildPreparedWindowsRdpCapabilityInspectionScript({ ...EXPECTED,
    infrastructureBindingTag: "hivra-bind-" + "a".repeat(32) });
  it("keeps the generated host script valid Bash", () => {
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
  });
  it.each([
    ["vm_state", "qm() { echo 'status: stopped'; }"],
    ["vm_config", "qm() { if [ \"$1\" = status ]; then echo 'status: running'; else return 3; fi; }"],
    ["binding_tag", "qm() { if [ \"$1\" = status ]; then echo 'status: running'; else echo 'tags: private-invalid-tag'; fi; }"],
    ["guest_ip_binding", "qm() { if [ \"$1\" = status ]; then echo 'status: running'; else echo 'tags: hivra-bind-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; fi; }"],
  ])("emits only the fixed %s phase when that authority guard fails", (phase, fakeQm) => {
    const result = spawnSync("bash", ["-s"], { input: `${fakeQm}\n${script}`, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`HIVRA_WINDOWS_INSPECTION_HOST_FAILURE ${phase}\n`);
  });
});

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "hivra-windows-rdp-prepared-v1",
    computerId: COMPUTER_ID,
    vmid: 410,
    profile: "windows",
    guestPrivateIpv4: "10.240.40.10",
    inspectionRevision: WINDOWS_RDP_INSPECTION_REVISION,
    machineIdentitySha256: "a".repeat(64),
    bootIdentitySha256: "b".repeat(64),
    lastBootAt: new Date(Date.now() - 60_000).toISOString(),
    windowsCaption: "Microsoft Windows 11 Pro",
    windowsVersion: "10.0.26100",
    windowsBuild: "26100",
    licenseStatus: "licensed",
    rdpServiceState: "running",
    rdpServiceStartMode: "manual",
    rdpPort: 3389,
    nla: true,
    listenerVerified: true,
    certificateFingerprint: `sha256:${"c".repeat(64)}`,
    route: { status: "configured-not-proven", sourceCidrs: ["10.240.0.0/16"], exclusive: true },
    privateNetworkReachable: false,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function marked(value = descriptor()) {
  return `${WINDOWS_RDP_PREPARED_MARKER}${JSON.stringify(value)}\n`;
}

describe("Windows RDP capability inspection", () => {
  it("filters only nonowned, nonpackage RDP-capable ports before expensive associations", () => {
    const script = buildPreparedWindowsRdpCapabilityInspectionScript({ ...EXPECTED,
      infrastructureBindingTag: "hivra-bind-" + "a".repeat(32) });
    const program = inspectionProgram(script);
    const conflicts = program.slice(program.indexOf("  $conflicts = @("), program.indexOf("  if ($conflicts.Count"));
    expect(conflicts).toContain("[string]::IsNullOrWhiteSpace([string]$_.Owner)");
    expect(conflicts).not.toContain("Get-NetFirewallPortFilter");
    expect(program).toContain("$allPortFilters = @(Get-NetFirewallPortFilter -ErrorAction Stop)");
    expect(program).toContain("$allPortFilters.Count -gt 8192");
    expect(program).toContain("$portMap.ContainsKey($id)");
    expect(conflicts).toContain("[string]$rule.Name -cne $id");
    expect(conflicts).toContain("$rdpPorts.Count -gt 0 -and (CouldMatchTermService $rule)");
  });

  const powershellAvailable = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
  (powershellAvailable ? it : it.skip)("executes the PowerShell conflict equivalence fixture", () => {
    const script = buildPreparedWindowsRdpCapabilityInspectionScript({ ...EXPECTED,
      infrastructureBindingTag: "hivra-bind-" + "a".repeat(32) });
    const program = inspectionProgram(script);
    const functions = program.slice(program.indexOf("function PortIncludesRdp"),
      program.indexOf("try {", program.indexOf("function CouldMatchTermService")));
    const pipeline = program.slice(program.indexOf("  $allPortFilters = @("), program.indexOf("  if ($conflicts.Count"));
    const fixtureProgram = Buffer.from(`${functions}\ntry {\n${pipeline}\n  if ($conflicts.Count) { }\n}`, "utf8").toString("base64");
    const fixture = readFileSync(join(__dirname, "windows-rdp-firewall-equivalence.ps1"), "utf8");
    const command = fixture.replace("param([string]$ProgramBase64)", `$ProgramBase64='${fixtureProgram}'`);
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ Equivalent: true, Cases: 13, InvalidAssociationCasesRejected: 4 });
  });

  it("builds a read-only VMID and infrastructure-bound PowerShell inspection", () => {
    const script = buildPreparedWindowsRdpCapabilityInspectionScript({
      ...EXPECTED,
      infrastructureBindingTag: `hivra-bind-${"d".repeat(32)}`,
    });

    expect(script).toContain("qm status \"$VMID\"");
    expect(script).toContain("grep -Fxq \"$EXPECTED_BINDING_TAG\"");
    expect(script).toContain("grep -Fxq \"ip=$GUEST_IP/24\"");
    expect(script).toContain("run_vmid_bound_guest_exec_stdin powershell.exe");
    const encoded = script.match(/-EncodedCommand '([^']+)'/)?.[1];
    expect(encoded).toBeDefined();
    const bootstrap = Buffer.from(encoded!, "base64").toString("utf16le");
    expect(bootstrap).toContain("[Console]::In.ReadToEnd()");
    expect(bootstrap).toContain("$raw.Length -gt 32768");
    expect(bootstrap).toContain("[ScriptBlock]::Create($program)");
    expect(encoded!.length + 100).toBeLessThan(4096);
    const payload = script.match(/printf '%s' '([^']+)' \| run_vmid_bound_guest_exec_stdin/)![1];
    expect(payload.length).toBeLessThanOrEqual(32768);
    expect(script).toContain('--pass-stdin 1');
    expect(script).toContain('cleanup_hivra_qga_result');
    const program = inspectionProgram(script);
    expect(program).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(program).toContain("GetValue('AutoAdminLogon', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)");
    expect(program).toContain("GetValueKind('AutoAdminLogon') -ne [Microsoft.Win32.RegistryValueKind]::String");
    expect(program).toContain("if ($consoleAutologon -ceq '1') { Fail 'console_autologon_enabled' }");
    expect(program).toContain("$null -ne $consoleAutologon -and ($consoleAutologon -isnot [string] -or $consoleAutologon -cnotin @('0','1'))");
    expect(program).not.toMatch(/DefaultUserName|DefaultPassword|DefaultDomainName|GetValueNames|Set-ItemProperty|logoff|tsdiscon|Restart-Computer/i);
    expect(program).toContain("Get-NetTCPConnection -State Listen -LocalPort 3389");
    expect(program).toContain("Get-NetFirewallRule -Name 'Hivra-RDP-Private-Access-v1'");
    expect(program).not.toContain("-Name 'Hivra-RDP-Private-Access-v1' -Enabled");
    expect(program).toContain("Get-NetFirewallServiceFilter");
    expect(program).toContain("Get-NetFirewallApplicationFilter");
    expect(program).toContain("rdp_firewall_program_mismatch");
    expect(program).toContain("rdp_firewall_conflict");
    expect(program).toContain("$Value = $Value + '/32'");
    expect(program).toContain("PortIncludesRdp");
    expect(program).toContain("CouldMatchTermService");
    expect(program).toContain("$Rule.Owner");
    expect(program).toContain("SSLCertificateSHA1Hash");
    expect(program).toContain("SoftwareLicensingProduct");
    expect(program).toContain("[BitConverter]::ToString");
    expect(program).not.toContain("[Convert]::ToHexString");
    expect(program).not.toMatch(/\b(?:New|Remove|Enable|Disable)-[A-Za-z]+/);
    expect(program).not.toContain("password");
  });

  it.each([
    { guestIp: "8.8.8.8" },
    { vmid: 99 },
    { computerId: "not-a-uuid" },
    { infrastructureBindingTag: "wrong" },
  ])("rejects an unsafe inspection binding: %o", invalid => {
    expect(() => buildPreparedWindowsRdpCapabilityInspectionScript({
      computerId: COMPUTER_ID,
      vmid: 410,
      guestIp: "10.240.40.10",
      infrastructureBindingTag: `hivra-bind-${"d".repeat(32)}`,
      ...invalid,
    })).toThrow("Invalid prepared Windows RDP inspection binding.");
  });

  it("accepts one fresh, exact, fully prepared descriptor without issuing a session receipt", () => {
    const result = parsePreparedWindowsRdpCapability(marked(), EXPECTED);
    expect(result).toMatchObject({
      computerId: COMPUTER_ID,
      vmid: 410,
      guestPrivateIpv4: "10.240.40.10",
      licenseStatus: "licensed",
      nla: true,
      listenerVerified: true,
      privateNetworkReachable: false,
    });
    expect(result).not.toHaveProperty("receipt");
  });

  it.each([
    ["wrong computer", { computerId: "00000000-0000-4000-8000-000000001010" }],
    ["wrong VM", { vmid: 411 }],
    ["wrong address", { guestPrivateIpv4: "10.240.40.11" }],
    ["public address", { guestPrivateIpv4: "8.8.8.8" }],
    ["unlicensed Windows", { licenseStatus: "unlicensed" }],
    ["stopped service", { rdpServiceState: "stopped" }],
    ["disabled service", { rdpServiceStartMode: "disabled" }],
    ["wrong port", { rdpPort: 3390 }],
    ["NLA disabled", { nla: false }],
    ["listener absent", { listenerVerified: false }],
    ["bad certificate", { certificateFingerprint: `sha1:${"c".repeat(40)}` }],
    ["public firewall", { route: { status: "configured-not-proven", sourceCidrs: ["0.0.0.0/0"], exclusive: true } }],
    ["unsorted firewall", { route: { status: "configured-not-proven", sourceCidrs: ["10.240.1.1/24", "10.240.0.1/24"], exclusive: true } }],
    ["nonexclusive firewall", { route: { status: "configured-not-proven", sourceCidrs: ["10.240.0.0/16"], exclusive: false } }],
    ["route falsely proven", { privateNetworkReachable: true }],
    ["stale observation", { observedAt: new Date(Date.now() - 180_000).toISOString() }],
    ["one-hour RTC timezone skew", {
      observedAt: new Date(Date.now() + 3_600_000).toISOString(),
      lastBootAt: new Date(Date.now() + 3_000_000).toISOString(),
    }],
    ["future boot", { lastBootAt: new Date(Date.now() + 60_000).toISOString() }],
    ["unknown field", { enabledTransport: "guacamole-rdp" }],
  ])("rejects %s", (_name, overrides) => {
    expect(parsePreparedWindowsRdpCapability(marked(descriptor(overrides)), EXPECTED)).toBeNull();
  });

  it("rejects malformed or ambiguous marker output", () => {
    expect(parsePreparedWindowsRdpCapability(`${WINDOWS_RDP_PREPARED_MARKER}{`, EXPECTED)).toBeNull();
    expect(parsePreparedWindowsRdpCapability(marked() + marked(), EXPECTED)).toBeNull();
    expect(parsePreparedWindowsRdpCapability(JSON.stringify(descriptor()), EXPECTED)).toBeNull();
  });

  it("does not reject a healthy long-running guest", () => {
    const oldBoot = new Date(Date.now() - 180 * 24 * 60 * 60_000).toISOString();
    expect(parsePreparedWindowsRdpCapability(marked(descriptor({ lastBootAt: oldBoot })), EXPECTED))
      .toMatchObject({ lastBootAt: oldBoot });
  });
});
