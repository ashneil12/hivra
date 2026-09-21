import {
  createWindowsRdpCredentialLease,
  openWindowsRdpCredentialLease,
  type WindowsRdpCredentialBinding,
} from "@/lib/remote-computers/windows-rdp-credential";

jest.mock("server-only", () => ({}));

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const binding: WindowsRdpCredentialBinding = {
  userId: "11111111-1111-4111-8111-111111111111",
  computerId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  activationId: "44444444-4444-4444-8444-444444444444",
  capabilityGeneration: "55555555-5555-4555-8555-555555555555",
  guestBootIdentitySha256: "a".repeat(64),
  streamingMode: "hq",
};
const expiresAt = new Date(NOW + 240_000).toISOString();
const identityCrypto = { encrypt: (value: string) => value, decrypt: (value: string) => value };

describe("Windows RDP credential lease", () => {
  it("creates a Windows-compatible credential and opens it only for its exact binding", () => {
    const created = createWindowsRdpCredentialLease(
      { binding, expiresAt },
      { ...identityCrypto, now: () => NOW, randomBytes: size => Buffer.alloc(size, 7) },
    );
    expect(created).not.toBeNull();
    expect(created?.credential.username).toBe("hivra-33333333333343");
    expect(created?.credential.username.length).toBeLessThanOrEqual(20);
    expect(created?.credential.password).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*!)[A-Za-z0-9_!-]{32,128}$/);
    expect(openWindowsRdpCredentialLease(
      { encryptedLease: created!.encryptedLease, expectedBinding: binding },
      { ...identityCrypto, now: () => NOW + 1_000 },
    )).toEqual({ ...created?.credential, expiresAt });
  });

  it("accepts the owner identifiers used by the authenticated control plane", () => {
    const clerkBinding = { ...binding, userId: "user_0000000000000000" };
    const created = createWindowsRdpCredentialLease(
      { binding: clerkBinding, expiresAt },
      { ...identityCrypto, now: () => NOW, randomBytes: size => Buffer.alloc(size, 7) },
    );
    expect(created).not.toBeNull();
    expect(openWindowsRdpCredentialLease(
      { encryptedLease: created!.encryptedLease, expectedBinding: clerkBinding },
      { ...identityCrypto, now: () => NOW + 1_000 },
    )).toEqual({ ...created?.credential, expiresAt });
  });

  it("uses fresh entropy and does not expose binding or credentials in a real encrypted envelope", () => {
    const oldKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "12".repeat(32);
    try {
      const first = createWindowsRdpCredentialLease({ binding, expiresAt }, { now: () => NOW });
      const second = createWindowsRdpCredentialLease({ binding, expiresAt }, { now: () => NOW });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first?.credential.password).not.toBe(second?.credential.password);
      expect(first?.encryptedLease).not.toBe(second?.encryptedLease);
      expect(first?.encryptedLease).not.toContain(binding.sessionId);
      expect(first?.encryptedLease).not.toContain(first!.credential.username);
      expect(first?.encryptedLease).not.toContain(first!.credential.password);
      expect(openWindowsRdpCredentialLease(
        { encryptedLease: first!.encryptedLease, expectedBinding: binding },
        { now: () => NOW + 1_000 },
      )).toEqual({ ...first?.credential, expiresAt });
    } finally {
      if (oldKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = oldKey;
    }
  });

  it.each([
    ["owner", { userId: "00000000-0000-4000-8000-000000001011" }],
    ["computer", { computerId: "00000000-0000-4000-8000-000000001012" }],
    ["session", { sessionId: "00000000-0000-4000-8000-000000001013" }],
    ["activation", { activationId: "64444444-4444-4444-8444-444444444444" }],
    ["generation", { capabilityGeneration: "00000000-0000-4000-8000-000000001014" }],
    ["guest boot", { guestBootIdentitySha256: "b".repeat(64) }],
    ["mode", { streamingMode: "performance" }],
  ])("rejects a mismatched %s binding", (_name, difference) => {
    const created = createWindowsRdpCredentialLease(
      { binding, expiresAt },
      { ...identityCrypto, now: () => NOW, randomBytes: size => Buffer.alloc(size, 7) },
    )!;
    expect(openWindowsRdpCredentialLease(
      { encryptedLease: created.encryptedLease, expectedBinding: { ...binding, ...difference } as WindowsRdpCredentialBinding },
      { ...identityCrypto, now: () => NOW + 1_000 },
    )).toBeNull();
  });

  it("rejects expired, future-issued and overlong leases", () => {
    const base = JSON.parse(createWindowsRdpCredentialLease(
      { binding, expiresAt },
      { ...identityCrypto, now: () => NOW, randomBytes: size => Buffer.alloc(size, 7) },
    )!.encryptedLease) as Record<string, unknown>;
    const open = (value: Record<string, unknown>, now = NOW) => openWindowsRdpCredentialLease(
      { encryptedLease: JSON.stringify(value), expectedBinding: binding },
      { ...identityCrypto, now: () => now },
    );
    expect(open(base, NOW + 240_000)).toBeNull();
    expect(open({ ...base, issuedAt: new Date(NOW + 31_000).toISOString() })).toBeNull();
    expect(open({ ...base, expiresAt: new Date(NOW + 300_001).toISOString() })).toBeNull();
  });

  it("rejects invalid authority, expiry, entropy and encrypted payloads", () => {
    expect(createWindowsRdpCredentialLease({ binding, expiresAt: new Date(NOW + 300_001).toISOString() }, {
      ...identityCrypto, now: () => NOW,
    })).toBeNull();
    expect(createWindowsRdpCredentialLease({ binding: { ...binding, userId: "" }, expiresAt }, {
      ...identityCrypto, now: () => NOW,
    })).toBeNull();
    expect(createWindowsRdpCredentialLease({ binding: { ...binding, userId: "u".repeat(257) }, expiresAt }, {
      ...identityCrypto, now: () => NOW,
    })).toBeNull();
    expect(createWindowsRdpCredentialLease({ binding, expiresAt }, {
      ...identityCrypto, now: () => NOW, randomBytes: () => Buffer.alloc(29),
    })).toBeNull();
    expect(openWindowsRdpCredentialLease(
      { encryptedLease: "not-a-lease", expectedBinding: binding },
      { ...identityCrypto, now: () => NOW },
    )).toBeNull();
  });
});
