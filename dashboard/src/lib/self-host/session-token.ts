import {
  SELF_HOST_SESSION_AUDIENCE,
  SELF_HOST_SESSION_ISSUER,
  SELF_HOST_SESSION_TTL_SECONDS,
  SELF_HOST_USER_ID,
} from "./config";

export interface LocalSessionClaims {
  aud: typeof SELF_HOST_SESSION_AUDIENCE;
  email: string;
  exp: number;
  iat: number;
  iss: typeof SELF_HOST_SESSION_ISSUER;
  name: string;
  role: "authenticated";
  sub: typeof SELF_HOST_USER_ID;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value));
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function importHmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function createLocalSessionToken(params: {
  email: string;
  name: string;
  secret: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = stringToBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims: LocalSessionClaims = {
    aud: SELF_HOST_SESSION_AUDIENCE,
    email: params.email,
    exp: now + (params.ttlSeconds ?? SELF_HOST_SESSION_TTL_SECONDS),
    iat: now,
    iss: SELF_HOST_SESSION_ISSUER,
    name: params.name,
    role: "authenticated",
    sub: SELF_HOST_USER_ID,
  };
  const payload = stringToBase64Url(JSON.stringify(claims));
  const unsigned = `${header}.${payload}`;
  const key = await importHmacKey(params.secret, "sign");
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(unsigned)),
  );
  return `${unsigned}.${bytesToBase64Url(signature)}`;
}

export async function verifyLocalSessionToken(params: {
  token: string | null | undefined;
  secret: string;
  nowSeconds?: number;
}): Promise<LocalSessionClaims | null> {
  const segments = params.token?.split(".") ?? [];
  if (segments.length !== 3) return null;

  try {
    const [headerSegment, payloadSegment, signatureSegment] = segments;
    const header = JSON.parse(decoder.decode(base64UrlToBytes(headerSegment))) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const key = await importHmacKey(params.secret, "verify");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      bytesToArrayBuffer(base64UrlToBytes(signatureSegment)),
      encoder.encode(`${headerSegment}.${payloadSegment}`),
    );
    if (!valid) return null;

    const claims = JSON.parse(decoder.decode(base64UrlToBytes(payloadSegment))) as Partial<LocalSessionClaims>;
    const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (
      claims.aud !== SELF_HOST_SESSION_AUDIENCE ||
      claims.iss !== SELF_HOST_SESSION_ISSUER ||
      claims.sub !== SELF_HOST_USER_ID ||
      claims.role !== "authenticated" ||
      typeof claims.email !== "string" ||
      typeof claims.name !== "string" ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      claims.iat > now + 60 ||
      claims.exp <= now
    ) {
      return null;
    }
    return claims as LocalSessionClaims;
  } catch {
    return null;
  }
}

export function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    const value = entry.slice(separator + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

export function readBearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}
