import "server-only";

type Env = Record<string, string | undefined>;

/**
 * The managed Canary production slot, proved only from Vercel's own server
 * metadata. This deliberately has no request-host, header, public-origin,
 * channel, or development fallback: every field must be exactly the canonical
 * Git deployment shape.
 */
export function isCanonicalGitCanaryDeployment(env: Env = process.env): boolean {
  return env.VERCEL === "1"
    && env.VERCEL_ENV === "production"
    && env.VERCEL_PROJECT_PRODUCTION_URL === "canary.hermesos.cloud"
    && env.VERCEL_GIT_COMMIT_REF === "canary"
    && env.VERCEL_GIT_REPO_OWNER === "ashneil12"
    && env.VERCEL_GIT_REPO_SLUG === "hivra";
}
