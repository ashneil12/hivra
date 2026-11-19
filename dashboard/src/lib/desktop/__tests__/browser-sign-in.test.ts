import crypto from "node:crypto";
import {
  HANDOFF_TTL_SECONDS,
  challengeFor,
  createHandoffCode,
  desktopBrowserSignInEnabled,
  desktopCallbackUrl,
  isValidChallenge,
  isValidState,
  redeemHandoffCode,
} from "../browser-sign-in";

const SECRET = "sk_test_example_value_for_sealing";
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = challengeFor(verifier);

describe("desktop browser sign-in", () => {
  it("is off unless the switch is on", () => {
    expect(desktopBrowserSignInEnabled({})).toBe(false);
    expect(desktopBrowserSignInEnabled({ HIVRA_DESKTOP_BROWSER_SIGNIN: "0" })).toBe(false);
    expect(desktopBrowserSignInEnabled({ HIVRA_DESKTOP_BROWSER_SIGNIN: "on" })).toBe(true);
  });

  it("validates the app's challenge and state", () => {
    expect(isValidChallenge(challenge)).toBe(true);
    expect(isValidChallenge("short")).toBe(false);
    expect(isValidChallenge(`${challenge.slice(0, 42)}=`)).toBe(false);
    expect(isValidState("abcdefghijklmnop")).toBe(true);
    expect(isValidState("abc")).toBe(false);
    expect(isValidState("abcdefghijklmnop/")).toBe(false);
  });

  it("returns the account for the right verifier", () => {
    const code = createHandoffCode({ userId: "user_123", challenge, secret: SECRET });
    expect(redeemHandoffCode({ code, verifier, secret: SECRET })).toEqual({ ok: true, userId: "user_123" });
  });

  it("does not reveal the account id in the code", () => {
    const code = createHandoffCode({ userId: "user_visible", challenge, secret: SECRET });
    expect(Buffer.from(code, "base64url").toString("utf8")).not.toContain("user_visible");
  });

  it("refuses a code without the verifier", () => {
    const code = createHandoffCode({ userId: "user_123", challenge, secret: SECRET });
    const other = crypto.randomBytes(32).toString("base64url");
    expect(redeemHandoffCode({ code, verifier: other, secret: SECRET })).toEqual({ ok: false, reason: "verifier_mismatch" });
  });

  it("refuses an expired code", () => {
    const now = Date.now();
    const code = createHandoffCode({ userId: "user_123", challenge, secret: SECRET, nowMs: now });
    const later = now + (HANDOFF_TTL_SECONDS + 1) * 1000;
    expect(redeemHandoffCode({ code, verifier, secret: SECRET, nowMs: later })).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a tampered code or another server's code", () => {
    const code = createHandoffCode({ userId: "user_123", challenge, secret: SECRET });
    const bytes = Buffer.from(code, "base64url");
    bytes[14] ^= 1;
    expect(redeemHandoffCode({ code: bytes.toString("base64url"), verifier, secret: SECRET }).ok).toBe(false);
    expect(redeemHandoffCode({ code, verifier, secret: "another_secret" }).ok).toBe(false);
    expect(redeemHandoffCode({ code: "not a code!", verifier, secret: SECRET }).ok).toBe(false);
  });

  it("builds the hivra:// callback", () => {
    expect(desktopCallbackUrl("abc", "state_value_123456")).toBe("hivra://auth/callback?code=abc&state=state_value_123456");
  });
});
