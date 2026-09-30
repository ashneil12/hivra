export const SELF_HOST_USER_ID = "hivra-local-operator";
export const SELF_HOST_SESSION_COOKIE = "hivra_operator_session";
export const SELF_HOST_SESSION_ISSUER = "hivra-self-host";
export const SELF_HOST_SESSION_AUDIENCE = "hivra-dashboard";
export const SELF_HOST_SESSION_TTL_SECONDS = 12 * 60 * 60;

export function isLocalAuthMode(): boolean {
  const mode = process.env.HIVRA_AUTH_MODE || process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
  return mode?.trim().toLowerCase() === "local";
}

export function requireLocalAuthMode(): void {
  if (!isLocalAuthMode()) {
    throw new Error("Local operator authentication is disabled for this deployment.");
  }
}

// The Supabase CLI signs its local stack with this published value unless the
// project config sets another one. Older self-host installs stored it as the
// session secret, which let anyone forge an operator session. Refuse it so a
// stale configuration fails closed. scripts/hivra-self-host.mjs replaces it with
// a generated secret on the next start, and a test keeps the two copies equal.
export const PUBLIC_SUPABASE_DEFAULT_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

export function requireLocalJwtSecret(): string {
  const secret = process.env.HIVRA_LOCAL_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("HIVRA_LOCAL_JWT_SECRET must contain at least 32 characters.");
  }
  if (secret === PUBLIC_SUPABASE_DEFAULT_JWT_SECRET) {
    throw new Error(
      "HIVRA_LOCAL_JWT_SECRET is the public Supabase default, so it cannot sign sessions. Run self-host:start again to generate a private one.",
    );
  }
  return secret;
}

export function localOperatorEmail(): string {
  return process.env.HIVRA_OPERATOR_EMAIL?.trim().toLowerCase() || "operator@hivra.local";
}

export function localOperatorName(): string {
  return process.env.HIVRA_OPERATOR_NAME?.trim() || "Operator";
}
