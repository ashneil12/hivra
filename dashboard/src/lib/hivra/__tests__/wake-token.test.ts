import crypto from "node:crypto";

import { DEFAULT_WAKE_TOKEN_TTL_SECONDS, MAX_WAKE_TOKEN_TTL_SECONDS, signWakeToken, verifyWakeToken } from "../wake-token";

const SECRET = "test-wake-secret-0123456789abcdef";
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

describe("wake token", () => {
  const original = process.env.HIVRA_WAKE_TOKEN_SECRET;
  beforeEach(() => {
    process.env.HIVRA_WAKE_TOKEN_SECRET = SECRET;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.HIVRA_WAKE_TOKEN_SECRET;
    else process.env.HIVRA_WAKE_TOKEN_SECRET = original;
  });

  it("round-trips for the agent it was signed for", () => {
    const token = signWakeToken(AGENT, { now: NOW });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyWakeToken(token, AGENT, { now: NOW + 1000 })).toBe(true);
  });

  it("rejects another agent's id", () => {
    const token = signWakeToken(AGENT, { now: NOW });
    expect(verifyWakeToken(token, OTHER, { now: NOW })).toBe(false);
  });

  it("expires after the ttl", () => {
    const token = signWakeToken(AGENT, { now: NOW, ttlSeconds: 60 });
    expect(verifyWakeToken(token, AGENT, { now: NOW + 59_000 })).toBe(true);
    expect(verifyWakeToken(token, AGENT, { now: NOW + 60_000 })).toBe(false);
  });

  it("uses a short default ttl and caps a long one", () => {
    const short = signWakeToken(AGENT, { now: NOW });
    expect(verifyWakeToken(short, AGENT, { now: NOW + (DEFAULT_WAKE_TOKEN_TTL_SECONDS - 1) * 1000 })).toBe(true);
    expect(verifyWakeToken(short, AGENT, { now: NOW + DEFAULT_WAKE_TOKEN_TTL_SECONDS * 1000 })).toBe(false);
    const long = signWakeToken(AGENT, { now: NOW, ttlSeconds: 10 * 24 * 3600 });
    expect(verifyWakeToken(long, AGENT, { now: NOW + MAX_WAKE_TOKEN_TTL_SECONDS * 1000 })).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = signWakeToken(AGENT, { now: NOW }) as string;
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ a: OTHER, e: Math.floor(NOW / 1000) + 600 })).toString("base64url");
    expect(verifyWakeToken(`${forged}.${signature}`, OTHER, { now: NOW })).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = signWakeToken(AGENT, { now: NOW }) as string;
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(verifyWakeToken(flipped, AGENT, { now: NOW })).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signWakeToken(AGENT, { now: NOW, secret: "another-secret-value" });
    expect(verifyWakeToken(token, AGENT, { now: NOW })).toBe(false);
  });

  it("rejects a correctly signed payload of the wrong shape", () => {
    const sign = (payload: unknown) => {
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${body}.${crypto.createHmac("sha256", SECRET).update(body).digest("base64url")}`;
    };
    expect(verifyWakeToken(sign({ a: AGENT }), AGENT, { now: NOW })).toBe(false);
    expect(verifyWakeToken(sign({ a: AGENT, e: "soon" }), AGENT, { now: NOW })).toBe(false);
    expect(verifyWakeToken(sign(null), AGENT, { now: NOW })).toBe(false);
    expect(verifyWakeToken(sign([AGENT, 9e12]), AGENT, { now: NOW })).toBe(false);
  });

  it.each([undefined, null, "", ".", "abc", "a.b.c", "a.", ".b", "x".repeat(600)])(
    "rejects malformed token %p",
    (token) => {
      expect(verifyWakeToken(token as string | null | undefined, AGENT, { now: NOW })).toBe(false);
    },
  );

  it("signs nothing and verifies nothing without a secret", () => {
    const token = signWakeToken(AGENT, { now: NOW }) as string;
    delete process.env.HIVRA_WAKE_TOKEN_SECRET;
    expect(signWakeToken(AGENT, { now: NOW })).toBeNull();
    expect(verifyWakeToken(token, AGENT, { now: NOW })).toBe(false);
    process.env.HIVRA_WAKE_TOKEN_SECRET = "   ";
    expect(signWakeToken(AGENT, { now: NOW })).toBeNull();
    expect(verifyWakeToken(token, AGENT, { now: NOW })).toBe(false);
  });
});
