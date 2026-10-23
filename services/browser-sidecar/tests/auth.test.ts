import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintSignedUrl, verifySignedUrl } from "../src/auth/signed-url.js";

const secret = "test-secret-1234567890";

function urlToQuery(url: string) {
  const u = new URL(url);
  return {
    ts: u.searchParams.get("ts") ?? undefined,
    nonce: u.searchParams.get("nonce") ?? undefined,
    sig: u.searchParams.get("sig") ?? undefined,
    scope: u.searchParams.get("scope") ?? undefined,
    ttl: u.searchParams.get("ttl") ?? undefined,
  };
}

describe("signed-url", () => {
  it("verifies a freshly minted url", () => {
    const url = mintSignedUrl({
      baseUrl: "https://example.com",
      path: "/x",
      scope: "novnc:vex",
      secret,
      ttlMs: 60_000,
    });
    const result = verifySignedUrl({
      path: "/x",
      query: urlToQuery(url),
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
    });
    expect(result.ok).toBe(true);
  });

  it("includes a nonce in every minted url", () => {
    const url1 = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const url2 = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    expect(u1.searchParams.get("nonce")).toBeTruthy();
    expect(u2.searchParams.get("nonce")).toBeTruthy();
    // Two mints in the same millisecond MUST have different nonces, and
    // therefore different signatures — the replay-protection guarantee.
    expect(u1.searchParams.get("nonce")).not.toBe(u2.searchParams.get("nonce"));
    expect(u1.searchParams.get("sig")).not.toBe(u2.searchParams.get("sig"));
  });

  it("rejects an expired url", () => {
    const url = mintSignedUrl({
      baseUrl: "https://example.com",
      path: "/x",
      scope: "novnc:vex",
      secret,
      ttlMs: 1,
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = verifySignedUrl({
          path: "/x",
          query: urlToQuery(url),
          expectedScope: "novnc:vex",
          secret,
          maxTtlMs: 1,
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("expired");
        resolve();
      }, 5);
    });
  });

  it("rejects scope mismatch", () => {
    const url = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const result = verifySignedUrl({
      path: "/x",
      query: urlToQuery(url),
      expectedScope: "novnc:other",
      secret,
      maxTtlMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("scope_mismatch");
  });

  it("rejects bad signature", () => {
    const url = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const q = urlToQuery(url);
    const result = verifySignedUrl({
      path: "/x",
      query: { ...q, sig: "00".repeat(32) },
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects missing nonce", () => {
    const url = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const q = urlToQuery(url);
    const result = verifySignedUrl({
      path: "/x",
      query: { ...q, nonce: undefined },
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_params");
  });

  it("server-side ttl cap defeats client claiming a longer ttl", () => {
    const url = mintSignedUrl({
      baseUrl: "https://example.com",
      path: "/x",
      scope: "novnc:vex",
      secret,
      ttlMs: 60 * 60 * 1000,
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = verifySignedUrl({
          path: "/x",
          query: urlToQuery(url),
          expectedScope: "novnc:vex",
          secret,
          maxTtlMs: 1,
        });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("expired");
        resolve();
      }, 10);
    });
  });

  it("consumeNonce: first verify ok, second verify with same url returns replay_detected", () => {
    const seen = new Set<string>();
    const consumeNonce = (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };

    const url = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const q = urlToQuery(url);

    const first = verifySignedUrl({
      path: "/x",
      query: q,
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
      consumeNonce,
    });
    expect(first.ok).toBe(true);

    const second = verifySignedUrl({
      path: "/x",
      query: q,
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
      consumeNonce,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("replay_detected");
  });

  it("consumeNonce: thrown error fails closed (replay_detected)", () => {
    const url = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const result = verifySignedUrl({
      path: "/x",
      query: urlToQuery(url),
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
      consumeNonce: () => { throw new Error("store unavailable"); },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("replay_detected");
  });

  // `ttl` is NOT covered by the HMAC — it arrives attacker-controlled. A
  // non-positive or non-numeric ttl used to be silently clamped into a
  // usable window; it must hard-fail instead.
  for (const [label, ttl, reason] of [
    ["ttl=0", "0", "expired"],
    ["negative ttl", "-5000", "expired"],
    ["non-numeric ttl", "NaN", "missing_params"],
  ] as const) {
    it(`rejects ${label}`, () => {
      const url = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
      const q = urlToQuery(url);
      const result = verifySignedUrl({
        path: "/x",
        query: { ...q, ttl },
        expectedScope: "novnc:vex",
        secret,
        maxTtlMs: 60_000,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(reason);
    });
  }

  it("still verifies a url without a ttl param (default applies)", () => {
    const url = mintSignedUrl({ baseUrl: "https://example.com", path: "/x", scope: "novnc:vex", secret, ttlMs: 60_000 });
    const q = urlToQuery(url);
    const result = verifySignedUrl({
      path: "/x",
      query: { ...q, ttl: undefined },
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
    });
    expect(result.ok).toBe(true);
  });

  // A far-future `ts` makes `now - ts` negative, so the expiry check never
  // trips: the URL stays valid until real time catches up to the forged ts.
  // Signatures cover ts, so craft one with the same formula the module uses.
  it("rejects a far-future ts even with a valid signature", () => {
    const tsNum = Date.now() + 10 * 60_000;
    const nonce = "0123456789abcdef0123456789abcdef";
    const scope = "novnc:vex";
    const sig = createHmac("sha256", secret)
      .update(`/x|${tsNum}|${nonce}|${scope}`)
      .digest("hex");
    const result = verifySignedUrl({
      path: "/x",
      query: { ts: String(tsNum), nonce, sig, scope, ttl: "60000" },
      expectedScope: "novnc:vex",
      secret,
      maxTtlMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("expired");
  });
});
