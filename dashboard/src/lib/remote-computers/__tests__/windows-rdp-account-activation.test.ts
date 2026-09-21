import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

import {
  buildWindowsRdpAccountActivationBundle,
  parseWindowsRdpAccountActivationReceipt,
  type WindowsRdpAccountActivationRequest,
} from "@/lib/remote-computers/windows-rdp-account-activation";

jest.mock("server-only", () => ({}));

const request: WindowsRdpAccountActivationRequest = {
  computerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "33333333-3333-4333-8333-333333333333",
  activationId: "44444444-4444-4444-8444-444444444444",
  capabilityGeneration: "55555555-5555-4555-8555-555555555555",
  vmid: 2098,
  guestPrivateIpv4: "10.240.20.98",
  guestBootIdentitySha256: "a".repeat(64),
  streamingMode: "hq",
  username: "hivra-33333333333343",
  password: `Aa1!${"x".repeat(40)}`,
  expiresAt: new Date(Date.now() + 240_000).toISOString(),
};
const tag = `hivra-bind-${"9".repeat(32)}`;

function receipt(overrides: Record<string, unknown> = {}): string {
  return "HIVRA_WINDOWS_RDP_ACCOUNT_READY_V1 " + JSON.stringify({
    protocol: "hivra-windows-rdp-account-ready-v1",
    computerId: request.computerId,
    sessionId: request.sessionId,
    activationId: request.activationId,
    capabilityGeneration: request.capabilityGeneration,
    vmid: request.vmid,
    guestPrivateIpv4: request.guestPrivateIpv4,
    guestBootIdentitySha256: request.guestBootIdentitySha256,
    streamingMode: request.streamingMode,
    username: request.username,
    expiresAt: request.expiresAt,
    accountCreated: true,
    credentialReady: true,
    ...overrides,
  }) + "\n";
}

describe("Windows RDP account activation", () => {
  it("keeps the credential on stdin across an exact VMID-bound QGA dispatch", () => {
    const bundle = buildWindowsRdpAccountActivationBundle(request, tag);
    expect(spawnSync("bash", ["-n"], { input: bundle.script, encoding: "utf8", timeout: 5_000 }).status).toBe(0);
    expect(bundle.stdin).toContain(request.password);
    expect(bundle.script).not.toContain(request.password);
    expect(bundle.script).not.toContain(request.username);
    expect(bundle.script).toContain(`VMID=${request.vmid}`);
    expect(bundle.script).toContain('grep -Fxq "$EXPECTED_BINDING_TAG"');
    expect(bundle.script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
    expect(bundle.script).toContain("run_vmid_bound_guest_exec_stdin powershell.exe");
    expect(bundle.script).not.toContain("ssh ");

    const encoded = bundle.script.match(/-EncodedCommand '([^']+)'/)?.[1];
    expect(encoded).toBeDefined();
    const program = Buffer.from(encoded!, "base64").toString("utf16le");
    expect(program).toContain("[Console]::In.ReadToEnd()");
    expect(program).toContain("guest_boot_changed");
    expect(program).toContain("New-LocalUser");
    expect(program).toContain("Set-LocalUser");
    expect(program).toContain("Enable-LocalUser");
    expect(program).toContain("Get-LocalGroup -SID 'S-1-5-32-544'");
    expect(program).toContain("Get-LocalGroup -SID 'S-1-5-32-555'");
    expect(program).toContain("account_is_administrator");
    expect(program).not.toContain(request.password);
  });

  it.each([
    { vmid: 99 },
    { guestPrivateIpv4: "8.8.8.8" },
    { guestBootIdentitySha256: "invalid" },
    { streamingMode: "automatic" },
    { username: "Administrator" },
    { password: "weak" },
    { expiresAt: new Date(Date.now() + 360_000).toISOString() },
  ])("rejects unsafe input before generating a mutation: %o", invalid => {
    expect(() => buildWindowsRdpAccountActivationBundle({ ...request, ...invalid } as WindowsRdpAccountActivationRequest, tag))
      .toThrow("Invalid Windows RDP account activation.");
  });

  it("accepts only an exact credential-ready receipt without exposing the password", () => {
    expect(parseWindowsRdpAccountActivationReceipt(receipt(), request)).toEqual({
      username: request.username,
      expiresAt: request.expiresAt,
      accountCreated: true,
      credentialReady: true,
    });
    expect(receipt()).not.toContain(request.password);
    expect(parseWindowsRdpAccountActivationReceipt(receipt({ streamingMode: "performance" }), request)).toBeNull();
    expect(parseWindowsRdpAccountActivationReceipt(receipt({ activationId: request.sessionId }), request)).toBeNull();
    expect(parseWindowsRdpAccountActivationReceipt(receipt({ credentialReady: false }), request)).toBeNull();
    expect(parseWindowsRdpAccountActivationReceipt(receipt({ password: request.password }), request)).toBeNull();
    expect(parseWindowsRdpAccountActivationReceipt(receipt() + receipt(), request)).toBeNull();
  });
});
