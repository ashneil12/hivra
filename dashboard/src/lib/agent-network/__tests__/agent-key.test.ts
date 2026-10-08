import { generateKeyPairSync, sign } from "node:crypto";

import { AGENT_KEY_PROOF_CONTEXT, agentKeyProofMessage, isAgentPublicKey, verifyAgentKeyProof } from "../agent-key";
import { ALICE, ORG } from "./fixtures";

// Generated here, the way the agent link generates its own: the private half stays
// in the test and is never handed to a function under test.
function agentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKey: spki.subarray(spki.length - 32).toString("base64url") };
}

const NONCE = "nonce-0123456789abcdef";
const proof = (key: ReturnType<typeof agentKey>, overrides: Record<string, string> = {}) => {
  const input = { publicKey: key.publicKey, orgId: ORG, principalId: ALICE, nonce: NONCE, ...overrides };
  return { ...input, signature: sign(null, agentKeyProofMessage(input), key.privateKey).toString("base64url"), ...overrides };
};

describe("agent key proof of possession", () => {
  it("accepts a signature made with the private half of the registered key", () => {
    expect(verifyAgentKeyProof(proof(agentKey()))).toEqual({ ok: true });
  });

  it("signs a message that names the context, the org, the principal and the nonce", () => {
    expect(agentKeyProofMessage({ orgId: ORG.toUpperCase(), principalId: ALICE, nonce: NONCE }).toString()).toBe(
      [AGENT_KEY_PROOF_CONTEXT, ORG, ALICE, NONCE].join("\n")
    );
  });

  it("rejects a proof made with a different key", () => {
    const registered = agentKey();
    const attacker = agentKey();
    const forged = { ...proof(attacker), publicKey: registered.publicKey };
    expect(verifyAgentKeyProof(forged)).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it.each([
    ["a different organization", { orgId: "00000000-0000-4000-8000-0000000000ff" }],
    ["a different principal", { principalId: "00000000-0000-4000-8000-0000000000fe" }],
    ["a different nonce", { nonce: "nonce-ffffffffffffffff" }],
  ])("rejects a proof replayed for %s", (_name, change) => {
    const key = agentKey();
    const original = proof(key);
    expect(verifyAgentKeyProof({ ...original, ...change })).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("accepts only a raw public key in its one spelling, never private key material", () => {
    const key = agentKey();
    const privateDer = (key.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer);
    const privatePem = key.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    expect(isAgentPublicKey(key.publicKey)).toBe(true);
    // A PKCS#8 private key (48 bytes) or a PEM is not a 32-byte public key.
    expect(isAgentPublicKey(privateDer.toString("base64url"))).toBe(false);
    expect(isAgentPublicKey(privatePem)).toBe(false);
    expect(isAgentPublicKey(`${key.publicKey}=`)).toBe(false);
    expect(isAgentPublicKey(key.publicKey.slice(0, 42))).toBe(false);
    expect(isAgentPublicKey("")).toBe(false);
    expect(isAgentPublicKey(null)).toBe(false);
    expect(verifyAgentKeyProof({ ...proof(key), publicKey: privateDer.toString("base64url") })).toEqual({ ok: false, reason: "malformed_public_key" });
    expect(verifyAgentKeyProof({ ...proof(key), publicKey: privatePem })).toEqual({ ok: false, reason: "malformed_public_key" });
  });

  it.each([
    ["no signature", { signature: "" }],
    ["a short signature", { signature: "AAAA" }],
    ["a non-base64url signature", { signature: "!".repeat(86) }],
  ])("rejects %s", (_name, change) => {
    expect(verifyAgentKeyProof({ ...proof(agentKey()), ...change })).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it.each([
    ["a short nonce", { nonce: "short" }],
    ["a nonce with a newline", { nonce: "a-nonce-0123456789\nforged-line" }],
    ["an enormous nonce", { nonce: "n".repeat(257) }],
  ])("rejects %s", (_name, change) => {
    expect(verifyAgentKeyProof({ ...proof(agentKey()), ...change })).toEqual({ ok: false, reason: "malformed_input" });
  });
});
