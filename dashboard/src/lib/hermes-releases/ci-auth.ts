import { verifyBearerHeader } from "@/lib/bearer-auth";

/**
 * Machine access to the release registry for the agent fork's CI. It can do one
 * thing: register an image the fork built as a release that nobody is offered
 * yet. Promoting, setting stable, halting and un-halting stay with a signed-in
 * ops admin (`requireOpsAdmin`); nothing here reaches them.
 */

/** Vercel env var holding the shared CI token. Unset (or too short): the route is closed. */
export const CI_TOKEN_ENV = "HERMES_RELEASE_CI_TOKEN";

/** Written to `created_by` and the `registered` release event. */
export const CI_ACTOR = "ci";

/** A shorter secret is treated as not configured, so a weak token cannot be set by mistake. */
export const MIN_CI_TOKEN_LENGTH = 32;

/** Image repositories CI may register. Anything else is refused, whatever the token. */
export const CI_ALLOWED_IMAGE_REPOS: readonly string[] = ["ghcr.io/ashneil12/vanilla-hermes-agent-canary"];

/**
 * An immutable build tag: `<upstream tag>-<7 hex of the commit>`. Rejects the
 * floating tags (`stable`, `latest`, `canary`, a branch name) that would let CI
 * register something that later changes underneath the digest it resolved.
 */
export const CI_IMMUTABLE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]*-[0-9a-f]{7}$/;

/** New releases CI may register per hour, counted from the database so it holds across serverless instances. */
export const CI_MAX_NEW_RELEASES_PER_HOUR = 10;

export type CiAuthResult =
  | { ok: true; actor: typeof CI_ACTOR }
  | { ok: false; status: 401 | 503; message: string };

export function configuredCiToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = env[CI_TOKEN_ENV]?.trim();
  return token && token.length >= MIN_CI_TOKEN_LENGTH ? token : null;
}

/** Constant-time bearer check against the configured CI token. */
export function requireCiToken(
  request: Request,
  env: Record<string, string | undefined> = process.env
): CiAuthResult {
  const token = configuredCiToken(env);
  if (!token) return { ok: false, status: 503, message: "CI release registration is not configured" };
  if (!verifyBearerHeader(request, token)) return { ok: false, status: 401, message: "Unauthorized" };
  return { ok: true, actor: CI_ACTOR };
}

export function isAllowedCiImageRepo(imageRepo: string): boolean {
  return CI_ALLOWED_IMAGE_REPOS.includes(imageRepo.trim().toLowerCase());
}
