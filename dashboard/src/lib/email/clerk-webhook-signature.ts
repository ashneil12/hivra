import crypto from "crypto";

// SCRIPTURE_ANCHOR: signature-true | Proverbs 12:22 | Verse: Lying lips are an abomination to Yahweh, but those who do the truth are his delight.
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function decodeSvixSecret(secret: string) {
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(rawSecret, "base64");
}

function parseSvixSignatures(signatureHeader: string) {
  return signatureHeader
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [version, signature] = entry.split(",");
      return { version, signature };
    })
    .filter((entry) => entry.version === "v1" && Boolean(entry.signature));
}

function timingSafeBase64Equal(expected: Buffer, receivedBase64: string) {
  let received: Buffer;
  try {
    received = Buffer.from(receivedBase64, "base64");
  } catch {
    return false;
  }

  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export function verifyClerkWebhookSignature(params: {
  payload: string;
  secret: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  nowSeconds?: number;
}) {
  const { payload, secret, svixId, svixTimestamp, svixSignature } = params;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const timestamp = Number(svixTimestamp);
  if (!Number.isFinite(timestamp)) return false;

  const nowSeconds = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
  const expected = crypto
    .createHmac("sha256", decodeSvixSecret(secret))
    .update(signedContent)
    .digest();

  return parseSvixSignatures(svixSignature).some((signature) =>
    timingSafeBase64Equal(expected, signature.signature),
  );
}
