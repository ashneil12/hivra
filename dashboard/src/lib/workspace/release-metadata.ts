import "server-only";

export const UNKNOWN_RELEASE_VALUE = "Unknown" as const;
const BUILD_GENERATED_AT_LABEL = "Build generated at" as const;

export const RELEASE_METADATA_ENV_KEYS = [
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_TARGET_ENV",
  "NEXT_PUBLIC_BUILD_GENERATED_AT",
  "NEXT_PUBLIC_APP_URL",
] as const;

export const RELEASE_METADATA_FIELDS = [
  "canaryUrl",
  "revision",
  "shortRevision",
  "deploymentId",
  "targetEnvironment",
  "buildGeneratedAt",
  "buildGeneratedAtLabel",
] as const;

type PublicReleaseValue = string | typeof UNKNOWN_RELEASE_VALUE;

export interface ReleaseMetadata {
  canaryUrl: PublicReleaseValue;
  revision: PublicReleaseValue;
  shortRevision: PublicReleaseValue;
  deploymentId: PublicReleaseValue;
  targetEnvironment: PublicReleaseValue;
  /** Build-configuration evaluation time, never Vercel deployment time. */
  buildGeneratedAt: PublicReleaseValue;
  buildGeneratedAtLabel: typeof BUILD_GENERATED_AT_LABEL;
}

/**
 * External evidence collected by Plan 08, not browser release metadata.
 * `deploymentCreatedAt` comes from parsed `vercel inspect` JSON.createdAt;
 * `verifiedAt` comes from the verifier clock after canary checks run.
 */
export interface DeploymentVerificationEvidence {
  deploymentCreatedAt: string;
  verifiedAt: string;
}

type ReleaseMetadataEnvironment = Readonly<
  Record<string, string | undefined>
>;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TARGET_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UTC_ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET_SHAPED_VALUE =
  /(?:bearer|password|secret|token|api[_-]?key|sk_(?:live|test))/i;

function parseRevision(value: string | undefined): string | null {
  if (!value || value !== value.trim() || !FULL_GIT_SHA.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function parseIdentifier(
  value: string | undefined,
  pattern: RegExp,
): string | null {
  if (
    !value ||
    value !== value.trim() ||
    !pattern.test(value) ||
    SECRET_SHAPED_VALUE.test(value)
  ) {
    return null;
  }
  return value;
}

function parseBuildGeneratedAt(value: string | undefined): string | null {
  if (!value || !UTC_ISO_TIMESTAMP.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return null;
  }
  return value;
}

function parsePublicAppOrigin(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.length > 2048) return null;

  try {
    const parsed = new URL(value);
    const isLocalHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (parsed.protocol !== "https:" && !isLocalHttp) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    if (parsed.pathname !== "/") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Return the only release metadata permitted to cross the server/browser
 * boundary. This function intentionally reads five named keys rather than
 * spreading or iterating over the process environment.
 */
export function getReleaseMetadata(
  environment: ReleaseMetadataEnvironment = process.env,
): ReleaseMetadata {
  const revision = parseRevision(environment.VERCEL_GIT_COMMIT_SHA);
  const deploymentId = parseIdentifier(
    environment.VERCEL_DEPLOYMENT_ID,
    DEPLOYMENT_ID,
  );
  const targetEnvironment = parseIdentifier(
    environment.VERCEL_TARGET_ENV,
    TARGET_ENVIRONMENT,
  );
  const buildGeneratedAt = parseBuildGeneratedAt(
    environment.NEXT_PUBLIC_BUILD_GENERATED_AT,
  );
  const publicAppOrigin = parsePublicAppOrigin(
    environment.NEXT_PUBLIC_APP_URL,
  );

  return {
    canaryUrl: publicAppOrigin
      ? `${publicAppOrigin}/dashboard/workspace`
      : UNKNOWN_RELEASE_VALUE,
    revision: revision ?? UNKNOWN_RELEASE_VALUE,
    shortRevision: revision
      ? revision.slice(0, 12)
      : UNKNOWN_RELEASE_VALUE,
    deploymentId: deploymentId ?? UNKNOWN_RELEASE_VALUE,
    targetEnvironment: targetEnvironment ?? UNKNOWN_RELEASE_VALUE,
    buildGeneratedAt: buildGeneratedAt ?? UNKNOWN_RELEASE_VALUE,
    buildGeneratedAtLabel: BUILD_GENERATED_AT_LABEL,
  };
}
