import "server-only";
import { createHash, createHmac } from "node:crypto";

// Minimal S3-compatible client for the whole-computer export bucket on
// Cloudflare R2. Only the calls the export needs: start, complete and abort a
// multipart upload, and presigned part-upload and download links. AWS
// Signature Version 4, region "auto", path-style addressing.
//
// The export never passes through the website: the computer's host uploads
// each part straight to R2 with a presigned link, and the owner downloads the
// finished file with another presigned link.

export interface ExportBucketConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const OBJECT_KEY = /^[a-z0-9][a-z0-9/._-]{0,255}$/;

/** The bucket settings, or null when any is missing or malformed (the feature then stays unavailable). */
export function readExportBucketConfig(env: Record<string, string | undefined> = process.env): ExportBucketConfig | null {
  const accountId = env.HIVRA_EXPORT_R2_ACCOUNT_ID?.trim() ?? "";
  const accessKeyId = env.HIVRA_EXPORT_R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.HIVRA_EXPORT_R2_SECRET_ACCESS_KEY?.trim() ?? "";
  const bucket = env.HIVRA_EXPORT_R2_BUCKET?.trim() ?? "";
  if (!ACCOUNT_ID.test(accountId) || !accessKeyId || !secretAccessKey || !BUCKET.test(bucket)) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(keyBytes: Buffer | string, value: string): Buffer {
  return createHmac("sha256", keyBytes).update(value).digest();
}

/** RFC 3986 encoding as SigV4 requires; "/" kept only in paths. */
export function encodeRfc3986(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

function amzDate(now: Date): { stamp: string; day: string } {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { stamp, day: stamp.slice(0, 8) };
}

function host(config: ExportBucketConfig): string {
  return `${config.accountId}.r2.cloudflarestorage.com`;
}

function objectPath(config: ExportBucketConfig, key: string): string {
  if (!OBJECT_KEY.test(key) || key.includes("..")) throw new Error("Invalid export object key");
  return `/${config.bucket}/${encodeRfc3986(key, true)}`;
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params).sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join("&");
}

function signingKey(config: ExportBucketConfig, day: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, day);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

/** A presigned link for one method on one object. `expiresSeconds` is capped at 7 days by SigV4. */
export function presignExportUrl(config: ExportBucketConfig, input: {
  method: "GET" | "PUT";
  key: string;
  expiresSeconds: number;
  query?: Record<string, string>;
  now?: Date;
}): string {
  if (!Number.isSafeInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 604_800) {
    throw new Error("Invalid presign lifetime");
  }
  const { stamp, day } = amzDate(input.now ?? new Date());
  const scope = `${day}/auto/s3/aws4_request`;
  const params: Record<string, string> = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const path = objectPath(config, input.key);
  const query = canonicalQuery(params);
  const canonical = [input.method, path, query, `host:${host(config)}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(config, day)).update(toSign).digest("hex");
  return `https://${host(config)}${path}?${query}&X-Amz-Signature=${signature}`;
}

/** A header-signed request (used for the multipart calls, which carry a body). */
async function signedFetch(config: ExportBucketConfig, input: {
  method: "POST" | "DELETE";
  key: string;
  query: Record<string, string>;
  body?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const { stamp, day } = amzDate(input.now ?? new Date());
  const scope = `${day}/auto/s3/aws4_request`;
  const body = input.body ?? "";
  const payloadHash = sha256Hex(body);
  const path = objectPath(config, input.key);
  const query = canonicalQuery(input.query);
  const headers = `host:${host(config)}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${stamp}\n`;
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [input.method, path, query, headers, signed, payloadHash].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(config, day)).update(toSign).digest("hex");
  const url = `https://${host(config)}${path}${query ? `?${query}` : ""}`;
  return (input.fetchImpl ?? fetch)(url, {
    method: input.method,
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": stamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
      ...(body ? { "content-type": "application/xml" } : {}),
    },
    body: body || undefined,
    cache: "no-store",
  });
}

export async function startMultipartUpload(config: ExportBucketConfig, key: string, fetchImpl?: typeof fetch): Promise<string> {
  const response = await signedFetch(config, { method: "POST", key, query: { uploads: "" }, fetchImpl });
  const text = await response.text();
  const match = /<UploadId>([^<]{1,1024})<\/UploadId>/.exec(text);
  if (!response.ok || !match) throw new Error(`Export bucket refused the upload (${response.status})`);
  return match[1];
}

export interface UploadedPart { partNumber: number; etag: string }

const ETAG = /^"?[0-9a-fA-F-]{8,80}"?$/;

export async function completeMultipartUpload(config: ExportBucketConfig, key: string, uploadId: string,
  parts: UploadedPart[], fetchImpl?: typeof fetch): Promise<void> {
  if (parts.length < 1 || parts.some((p, i) => p.partNumber !== i + 1 || !ETAG.test(p.etag))) {
    throw new Error("Export parts are incomplete or out of order");
  }
  const body = `<CompleteMultipartUpload>${parts.map((p) =>
    `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag.replace(/"/g, "")}"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const response = await signedFetch(config, { method: "POST", key, query: { uploadId }, body, fetchImpl });
  const text = await response.text();
  // S3 can answer 200 with an <Error> body for a failed completion.
  if (!response.ok || text.includes("<Error>")) throw new Error(`Export bucket did not complete the upload (${response.status})`);
}

export async function abortMultipartUpload(config: ExportBucketConfig, key: string, uploadId: string, fetchImpl?: typeof fetch): Promise<void> {
  const response = await signedFetch(config, { method: "DELETE", key, query: { uploadId }, fetchImpl });
  if (!response.ok && response.status !== 404) throw new Error(`Export bucket did not abort the upload (${response.status})`);
}
