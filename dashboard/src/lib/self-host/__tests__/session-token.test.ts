import {
  createLocalSessionToken,
  readBearerToken,
  readCookieValue,
  verifyLocalSessionToken,
} from "../session-token";

const secret = "correct-hivra-test-secret-that-is-at-least-32-characters";

describe("local operator session tokens", () => {
  it("creates a signed Supabase-compatible JWT and verifies its exact identity", async () => {
    const token = await createLocalSessionToken({
      email: "operator@example.com",
      name: "Operator",
      secret,
      nowSeconds: 1_000,
      ttlSeconds: 600,
    });

    const claims = await verifyLocalSessionToken({ token, secret, nowSeconds: 1_001 });
    expect(claims).toMatchObject({
      aud: "hivra-dashboard",
      email: "operator@example.com",
      exp: 1_600,
      iat: 1_000,
      iss: "hivra-self-host",
      role: "authenticated",
      sub: "hivra-local-operator",
    });
  });

  it("fails closed for expiry, tampering, and a different installation secret", async () => {
    const token = await createLocalSessionToken({
      email: "operator@example.com",
      name: "Operator",
      secret,
      nowSeconds: 1_000,
      ttlSeconds: 60,
    });

    expect(await verifyLocalSessionToken({ token, secret, nowSeconds: 1_060 })).toBeNull();
    expect(await verifyLocalSessionToken({ token: `${token.slice(0, -1)}x`, secret, nowSeconds: 1_001 })).toBeNull();
    expect(await verifyLocalSessionToken({ token, secret: `${secret}-different`, nowSeconds: 1_001 })).toBeNull();
  });

  it("reads only an exact cookie name and a complete bearer credential", () => {
    expect(readCookieValue("x=1; hivra_operator_session=abc.def; y=2", "hivra_operator_session")).toBe("abc.def");
    expect(readCookieValue("hivra_operator_session_extra=wrong", "hivra_operator_session")).toBeNull();
    expect(readBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(readBearerToken("Basic abc")).toBeNull();
  });
});
