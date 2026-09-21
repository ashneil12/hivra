import nextConfig from "../../../../next.config";

import {
  RELEASE_METADATA_ENV_KEYS,
  RELEASE_METADATA_FIELDS,
  UNKNOWN_RELEASE_VALUE,
  getReleaseMetadata,
  type DeploymentVerificationEvidence,
} from "../release-metadata";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
const BUILD_GENERATED_AT = "2026-08-24T20:15:30.000Z";

function validEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    VERCEL_GIT_COMMIT_SHA: FULL_SHA,
    VERCEL_DEPLOYMENT_ID: "dpl_5D31bGmGqVxRszYBHh6yW3nM9K2p",
    VERCEL_TARGET_ENV: "preview",
    NEXT_PUBLIC_BUILD_GENERATED_AT: BUILD_GENERATED_AT,
    NEXT_PUBLIC_APP_URL: "https://canary.hivra.cloud",
    ...overrides,
  };
}

describe("release metadata", () => {
  it("returns the exact allowlisted public fields with explicit build-time provenance", () => {
    expect(getReleaseMetadata(validEnvironment())).toEqual({
      canaryUrl: "https://canary.hivra.cloud/dashboard/workspace",
      revision: FULL_SHA,
      shortRevision: "0123456789ab",
      deploymentId: "dpl_5D31bGmGqVxRszYBHh6yW3nM9K2p",
      targetEnvironment: "preview",
      buildGeneratedAt: BUILD_GENERATED_AT,
      buildGeneratedAtLabel: "Build generated at",
    });
    expect(RELEASE_METADATA_FIELDS).toEqual([
      "canaryUrl",
      "revision",
      "shortRevision",
      "deploymentId",
      "targetEnvironment",
      "buildGeneratedAt",
      "buildGeneratedAtLabel",
    ]);
  });

  it.each([undefined, "", "abc123", "g".repeat(40), `${FULL_SHA}00`])(
    "keeps a missing or invalid full Git revision unknown: %p",
    (revision) => {
      const metadata = getReleaseMetadata(
        validEnvironment({ VERCEL_GIT_COMMIT_SHA: revision }),
      );

      expect(metadata.revision).toBe(UNKNOWN_RELEASE_VALUE);
      expect(metadata.shortRevision).toBe(UNKNOWN_RELEASE_VALUE);
    },
  );

  it.each([
    ["VERCEL_DEPLOYMENT_ID", "bad deployment id"],
    ["VERCEL_DEPLOYMENT_ID", "x".repeat(129)],
    ["VERCEL_DEPLOYMENT_ID", "sk_live_DO_NOT_LEAK"],
    ["VERCEL_TARGET_ENV", "preview?token=DO_NOT_LEAK"],
    ["VERCEL_TARGET_ENV", "secret_DO_NOT_LEAK"],
  ] as const)("rejects unsafe %s values", (key, value) => {
    const metadata = getReleaseMetadata(validEnvironment({ [key]: value }));
    const field =
      key === "VERCEL_DEPLOYMENT_ID" ? "deploymentId" : "targetEnvironment";

    expect(metadata[field]).toBe(UNKNOWN_RELEASE_VALUE);
    expect(JSON.stringify(metadata)).not.toContain("DO_NOT_LEAK");
  });

  it.each([
    undefined,
    "2026-08-24",
    "2026-08-24T20:15:30+01:00",
    "2026-02-30T20:15:30.000Z",
    "secret_DO_NOT_LEAK",
  ])("rejects malformed or non-UTC build timestamps: %p", (timestamp) => {
    const metadata = getReleaseMetadata(
      validEnvironment({ NEXT_PUBLIC_BUILD_GENERATED_AT: timestamp }),
    );

    expect(metadata.buildGeneratedAt).toBe(UNKNOWN_RELEASE_VALUE);
    expect(metadata.buildGeneratedAtLabel).toBe("Build generated at");
  });

  it.each([
    undefined,
    "not-a-url",
    "ftp://canary.hivra.cloud",
    "https://user:password@canary.hivra.cloud",
    "https://canary.hivra.cloud/path",
    "https://canary.hivra.cloud?token=DO_NOT_LEAK",
    "https://canary.hivra.cloud#fragment",
  ])("rejects malformed or credential-bearing app origins: %p", (origin) => {
    const metadata = getReleaseMetadata(
      validEnvironment({ NEXT_PUBLIC_APP_URL: origin }),
    );

    expect(metadata.canaryUrl).toBe(UNKNOWN_RELEASE_VALUE);
    expect(JSON.stringify(metadata)).not.toContain("DO_NOT_LEAK");
  });

  it("reads only the five explicit environment keys", () => {
    const reads: string[] = [];
    const environment = new Proxy(validEnvironment(), {
      get(target, property: string | symbol) {
        if (typeof property === "string") reads.push(property);
        return Reflect.get(target, property);
      },
    });

    const metadata = getReleaseMetadata(environment);

    expect(RELEASE_METADATA_ENV_KEYS).toEqual([
      "VERCEL_GIT_COMMIT_SHA",
      "VERCEL_DEPLOYMENT_ID",
      "VERCEL_TARGET_ENV",
      "NEXT_PUBLIC_BUILD_GENERATED_AT",
      "NEXT_PUBLIC_APP_URL",
    ]);
    expect(reads).toEqual(RELEASE_METADATA_ENV_KEYS);
    expect(Object.keys(metadata)).toEqual(RELEASE_METADATA_FIELDS);
  });

  it("does not copy unrelated secret environment values into metadata", () => {
    const secret = "sk_live_DO_NOT_LEAK_123456789";
    const metadata = getReleaseMetadata({
      ...validEnvironment(),
      DATABASE_URL: `postgres://admin:${secret}@db.internal/hivra`,
      CLERK_SECRET_KEY: secret,
      VERCEL_TOKEN: secret,
    });

    expect(JSON.stringify(metadata)).not.toContain(secret);
  });

  it("injects one stable UTC build-generation timestamp during next config evaluation", () => {
    const generatedAt = nextConfig.env?.NEXT_PUBLIC_BUILD_GENERATED_AT;

    expect(generatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(new Date(generatedAt as string).toISOString()).toBe(generatedAt);
    expect(nextConfig.env?.NEXT_PUBLIC_BUILD_GENERATED_AT).toBe(generatedAt);
  });

  it("reserves authoritative deployment and verification clocks for Plan 08 evidence", () => {
    const plan08Evidence: DeploymentVerificationEvidence = {
      deploymentCreatedAt: "parsed from vercel inspect JSON.createdAt",
      verifiedAt: "recorded from the Plan 08 verifier clock",
    };
    const metadata = getReleaseMetadata(validEnvironment());

    expect(plan08Evidence).toEqual({
      deploymentCreatedAt: "parsed from vercel inspect JSON.createdAt",
      verifiedAt: "recorded from the Plan 08 verifier clock",
    });
    expect(metadata).not.toHaveProperty("deploymentCreatedAt");
    expect(metadata).not.toHaveProperty("verifiedAt");
    expect(metadata).not.toHaveProperty("deployedAt");
    expect(metadata).not.toHaveProperty("readyAt");
    expect(JSON.stringify(metadata)).not.toMatch(/authoritative.*deployment/i);
  });
});
