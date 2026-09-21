import crypto from "crypto";

import { verifyClerkWebhookSignature } from "../clerk-webhook-signature";

function signPayload(params: {
  payload: string;
  secret: string;
  svixId: string;
  svixTimestamp: string;
}) {
  const rawSecret = params.secret.replace(/^whsec_/, "");
  return crypto
    .createHmac("sha256", Buffer.from(rawSecret, "base64"))
    .update(`${params.svixId}.${params.svixTimestamp}.${params.payload}`)
    .digest("base64");
}

describe("verifyClerkWebhookSignature", () => {
  const secret = `whsec_${Buffer.from("test-secret").toString("base64")}`;
  const payload = JSON.stringify({ type: "user.created", data: { id: "user_123" } });
  const svixId = "msg_123";
  const svixTimestamp = "1700000000";

  it("accepts a valid Svix signature", () => {
    const signature = signPayload({ payload, secret, svixId, svixTimestamp });

    expect(
      verifyClerkWebhookSignature({
        payload,
        secret,
        svixId,
        svixTimestamp,
        svixSignature: `v1,${signature}`,
        nowSeconds: Number(svixTimestamp),
      }),
    ).toBe(true);
  });

  it("rejects changed payloads", () => {
    const signature = signPayload({ payload, secret, svixId, svixTimestamp });

    expect(
      verifyClerkWebhookSignature({
        payload: JSON.stringify({ type: "user.updated", data: { id: "user_123" } }),
        secret,
        svixId,
        svixTimestamp,
        svixSignature: `v1,${signature}`,
        nowSeconds: Number(svixTimestamp),
      }),
    ).toBe(false);
  });

  it("rejects stale timestamps", () => {
    const signature = signPayload({ payload, secret, svixId, svixTimestamp });

    expect(
      verifyClerkWebhookSignature({
        payload,
        secret,
        svixId,
        svixTimestamp,
        svixSignature: `v1,${signature}`,
        nowSeconds: Number(svixTimestamp) + 301,
      }),
    ).toBe(false);
  });
});
