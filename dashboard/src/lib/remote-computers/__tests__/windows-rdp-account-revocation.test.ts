import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

import {
  buildWindowsRdpAccountRevocationBundle,
  parseWindowsRdpAccountRevocationReceipt,
  type WindowsRdpAccountRevocationRequest,
} from "@/lib/remote-computers/windows-rdp-account-revocation";

jest.mock("server-only", () => ({}));

const request: WindowsRdpAccountRevocationRequest = {
  computerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "33333333-3333-4333-8333-333333333333",
  activationId: "44444444-4444-4444-8444-444444444444",
  capabilityGeneration: "55555555-5555-4555-8555-555555555555",
  vmid: 2098,
  guestPrivateIpv4: "10.240.20.98",
  guestBootIdentitySha256: "a".repeat(64),
  username: "hivra-33333333333343",
};
const tag = `hivra-bind-${"9".repeat(32)}`;

function receipt(overrides: Record<string, unknown> = {}): string {
  return "HIVRA_WINDOWS_RDP_ACCOUNT_REVOKED_V1 " + JSON.stringify({
    protocol: "hivra-windows-rdp-account-revoked-v1",
    ...request,
    accountRemoved: true,
    credentialReady: false,
    ...overrides,
  }) + "\n";
}

describe("Windows RDP account revocation", () => {
  it("builds an exact VMID-bound, idempotent account deletion", () => {
    const bundle = buildWindowsRdpAccountRevocationBundle(request, tag);
    expect(spawnSync("bash", ["-n"], { input: bundle.script, encoding: "utf8", timeout: 5_000 }).status).toBe(0);
    expect(bundle.script).not.toContain(request.username);
    expect(bundle.stdin).toContain(request.username);
    expect(bundle.script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
    const encoded = bundle.script.match(/-EncodedCommand '([^']+)'/)?.[1];
    expect(encoded).toBeDefined();
    const program = Buffer.from(encoded!, "base64").toString("utf16le");
    expect(program).toContain("guest_boot_changed");
    expect(program).toContain("account_conflict");
    expect(program).toContain("Disable-LocalUser");
    expect(program).toContain("Remove-LocalGroupMember -SID 'S-1-5-32-555'");
    expect(program).toContain("Remove-LocalUser");
    expect(program.indexOf("Disable-LocalUser")).toBeLessThan(program.indexOf("Remove-LocalUser"));
    expect(program).toContain("account_removal_unproven");
  });

  it.each([
    { vmid: 99 },
    { guestPrivateIpv4: "1.1.1.1" },
    { sessionId: "invalid" },
    { guestBootIdentitySha256: "invalid" },
    { username: "Administrator" },
  ])("rejects unsafe input: %o", invalid => {
    expect(() => buildWindowsRdpAccountRevocationBundle({ ...request, ...invalid } as WindowsRdpAccountRevocationRequest, tag))
      .toThrow("Invalid Windows RDP account revocation.");
  });

  it("accepts only the exact removal receipt", () => {
    expect(parseWindowsRdpAccountRevocationReceipt(receipt(), request)).toEqual({
      username: request.username, accountRemoved: true, credentialReady: false,
    });
    expect(parseWindowsRdpAccountRevocationReceipt(receipt({ accountRemoved: false }), request)).toEqual({
      username: request.username, accountRemoved: false, credentialReady: false,
    });
    expect(parseWindowsRdpAccountRevocationReceipt(receipt({ activationId: request.sessionId }), request)).toBeNull();
    expect(parseWindowsRdpAccountRevocationReceipt(receipt({ credentialReady: true }), request)).toBeNull();
    expect(parseWindowsRdpAccountRevocationReceipt(receipt({ password: "must-not-appear" }), request)).toBeNull();
    expect(parseWindowsRdpAccountRevocationReceipt(receipt() + receipt(), request)).toBeNull();
  });
});
