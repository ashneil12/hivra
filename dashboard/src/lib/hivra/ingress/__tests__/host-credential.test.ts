import { createHmac } from "node:crypto";

import {
  buildHostCredentialDocument,
  deriveHostCredential,
  signHostRequest,
  storedHostCredentialGeneration,
  verifyHostRequest,
  WAKE_REPORT_PATH,
  WAKE_REQUEST_PATH,
  type HostRequestDeps,
} from "../host-credential";

// Neutral fixture material, made for these tests only.
const MASTER = "m".repeat(40);
const HOST = "fixturehost";
const ON = { HIVRA_INGRESS_HOST_CREDENTIAL: "true", HIVRA_INGRESS_SECRET: MASTER };
const NOW_S = 1_800_000_000;

// The same vector as provisioner/test_hivra_wake_proxy.py: both sides sign byte for byte alike.
const VECTOR_MATERIAL = "0123456789abcdef".repeat(4);
const VECTOR_SIGNATURE = "6d5dd47b6da966cafc529097f666b90949ec3096e3fac30aa1872534dbaa65b5";

function signedHeaders(input: {
  generation?: number;
  timestamp?: number;
  nonce?: string;
  body: string;
  path?: string;
  material?: string;
  host?: string;
}): Record<string, string> {
  const generation = input.generation ?? 2;
  const timestamp = input.timestamp ?? NOW_S;
  const nonce = input.nonce ?? "nonce-abcdefghijklmnop";
  const host = input.host ?? HOST;
  const material = input.material ?? deriveHostCredential({ secret: MASTER, hostId: host, generation });
  return {
    "x-hivra-host": host,
    "x-hivra-generation": String(generation),
    "x-hivra-timestamp": String(timestamp),
    "x-hivra-nonce": nonce,
    "x-hivra-signature": signHostRequest(material, {
      path: input.path ?? WAKE_REPORT_PATH, hostId: host, generation, timestamp, nonce, body: input.body,
    }),
  };
}

function deps(overrides: Partial<HostRequestDeps> = {}) {
  const claimed = new Set<string>();
  const claimNonce = jest.fn(async (hostId: string, nonce: string) => {
    const key = `${hostId}/${nonce}`;
    if (claimed.has(key)) return "replayed" as const;
    claimed.add(key);
    return "ok" as const;
  });
  return {
    env: ON,
    nowMs: () => NOW_S * 1000,
    loadHost: jest.fn(async (id: string) => (id === HOST ? { id, ingress_credential_generation: 2 } : null)),
    claimNonce,
    ...overrides,
  } satisfies HostRequestDeps;
}

const BODY = JSON.stringify({ vmid: 1234, woke: "nap" });

describe("host credential", () => {
  it("derives a per-host, per-generation credential", () => {
    const expected = createHmac("sha256", MASTER).update(`hivra-ingress-host-v1\u0000${HOST}\u00002`).digest("hex");
    expect(deriveHostCredential({ secret: MASTER, hostId: HOST, generation: 2 })).toBe(expected);
    expect(deriveHostCredential({ secret: MASTER, hostId: HOST, generation: 3 })).not.toBe(expected);
    expect(deriveHostCredential({ secret: MASTER, hostId: "otherhost", generation: 2 })).not.toBe(expected);
    expect(() => deriveHostCredential({ secret: "short", hostId: HOST, generation: 2 })).toThrow();
    expect(() => deriveHostCredential({ secret: MASTER, hostId: "Bad Host", generation: 2 })).toThrow();
    expect(() => deriveHostCredential({ secret: MASTER, hostId: HOST, generation: 0 })).toThrow();
  });

  it("signs exactly as the host proxy does", () => {
    expect(signHostRequest(VECTOR_MATERIAL, {
      path: WAKE_REPORT_PATH, hostId: "fixturehost", generation: 3, timestamp: 1700000000,
      nonce: "nonce-0123456789ab", body: '{"from":"ticket","vmid":1234}',
    })).toBe(VECTOR_SIGNATURE);
  });

  it("builds the document the install step writes, and refuses a non-https origin", () => {
    const doc = buildHostCredentialDocument({ secret: MASTER, hostId: HOST, generation: 1, origin: "https://app.example.test" });
    expect(Object.keys(doc).sort()).toEqual(["credential", "generation", "host_id", "origin", "version"]);
    expect(doc).toMatchObject({ version: 1, host_id: HOST, generation: 1, origin: "https://app.example.test" });
    expect(doc.credential).toMatch(/^[0-9a-f]{64}$/);
    expect(() => buildHostCredentialDocument({ secret: MASTER, hostId: HOST, generation: 1, origin: "http://app.example.test" })).toThrow();
    expect(() => buildHostCredentialDocument({ secret: MASTER, hostId: HOST, generation: 1, origin: "https://app.example.test/x" })).toThrow();
  });

  it("reads the stored generation strictly", () => {
    expect(storedHostCredentialGeneration({ id: HOST, ingress_credential_generation: 4 })).toBe(4);
    expect(storedHostCredentialGeneration({ id: HOST, ingress_credential_generation: "4" })).toBe(4);
    for (const value of [0, -1, null, undefined, "x", 1.5, true]) {
      expect(storedHostCredentialGeneration({ id: HOST, ingress_credential_generation: value })).toBe(0);
    }
    expect(storedHostCredentialGeneration(null)).toBe(0);
  });
});

describe("verifyHostRequest", () => {
  it("accepts a correctly signed request once", async () => {
    const d = deps();
    const headers = signedHeaders({ body: BODY });
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers, body: BODY }, d)).resolves.toEqual({ ok: true, hostId: HOST, generation: 2 });
    // The same request again is a replay.
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers, body: BODY }, d)).resolves.toMatchObject({ ok: false, status: 409, reason: "replayed" });
  });

  it("works with a Headers object, case-insensitively", async () => {
    const headers = new Headers(Object.entries(signedHeaders({ body: BODY })).map(([k, v]): [string, string] => [k.toUpperCase(), v]));
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers, body: Buffer.from(BODY) }, deps())).resolves.toMatchObject({ ok: true });
  });

  it("is 404 with the flag off and 503 without the secret, before reading anything", async () => {
    const d = deps({ env: { HIVRA_INGRESS_SECRET: MASTER } });
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY }), body: BODY }, d))
      .resolves.toEqual({ ok: false, status: 404, reason: "disabled" });
    const noSecret = deps({ env: { HIVRA_INGRESS_HOST_CREDENTIAL: "true" } });
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY }), body: BODY }, noSecret))
      .resolves.toMatchObject({ ok: false, status: 503 });
    expect(d.loadHost).not.toHaveBeenCalled();
    expect(noSecret.loadHost).not.toHaveBeenCalled();
  });

  it("refuses a changed body, path, host or a missing header, and never records their nonce", async () => {
    const d = deps();
    const headers = signedHeaders({ body: BODY });
    const cases: Array<[Record<string, string>, string, string]> = [
      [headers, WAKE_REPORT_PATH, JSON.stringify({ vmid: 1235, woke: "nap" })],
      [headers, WAKE_REQUEST_PATH, BODY],
      [{ ...headers, "x-hivra-signature": "0".repeat(64) }, WAKE_REPORT_PATH, BODY],
      [{ ...headers, "x-hivra-nonce": "nonce-zzzzzzzzzzzzzzzz" }, WAKE_REPORT_PATH, BODY],
    ];
    for (const [h, path, body] of cases) {
      await expect(verifyHostRequest({ path, headers: h, body }, d)).resolves.toMatchObject({ ok: false, status: 401, reason: "bad_signature" });
    }
    for (const name of Object.keys(headers)) {
      const partial = { ...headers };
      delete partial[name];
      await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: partial, body: BODY }, d)).resolves.toMatchObject({ ok: false, status: 401, reason: "malformed" });
    }
    expect(d.claimNonce).not.toHaveBeenCalled();
  });

  it("refuses a timestamp more than 60 s away", async () => {
    const d = deps();
    for (const timestamp of [NOW_S - 61, NOW_S + 61]) {
      await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY, timestamp }), body: BODY }, d))
        .resolves.toMatchObject({ ok: false, status: 401, reason: "stale" });
    }
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY, timestamp: NOW_S - 59 }), body: BODY }, d))
      .resolves.toMatchObject({ ok: true });
  });

  it("revokes by generation: an older or newer generation, none issued, or an unknown host all fail alike", async () => {
    const d = deps();
    for (const generation of [1, 3]) {
      await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY, generation }), body: BODY }, d))
        .resolves.toEqual({ ok: false, status: 401, reason: "revoked" });
    }
    const never = deps({ loadHost: jest.fn(async (id: string) => ({ id, ingress_credential_generation: 0 })) });
    // A host that was never issued a credential (generation 0) accepts nothing.
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY, generation: 2 }), body: BODY }, never))
      .resolves.toMatchObject({ ok: false, status: 401, reason: "revoked" });
    await expect(verifyHostRequest({
      path: WAKE_REPORT_PATH,
      headers: signedHeaders({ body: BODY, host: "otherhost" }),
      body: BODY,
    }, d)).resolves.toMatchObject({ ok: false, status: 401, reason: "revoked" });
    // A credential derived from another master secret does not verify.
    await expect(verifyHostRequest({
      path: WAKE_REPORT_PATH,
      headers: signedHeaders({ body: BODY, material: deriveHostCredential({ secret: "n".repeat(40), hostId: HOST, generation: 2 }) }),
      body: BODY,
    }, d)).resolves.toMatchObject({ ok: false, status: 401, reason: "bad_signature" });
  });

  it("is 503 when the host row or the nonce store cannot be reached", async () => {
    const unreadable = deps({ loadHost: jest.fn(async () => { throw new Error("db"); }) });
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY }), body: BODY }, unreadable))
      .resolves.toMatchObject({ ok: false, status: 503, reason: "host_unreadable" });
    const noNonce = deps({ claimNonce: jest.fn(async () => "error" as const) });
    await expect(verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY }), body: BODY }, noNonce))
      .resolves.toMatchObject({ ok: false, status: 503, reason: "nonce_unavailable" });
  });

  it("keeps a nonce at least until its timestamp can no longer be accepted", async () => {
    const d = deps();
    await verifyHostRequest({ path: WAKE_REPORT_PATH, headers: signedHeaders({ body: BODY }), body: BODY }, d);
    expect(d.claimNonce).toHaveBeenCalledWith(HOST, "nonce-abcdefghijklmnop", (NOW_S + 120) * 1000);
  });
});
