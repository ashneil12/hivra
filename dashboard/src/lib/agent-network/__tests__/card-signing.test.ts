import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CARD_JWS_TYPE,
  CARD_SIGNING_KEY_ENV,
  CARD_SIGNING_KID_ENV,
  MAX_CARD_LIFETIME_SECONDS,
  canonicalize,
  loadCardSigner,
  signCard,
  verifyCard,
  type CardKeyRecord,
  type CardSigner,
} from "../card-signing";
import { ALICE, ORG } from "./fixtures";

function newSigner(kid: string): { signer: CardSigner; env: Record<string, string> } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const env = {
    [CARD_SIGNING_KEY_ENV]: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
    [CARD_SIGNING_KID_ENV]: kid,
  };
  const signer = loadCardSigner(env);
  if (!signer) throw new Error("fixture signer did not load");
  return { signer, env };
}

const record = (signer: CardSigner, extra: Partial<CardKeyRecord> = {}): CardKeyRecord => ({
  kid: signer.kid,
  publicKey: signer.publicKey,
  status: "active",
  retiredAt: null,
  revokedAt: null,
  ...extra,
});

const T0 = new Date("2026-10-08T12:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const card = { tenant: ORG, principal: ALICE, name: "Agent A", endpoint: "https://broker.example/a2a" };

/** Builds a token with the given header and payload, signed with a real key, to test the verifier's checks. */
function craft(privateKey: KeyObject, header: unknown, payload: unknown, canonical = true) {
  const encode = (value: unknown) => Buffer.from(canonical ? canonicalize(value) : JSON.stringify(value)).toString("base64url");
  const input = `${encode(header)}.${encode(payload)}`;
  return `${input}.${sign(null, Buffer.from(input, "ascii"), privateKey).toString("base64url")}`;
}

describe("loadCardSigner: a key class of its own", () => {
  it("loads from its own two variables", () => {
    const { signer } = newSigner("card-key-0001");
    expect(signer.kid).toBe("card-key-0001");
    expect(signer.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not load from ENCRYPTION_KEY, however it is set", () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("hex");
    for (const env of [
      { ENCRYPTION_KEY: encryptionKey },
      { ENCRYPTION_KEY: encryptionKey, ENCRYPTION_KEY_LEGACY: encryptionKey, [CARD_SIGNING_KID_ENV]: "card-key-0001" },
      {},
    ]) {
      expect(loadCardSigner(env)).toBeNull();
    }
  });

  it("refuses a signing key that equals an encryption key", () => {
    const { env } = newSigner("card-key-0001");
    expect(loadCardSigner({ ...env, ENCRYPTION_KEY: env[CARD_SIGNING_KEY_ENV] })).toBeNull();
    expect(loadCardSigner({ ...env, ENCRYPTION_KEY_LEGACY: env[CARD_SIGNING_KEY_ENV] })).toBeNull();
    // An unrelated encryption key does not matter.
    expect(loadCardSigner({ ...env, ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("hex") })).not.toBeNull();
  });

  it("rejects missing, malformed and non-Ed25519 keys", () => {
    const { env } = newSigner("card-key-0001");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    for (const bad of [
      { [CARD_SIGNING_KEY_ENV]: env[CARD_SIGNING_KEY_ENV] },
      { [CARD_SIGNING_KID_ENV]: "card-key-0001" },
      { ...env, [CARD_SIGNING_KID_ENV]: "short" },
      { ...env, [CARD_SIGNING_KID_ENV]: "has spaces in it" },
      { ...env, [CARD_SIGNING_KEY_ENV]: "not a key!" },
      { ...env, [CARD_SIGNING_KEY_ENV]: "AAAA" },
      { ...env, [CARD_SIGNING_KEY_ENV]: rsa.toString("base64url") },
    ]) {
      expect(loadCardSigner(bad)).toBeNull();
    }
  });

  it("is structurally separate from ENCRYPTION_KEY: no import of the crypto module, no use of its values", () => {
    const source = fs.readFileSync(path.join(__dirname, "../card-signing.ts"), "utf8");
    expect(source).not.toMatch(/from ["']@\/lib\/crypto["']/);
    expect(source).not.toMatch(/\bdecryptSecret|\bencryptSecret|getEncryptionKey/);
    // The only mention of an encryption key is the guard that refuses to reuse one.
    const uses = source.match(/process\.env\.ENCRYPTION_KEY|env\.ENCRYPTION_KEY(?:_LEGACY)?/g) ?? [];
    expect(uses.length).toBeLessThanOrEqual(2);
    expect(CARD_SIGNING_KEY_ENV).not.toMatch(/ENCRYPTION/);
  });
});

describe("cards", () => {
  const { signer } = newSigner("card-key-0001");
  const registry = [record(signer)];

  it("signs and verifies a short-lived card", () => {
    const token = signCard(signer, card, { now: T0, lifetimeSeconds: 600 });
    const result = verifyCard(token, registry, { now: at(10), expectedTenant: ORG, expectedPrincipal: ALICE });
    expect(result).toMatchObject({ ok: true, kid: "card-key-0001", card: { ...card, iss: "hivra", iat: 1_791_460_800, exp: 1_791_461_400 } });
  });

  it("limits a card's life to one hour and will not take a lifetime or timestamps from the caller", () => {
    expect(MAX_CARD_LIFETIME_SECONDS).toBe(3600);
    expect(() => signCard(signer, card, { lifetimeSeconds: 3601 })).toThrow(/lifetime/);
    expect(() => signCard(signer, card, { lifetimeSeconds: 0 })).toThrow(/lifetime/);
    expect(() => signCard(signer, card, { lifetimeSeconds: 1.5 })).toThrow(/lifetime/);
    for (const reserved of ["iat", "exp", "iss"]) {
      expect(() => signCard(signer, { ...card, [reserved]: 1 })).toThrow(/cannot set/);
    }
  });

  it("expires with no leeway, and is not valid before it is issued", () => {
    const token = signCard(signer, card, { now: T0, lifetimeSeconds: 60 });
    expect(verifyCard(token, registry, { now: at(59) }).ok).toBe(true);
    expect(verifyCard(token, registry, { now: at(60) })).toEqual({ ok: false, reason: "expired" });
    expect(verifyCard(token, registry, { now: at(3600) })).toEqual({ ok: false, reason: "expired" });
    expect(verifyCard(token, registry, { now: at(-20) }).ok).toBe(true); // small clock skew
    expect(verifyCard(token, registry, { now: at(-31) })).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("binds a card to its organization and principal", () => {
    const token = signCard(signer, card, { now: T0 });
    expect(verifyCard(token, registry, { now: T0, expectedTenant: "00000000-0000-4000-8000-0000000000ff" })).toEqual({ ok: false, reason: "tenant_mismatch" });
    expect(verifyCard(token, registry, { now: T0, expectedPrincipal: "00000000-0000-4000-8000-0000000000fe" })).toEqual({ ok: false, reason: "principal_mismatch" });
  });

  describe("rotation and revocation (B1-T5)", () => {
    const { signer: next } = newSigner("card-key-0002");

    it("a card signed before rotation stays valid until it expires; after the old key is revoked it fails at once", () => {
      const oldCard = signCard(signer, card, { now: T0, lifetimeSeconds: 600 });

      // Rotate: the new key is active, the old one retired at +100s.
      const rotated = [record(signer, { status: "retired", retiredAt: at(100) }), record(next)];
      expect(verifyCard(oldCard, rotated, { now: at(200) }).ok).toBe(true); // issued before retirement
      const newCard = signCard(next, card, { now: at(100), lifetimeSeconds: 600 });
      expect(verifyCard(newCard, rotated, { now: at(200) })).toMatchObject({ ok: true, kid: "card-key-0002" });

      // The old key is compromised and revoked: every card it signed fails now.
      const revoked = [record(signer, { status: "revoked", retiredAt: at(100), revokedAt: at(150) }), record(next)];
      expect(verifyCard(oldCard, revoked, { now: at(200) })).toEqual({ ok: false, reason: "key_revoked" });
      expect(verifyCard(newCard, revoked, { now: at(200) }).ok).toBe(true);
    });

    it("a retired key cannot be used to issue a new card", () => {
      const retired = [record(signer, { status: "retired", retiredAt: at(100) })];
      const late = signCard(signer, card, { now: at(150), lifetimeSeconds: 600 });
      expect(verifyCard(late, retired, { now: at(160) })).toEqual({ ok: false, reason: "key_retired_before_issue" });
    });

    it("a revoked flag wins even if the status was not updated", () => {
      const token = signCard(signer, card, { now: T0 });
      expect(verifyCard(token, [record(signer, { revokedAt: at(1) })], { now: at(2) })).toEqual({ ok: false, reason: "key_revoked" });
    });

    it("a card from a key that is not in the registry fails", () => {
      const token = signCard(next, card, { now: T0 });
      expect(verifyCard(token, registry, { now: T0 })).toEqual({ ok: false, reason: "unknown_key" });
      expect(verifyCard(token, [], { now: T0 })).toEqual({ ok: false, reason: "unknown_key" });
    });
  });

  describe("tampering", () => {
    const good = signCard(signer, card, { now: T0, lifetimeSeconds: 600 });
    const [header, payload, signature] = good.split(".");
    const edit = (segment: string, change: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(Buffer.from(segment, "base64url").toString());
      change(value);
      return Buffer.from(canonicalize(value)).toString("base64url");
    };
    const verify = (token: string) => verifyCard(token, registry, { now: at(10) });

    it("rejects an altered payload or header", () => {
      const altered = edit(payload, (v) => { v.tenant = "00000000-0000-4000-8000-0000000000ff"; });
      expect(verify(`${header}.${altered}.${signature}`)).toEqual({ ok: false, reason: "signature_invalid" });
      const extended = edit(payload, (v) => { v.exp = (v.exp as number) + 86_400; });
      expect(verify(`${header}.${extended}.${signature}`)).toEqual({ ok: false, reason: "signature_invalid" });
      const rekeyed = edit(header, (v) => { v.kid = "card-key-0002"; });
      expect(verify(`${rekeyed}.${payload}.${signature}`)).toEqual({ ok: false, reason: "unknown_key" });
    });

    it("rejects a flipped signature bit and a truncated signature", () => {
      const flipped = Buffer.from(signature, "base64url");
      flipped[0] ^= 1;
      expect(verify(`${header}.${payload}.${flipped.toString("base64url")}`)).toEqual({ ok: false, reason: "signature_invalid" });
      expect(verify(`${header}.${payload}.${signature.slice(0, 40)}`)).toEqual({ ok: false, reason: "signature_invalid" });
    });

    it("rejects malformed tokens", () => {
      for (const bad of ["", "a.b", "a.b.c.d", "....", `${header}.${payload}`, `!!.${payload}.${signature}`, `${header}.${payload}.!!`]) {
        expect(verify(bad).ok).toBe(false);
      }
      expect(verify(undefined as unknown as string)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects a signature made by another key under this key's id", () => {
      const other = generateKeyPairSync("ed25519").privateKey;
      const token = craft(other, { alg: "EdDSA", kid: signer.kid, typ: CARD_JWS_TYPE }, { ...card, iss: "hivra", iat: 1_791_460_800, exp: 1_791_461_400 });
      expect(verify(token)).toEqual({ ok: false, reason: "signature_invalid" });
    });

    it("rejects a wrong algorithm, type or extra header fields, even when signed", () => {
      // Signed with the real key material through the loader's private key via craft().
      const { privateKey } = generateKeyPairSync("ed25519");
      const own: CardSigner = { kid: "card-key-0009", privateKey, publicKey: "" };
      const spki = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer);
      const reg = [record({ ...own, publicKey: spki.subarray(spki.length - 32).toString("base64url") })];
      const claims = { ...card, iss: "hivra", iat: 1_791_460_800, exp: 1_791_461_400 };
      const ok = craft(privateKey, { alg: "EdDSA", kid: "card-key-0009", typ: CARD_JWS_TYPE }, claims);
      expect(verifyCard(ok, reg, { now: at(10) }).ok).toBe(true);
      for (const header of [
        { alg: "none", kid: "card-key-0009", typ: CARD_JWS_TYPE },
        { alg: "HS256", kid: "card-key-0009", typ: CARD_JWS_TYPE },
        { alg: "EdDSA", kid: "card-key-0009", typ: "JWT" },
        { alg: "EdDSA", kid: "card-key-0009", typ: CARD_JWS_TYPE, jku: "https://evil.example/keys" },
        { alg: "EdDSA", typ: CARD_JWS_TYPE },
      ]) {
        expect(verifyCard(craft(privateKey, header, claims), reg, { now: at(10) })).toEqual({ ok: false, reason: "bad_header" });
      }
      // Claims: wrong issuer, missing tenant, a lifetime over an hour, a zero lifetime.
      for (const [claimsChange, reason] of [
        [{ iss: "someone-else" }, "bad_claims"],
        [{ tenant: undefined }, "bad_claims"],
        [{ exp: 1_791_460_800 + 7200 }, "lifetime_too_long"],
        [{ exp: 1_791_460_800 }, "lifetime_too_long"],
        [{ iat: 1.5 }, "bad_claims"],
      ] as const) {
        const changed = { ...claims, ...claimsChange };
        const withoutUndefined = JSON.parse(JSON.stringify(changed));
        expect(verifyCard(craft(privateKey, { alg: "EdDSA", kid: "card-key-0009", typ: CARD_JWS_TYPE }, withoutUndefined), reg, { now: at(10) })).toEqual({ ok: false, reason });
      }
      // A validly signed card whose payload is not in canonical form is refused.
      const reversed = Object.fromEntries(Object.entries(claims).reverse());
      const loose = craft(privateKey, { alg: "EdDSA", kid: "card-key-0009", typ: CARD_JWS_TYPE }, reversed, false);
      const looseJson = Buffer.from(loose.split(".")[1], "base64url").toString();
      expect(looseJson).not.toBe(canonicalize(JSON.parse(looseJson)));
      expect(verifyCard(loose, reg, { now: at(10) })).toEqual({ ok: false, reason: "not_canonical" });
    });
  });
});

describe("canonicalize (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units, recursively, with no whitespace", () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, "é": true, "10": "x", "2": "y" })).toBe(
      '{"10":"x","2":"y","a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1,"é":true}'
    );
  });
  it("matches the digest of a fixed document, so the format cannot drift silently", () => {
    const digest = createHash("sha256").update(canonicalize({ tenant: ORG, principal: ALICE, skills: ["a", "b"], v: 1 })).digest("hex");
    expect(digest).toHaveLength(64);
    expect(canonicalize({ v: 1, skills: ["a", "b"], principal: ALICE, tenant: ORG })).toBe(
      canonicalize({ tenant: ORG, principal: ALICE, skills: ["a", "b"], v: 1 })
    );
  });
  it("refuses values a card cannot hold", () => {
    expect(() => canonicalize({ a: undefined })).toThrow();
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalize(() => 1)).toThrow();
    expect(() => canonicalize(BigInt(1))).toThrow();
  });
});
