jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import {
  WINDOWS_RDP_PREPARATION_PROGRAM,
  buildWindowsRdpPreparationHostScript,
  prepareWindowsRdpGuest,
  type WindowsRdpPreparationRequest,
} from "@/lib/remote-computers/windows-rdp-preparation-host";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { buildPreparedWindowsRdpCapabilityInspectionScript } from "@/lib/remote-computers/windows-rdp-capability";

it("normalizes Windows' bare single-host firewall address back to a /32", () => {
  expect(WINDOWS_RDP_PREPARATION_PROGRAM).toContain("$Value = $Value + '/32'");
});

it("changes only an explicitly enabled boot flag after validation, without touching sessions or credentials", () => {
  const program = WINDOWS_RDP_PREPARATION_PROGRAM;
  expect(program).toContain("GetValue('AutoAdminLogon', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)");
  expect(program).toContain("GetValueKind('AutoAdminLogon') -ne [Microsoft.Win32.RegistryValueKind]::String");
  expect(program).toContain("$null -ne $flag -and ($flag -isnot [string] -or $flag -cnotin @('0','1'))");
  expect(program.indexOf("$consoleAutologon = ReadConsoleAutologon")).toBeLessThan(program.indexOf("$changed = $false"));
  expect(program).toContain("if ($consoleAutologon -ceq '1') {");
  expect(program).toContain("-Name AutoAdminLogon -Type String -Value '0'");
  expect(program).toContain("if ((ReadConsoleAutologon) -cne '0') { Fail 'console_autologon_unconfirmed' }");
  expect(program).not.toMatch(/DefaultUserName|DefaultPassword|DefaultDomainName|GetValueNames|logoff|tsdiscon|Restart-Computer|Stop-Computer/i);
});

const powershellAvailable = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { timeout: 5_000 }).status === 0;
(powershellAvailable ? it : it.skip).each([
  ["$null", "String", 0, "ok"], ["'0'", "String", 0, "ok"], ["'1'", "String", 1, "ok"],
  ["'2'", "String", 0, "console_autologon_invalid"], ["''", "String", 0, "console_autologon_invalid"],
  ["' 1'", "String", 0, "console_autologon_invalid"], ["$true", "String", 0, "console_autologon_invalid"],
  ["1", "DWord", 0, "console_autologon_invalid"], ["'1'", "ExpandString", 0, "console_autologon_invalid"],
])("operational boot policy for %s/%s makes %s writes and returns %s", (flag, kind, writes, outcome) => {
  const readFunction = WINDOWS_RDP_PREPARATION_PROGRAM.slice(
    WINDOWS_RDP_PREPARATION_PROGRAM.indexOf("function ReadConsoleAutologon"),
    WINDOWS_RDP_PREPARATION_PROGRAM.indexOf("function PrivateCidr"),
  );
  const mutation = WINDOWS_RDP_PREPARATION_PROGRAM.slice(
    WINDOWS_RDP_PREPARATION_PROGRAM.indexOf("  $consoleAutologon = ReadConsoleAutologon"),
    WINDOWS_RDP_PREPARATION_PROGRAM.indexOf("  $enabledBuiltins ="),
  );
  const inspectionScript = buildPreparedWindowsRdpCapabilityInspectionScript({
    computerId: "11111111-1111-4111-8111-111111111111", vmid: 2098,
    guestIp: "10.240.20.98", infrastructureBindingTag: "hivra-bind-" + "9".repeat(32),
  });
  const inspectionProgram = Buffer.from(inspectionScript.match(/printf '%s' '([^']+)' \| run_vmid_bound_guest_exec_stdin/)![1], "base64").toString("utf8");
  const inspection = inspectionProgram.slice(inspectionProgram.indexOf("  # Inspect only the boot flag"),
    inspectionProgram.indexOf("  $terminalServer ="));
  const fixture = `
$ErrorActionPreference = 'Stop'
$script:flag = ${flag}
$script:writes = 0
function Fail([string]$Code) { throw $Code }
function Get-Item {
  $key = [pscustomobject]@{}
  $key | Add-Member ScriptMethod GetValue { param($name, $default, $options) if ($name -cne 'AutoAdminLogon') { throw 'unexpected_value_read' }; return $script:flag }
  $key | Add-Member ScriptMethod GetValueKind { param($name) if ($name -cne 'AutoAdminLogon') { throw 'unexpected_kind_read' }; return [Microsoft.Win32.RegistryValueKind]::${kind} }
  $key | Add-Member ScriptMethod Close {}
  return $key
}
function Set-ItemProperty { param($LiteralPath, $Name, $Type, $Value, $ErrorAction) if ($Name -cne 'AutoAdminLogon' -or $Type -cne 'String' -or $Value -cne '0') { throw 'unexpected_write' }; $script:flag = $Value; $script:writes++ }
${readFunction}
try { ${mutation}; $outcome = 'ok' } catch { $outcome = $_.Exception.Message }
[Console]::Out.WriteLine($outcome + ':' + $script:writes)
$script:flag = ${flag}
$script:writes = 0
try { ${inspection}; $outcome = 'ok' } catch { $outcome = $_.Exception.Message }
[Console]::Out.WriteLine($outcome + ':' + $script:writes)
`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(fixture, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 5_000,
  });
  expect(result.status).toBe(0);
  const inspectionOutcome = flag === "'1'" && kind === "String" ? "console_autologon_enabled" : outcome;
  expect(result.stdout.trim().split(/\r?\n/)).toEqual([`${outcome}:${writes}`, `${inspectionOutcome}:0`]);
});

const USER_ID = "user_fixture";
const request: WindowsRdpPreparationRequest = {
  computerId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  vmid: 2098,
  guestPrivateIpv4: "10.240.20.98",
  gatewaySourceCidrs: ["10.240.20.1/32"],
};
const agent: RemoteDesktopAgentRow = {
  id: request.computerId, user_id: USER_ID, type: "linux-desktop", computer_profile: "windows",
  computer_substrate: "proxmox-kvm", status: "running", desired_state: "running",
  operation_id: request.operationId, operation_kind: "desktop_prepare", vmid: request.vmid,
  ip: request.guestPrivateIpv4, chat_url: "https://fixture.invalid",
  infrastructure_binding_token_hash: "9".repeat(64), infrastructure_binding_token_enforced: true,
};
const context: HivraAgentExecutionContext = {
  kind: "managed", host: "fixture", provisionerChannel: "canary",
  infrastructureBindingTagEnforced: true, infrastructureBindingTag: "hivra-bind-" + "9".repeat(32),
  env: { TEST_HOST: "owned" }, paths: { provisionerDirectory: "/fixture/provisioner",
    logDirectory: "/fixture/logs", provisionLogPrefix: "hivra-prov-", startLogPrefix: "hivra-start-",
    storage: "fixture-storage", vmSshKeyPath: null },
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValue(context);
});

function decodedProgram(script: string): string {
  const encoded = script.match(/-EncodedCommand '([^']+)'/)?.[1];
  if (!encoded) throw new Error("missing encoded program");
  return Buffer.from(encoded, "base64").toString("utf16le");
}

it("builds a bounded VMID-bound, private-only RDP preparation", () => {
  const script = buildWindowsRdpPreparationHostScript(request, context.infrastructureBindingTag);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5_000 }).status).toBe(0);
  expect(script).toContain(`VMID=${request.vmid}`);
  expect(script).toContain('grep -Fxq "$EXPECTED_BINDING_TAG"');
  expect(script).toContain('qm guest exec "$VMID" --timeout 0 -- "$@"');
  expect(script).not.toContain("ssh ");

  const program = decodedProgram(script);
  expect(program).toContain("Disable-NetFirewallRule");
  expect(program).toContain("Enable-NetFirewallRule");
  expect(program).toContain("New-NetFirewallRule -Name 'Hivra-RDP-Private-Access-v1'");
  expect(program).toContain("-RemoteAddress $sourceCidrs -Service TermService -Program '%SystemRoot%\\system32\\svchost.exe'");
  expect(program).toContain("Set-NetFirewallApplicationFilter -Program '%SystemRoot%\\system32\\svchost.exe'");
  expect(program).toContain("OwnedRuleMatches");
  expect(program).toContain("$ownedLegacy");
  expect(program).toContain("unknown_firewall_conflict");
  expect(program).toContain("CouldMatchTermService");
  expect(program).toContain("$Rule.Owner");
  expect(program).toContain("Get-NetFirewallApplicationFilter");
  expect(program).toContain("$Matches.first -le 3389");
  expect(program).toContain("Set-ItemProperty -Path $rdpPath -Name UserAuthentication");
  expect(program).not.toContain("password");
  expect(Buffer.byteLength(script)).toBeLessThan(250_000);
});

it.each([
  { guestPrivateIpv4: "8.8.8.8" },
  { vmid: 99 },
  { computerId: "invalid" },
  { operationId: "invalid" },
  { gatewaySourceCidrs: ["0.0.0.0/0"] },
  { gatewaySourceCidrs: ["10.240.20.0/16"] },
  { gatewaySourceCidrs: ["10.240.20.2/32", "10.240.20.1/32"] },
])("rejects unsafe input before generating a mutation: %o", invalid => {
  expect(() => buildWindowsRdpPreparationHostScript(
    { ...request, ...invalid }, context.infrastructureBindingTag,
  )).toThrow("Invalid Windows RDP preparation.");
});

it("executes once and accepts only the exact non-access receipt", async () => {
  const stdout = "HIVRA_WINDOWS_RDP_PREPARATION_V1 " + JSON.stringify({
    protocol: "hivra-windows-rdp-preparation-v1", ...request, changed: true, accessReady: false,
  }) + "\n";
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout, stderr: "" });
  await expect(prepareWindowsRdpGuest(USER_ID, agent, request)).resolves.toEqual({
    ok: true, targetId: "fixture", vmid: 2098, changed: true, accessReady: false,
  });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);

  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({
    ok: true, stdout: stdout.replace(request.operationId, request.computerId), stderr: "",
  });
  await expect(prepareWindowsRdpGuest(USER_ID, agent, request)).resolves.toEqual({ ok: false, code: "invalid_result" });
});

it("rejects changed execution authority before dispatch", async () => {
  for (const changed of [
    { ...agent, user_id: "other" },
    { ...agent, computer_profile: "omarchy" },
    { ...agent, computer_substrate: "docker" },
    { ...agent, status: "stopped" },
    { ...agent, operation_id: null },
    { ...agent, operation_kind: null },
    { ...agent, vmid: 2099 },
    { ...agent, ip: "10.240.20.99" },
    { ...agent, infrastructure_binding_token_hash: null },
  ]) {
    await expect(prepareWindowsRdpGuest(USER_ID, changed, request)).resolves.toEqual({
      ok: false, code: "invalid_target",
    });
  }
  expect(resolveHivraAgentExecutionContext).not.toHaveBeenCalled();
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("refuses changed host binding and uncertain transport without retrying", async () => {
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValueOnce({
    ...context, infrastructureBindingTag: "hivra-bind-" + "8".repeat(32),
  });
  await expect(prepareWindowsRdpGuest(USER_ID, agent, request)).resolves.toEqual({
    ok: false, code: "authority_unavailable",
  });
  expect(runProxmoxHostScript).not.toHaveBeenCalled();

  jest.mocked(runProxmoxHostScript).mockRejectedValueOnce(new Error("private details"));
  await expect(prepareWindowsRdpGuest(USER_ID, agent, request)).resolves.toEqual({
    ok: false, code: "transport_failed",
  });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);
});
