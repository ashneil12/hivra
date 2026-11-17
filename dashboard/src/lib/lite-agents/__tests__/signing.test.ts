import crypto from "node:crypto";

import { isFreeCloudAgentEnabled } from "../flag";
import { isAllowedLiteRoute, liteSignatureHeaders, liteSignedMessage } from "../signing";

const AGENT = "11111111-2222-4333-8444-555555555555";
const SESSION = "66666666-7777-4888-9999-aaaaaaaaaaaa";

describe("free cloud agent flag", () => {
  it("is off unless set to 1 or true", () => {
    expect(isFreeCloudAgentEnabled(undefined)).toBe(false);
    expect(isFreeCloudAgentEnabled("")).toBe(false);
    expect(isFreeCloudAgentEnabled("0")).toBe(false);
    expect(isFreeCloudAgentEnabled("1")).toBe(true);
    expect(isFreeCloudAgentEnabled(" TRUE ")).toBe(true);
  });
});

describe("lite worker signing", () => {
  it("signs method, path, account, time and the body hash like the Worker expects", () => {
    const secret = "s".repeat(40);
    const body = JSON.stringify({ content: "hi" });
    const headers = liteSignatureHeaders(secret, "post", "/v1/agents", "user_abc", body, 1_700_000_000_000);
    expect(headers["x-hivra-account"]).toBe("user_abc");
    expect(headers["x-hivra-timestamp"]).toBe("1700000000");
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`lite|v1|POST|/v1/agents|user_abc|1700000000|${bodyHash}`)
      .digest("hex");
    expect(headers["x-hivra-signature"]).toBe(expected);
    expect(liteSignedMessage("get", "/v1/me", "user_abc", "1", "")).toBe(
      `lite|v1|GET|/v1/me|user_abc|1|${crypto.createHash("sha256").update("").digest("hex")}`,
    );
  });

  it("allows only the Worker's own routes", () => {
    expect(isAllowedLiteRoute("GET", "/v1/me")).toBe(true);
    expect(isAllowedLiteRoute("POST", "/v1/agents")).toBe(true);
    expect(isAllowedLiteRoute("PATCH", `/v1/agents/${AGENT}`)).toBe(true);
    expect(isAllowedLiteRoute("POST", `/v1/agents/${AGENT}/sessions/${SESSION}/messages`)).toBe(true);
    expect(isAllowedLiteRoute("GET", "/v1/agents")).toBe(false);
    expect(isAllowedLiteRoute("POST", "/v1/me")).toBe(false);
    expect(isAllowedLiteRoute("GET", `/v1/agents/${AGENT}/../../admin`)).toBe(false);
    expect(isAllowedLiteRoute("GET", "/v1/agents/not-an-id")).toBe(false);
    expect(isAllowedLiteRoute("GET", "https://evil.example/v1/me")).toBe(false);
  });
});
