import { createHash, generateKeyPairSync } from "node:crypto";
import {
  canonicalFirstBootHostKey, createFirstBootChallenge, FIRST_BOOT_ENROLLMENT_TTL_MS,
  FIRST_BOOT_RECIPE_VERSION, FirstBootEnrollmentError, inspectFirstBootEnrollmentProof,
  type FirstBootBinding,
} from "../first-boot-enrollment";

const now = new Date("2026-08-27T15:00:00.000Z");
const binding: FirstBootBinding = {
  userId: "user_first_boot", connectionId: "11111111-1111-4111-8111-111111111111",
  connectionRevision: 2, orderId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  quoteFingerprint: "a".repeat(64), recipeVersion: FIRST_BOOT_RECIPE_VERSION,
};
function hostKey() {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([
    Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
    Buffer.from(jwk.x!, "base64url"),
  ]);
  return { publicKey: "ssh-ed25519 " + blob.toString("base64"),
    fingerprint: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "") };
}
function fixture() {
  const proof = createFirstBootChallenge(binding, now);
  const key = hostKey();
  return {
    key, proof,
    input: {
      record: { challenge: proof.challenge, phase: "awaiting_identity" as const, enrolledHostPublicKey: null },
      currentBinding: { ...binding }, expectedProviderServerId: "42", token: proof.token, now,
      registration: { version: 1, orderId: binding.orderId, attemptId: binding.attemptId,
        providerServerId: "42", hostPublicKey: key.publicKey + " root@temporary-host" },
    },
  };
}
function rejects(run: () => unknown, code: FirstBootEnrollmentError["code"]) {
  expect(run).toThrow(FirstBootEnrollmentError);
  expect(run).toThrow("First-boot enrollment failed: " + code);
}

describe("one-purpose first-boot SSH identity proof", () => {
  it("creates unpredictable 256-bit tokens with scope-bound private verifiers and exact expiry", () => {
    const one = createFirstBootChallenge(binding, now);
    const two = createFirstBootChallenge(binding, now);
    expect(one.token).toMatch(/^hbe1_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(one.token.slice(5), "base64url")).toHaveLength(32);
    expect(one.token).not.toBe(two.token);
    expect(one.challenge.verifierSha256).not.toBe(two.challenge.verifierSha256);
    expect(JSON.stringify(one.challenge)).not.toContain(one.token);
    expect(Date.parse(one.challenge.expiresAt) - Date.parse(one.challenge.issuedAt)).toBe(FIRST_BOOT_ENROLLMENT_TTL_MS);
  });
  it("accepts only a candidate and strips comments without granting readiness", () => {
    const { input, key } = fixture();
    const untouched = structuredClone(input);
    expect(inspectFirstBootEnrollmentProof(input)).toEqual({
      kind: "candidate", registration: { ...input.registration, hostPublicKey: key.publicKey },
      hostPublicKey: key.publicKey, hostFingerprintSha256: key.fingerprint,
    });
    expect(input).toEqual(untouched);
  });
  it.each([
    ["userId", "someone_else"],
    ["connectionId", "44444444-4444-4444-8444-444444444444"],
    ["connectionRevision", 3],
    ["orderId", "44444444-4444-4444-8444-444444444444"],
    ["attemptId", "44444444-4444-4444-8444-444444444444"],
    ["quoteFingerprint", "b".repeat(64)], ["recipeVersion", "later-recipe"],
  ])("rejects changed current %s and refuses a rewritten challenge", (field, value) => {
    const { input } = fixture();
    const changed = { ...input.currentBinding, [field]: value };
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, currentBinding: changed }), "invalid_proof");
    const record = { ...input.record, challenge: { ...input.record.challenge, binding: changed } };
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record, currentBinding: changed }), "invalid_proof");
  });
  it.each(["orderId", "attemptId", "providerServerId"])("rejects a registration for another %s", field => {
    const { input } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input,
      registration: { ...input.registration, [field]: field === "providerServerId" ? "43" : "44444444-4444-4444-8444-444444444444" },
    }), "invalid_proof");
  });
  it.each(["", "0", "-1", "0042", "42x", "1e2", "9007199254740992", "42\n"])("safely rejects malformed provider ID %j", id => {
    const { input } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, expectedProviderServerId: id }), "invalid_proof");
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, registration: { ...input.registration, providerServerId: id } }), "invalid_proof");
  });
  it.each([-1, FIRST_BOOT_ENROLLMENT_TTL_MS, FIRST_BOOT_ENROLLMENT_TTL_MS + 1])("rejects time outside its exact window: %i", offset => {
    const { input } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, now: new Date(now.getTime() + offset) }), "expired");
  });
  it("rejects an invalid clock, rewritten time window and verifier", () => {
    const { input } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, now: new Date(NaN) }), "expired");
    const challenge = { ...input.record.challenge,
      issuedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + FIRST_BOOT_ENROLLMENT_TTL_MS - 60_000).toISOString(),
    };
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record: { ...input.record, challenge } }), "invalid_proof");
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record: { ...input.record,
      challenge: { ...input.record.challenge, verifierSha256: "0".repeat(64) } } }), "invalid_proof");
  });
  it("permits only exact-key acknowledgement replay, only before expiry", () => {
    const { input, key } = fixture();
    const record = { ...input.record, phase: "enrolled" as const, enrolledHostPublicKey: key.publicKey };
    expect(inspectFirstBootEnrollmentProof({ ...input, record }).kind).toBe("acknowledgement_replay");
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record,
      registration: { ...input.registration, hostPublicKey: hostKey().publicKey } }), "identity_changed");
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record,
      now: new Date(now.getTime() + FIRST_BOOT_ENROLLMENT_TTL_MS) }), "expired");
  });
  it.each(["revoked", "failed"] as const)("rejects a %s attempt", phase => {
    const { input } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record: { ...input.record, phase } }), "not_active");
  });
  it("rejects inconsistent awaiting state and missing records", () => {
    const { input, key } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input,
      record: { ...input.record, enrolledHostPublicKey: key.publicKey } }), "not_active");
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record: undefined! }), "invalid_proof");
  });
  it("rejects extra registration authority and does not disclose invalid proofs", () => {
    const { input } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, registration: { ...input.registration, ready: true } }), "invalid_proof");
    const token = "hbe1_" + "secret".repeat(7) + "x";
    try { inspectFirstBootEnrollmentProof({ ...input, token }); } catch (error) {
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(input.record.challenge.verifierSha256);
    }
  });
  it("uses canonical UUID and timestamp spellings across the guest/server boundary", () => {
    rejects(() => createFirstBootChallenge({ ...binding, orderId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }, now), "invalid_binding");
    rejects(() => createFirstBootChallenge(binding, new Date(NaN)), "invalid_binding");
    rejects(() => createFirstBootChallenge(binding, new Date(8.64e15)), "invalid_binding");
    const { input } = fixture();
    rejects(() => inspectFirstBootEnrollmentProof({ ...input, record: { ...input.record,
      challenge: { ...input.record.challenge, issuedAt: "2026-08-27T15:00:00+00:00" } } }), "invalid_proof");
  });
  it("validates exact Ed25519 framing and independent SHA256 fingerprints", () => {
    const key = hostKey();
    expect(canonicalFirstBootHostKey(key.publicKey)).toEqual({ publicKey: key.publicKey, fingerprintSha256: key.fingerprint });
    const zero = "ssh-ed25519 " + Buffer.concat([
      Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32),
    ]).toString("base64");
    for (const invalid of [zero, "ssh-rsa " + "A".repeat(68), "ssh-ed25519 " + "A".repeat(68),
      key.publicKey + "\n", key.publicKey + "=", key.publicKey + " comment with spaces", "", undefined!]) {
      rejects(() => canonicalFirstBootHostKey(invalid), "invalid_proof");
    }
  });
});
