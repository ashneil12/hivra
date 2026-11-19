/** @jest-environment node */
jest.mock("server-only", () => ({}));
import { presignExportUrl, readExportBucketConfig } from "../r2";

// Expected links were produced by botocore 1.35.0's generate_presigned_url
// (s3v4, region "auto", path addressing) for the same inputs and clock.
const bucket = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "EXAMPLEID",
  secretAccessKey: "examplesecretvalue",
  bucket: "hivra-exports",
};
const now = new Date("2026-11-17T12:00:00Z");
const base = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/hivra-exports/exports/a/b.tar.gpg";

describe("export bucket links", () => {
  it("signs a part upload exactly like the reference S3 signer", () => {
    const url = new URL(presignExportUrl(bucket, {
      method: "PUT", key: "exports/a/b.tar.gpg", expiresSeconds: 3600, now,
      query: { partNumber: "3", uploadId: "up-1" },
    }));
    expect(`${url.origin}${url.pathname}`).toBe(base);
    expect(url.searchParams.get("X-Amz-Signature")).toBe("b31f5a9019c2b478b3d23a729f2988b59e0fe66caa77d740aa9507a527bd3041");
    expect(url.searchParams.get("partNumber")).toBe("3");
  });

  it("signs a download exactly like the reference S3 signer", () => {
    const url = new URL(presignExportUrl(bucket, { method: "GET", key: "exports/a/b.tar.gpg", expiresSeconds: 600, now }));
    expect(url.searchParams.get("X-Amz-Signature")).toBe("1fd33467cbee329c92c5ef938b9efdf7f636fce160622ead38412ee19488a7b6");
  });

  it("refuses unsafe keys and lifetimes over seven days", () => {
    expect(() => presignExportUrl(bucket, { method: "GET", key: "../x", expiresSeconds: 60, now })).toThrow();
    expect(() => presignExportUrl(bucket, { method: "GET", key: "exports/x", expiresSeconds: 604_801, now })).toThrow();
  });

  it("stays off until every bucket setting is present", () => {
    expect(readExportBucketConfig({})).toBeNull();
    expect(readExportBucketConfig({
      HIVRA_EXPORT_R2_ACCOUNT_ID: bucket.accountId, HIVRA_EXPORT_R2_ACCESS_KEY_ID: "id",
      HIVRA_EXPORT_R2_SECRET_ACCESS_KEY: "value", HIVRA_EXPORT_R2_BUCKET: "hivra-exports",
    })).toEqual({ accountId: bucket.accountId, accessKeyId: "id", secretAccessKey: "value", bucket: "hivra-exports" });
  });
});
